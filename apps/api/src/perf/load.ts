// Load generator: VUS simulated people working against a running API (PERF_URL) over the performance database.
// Each person signs in once, then loops through what their seat does, with think time between steps.
//   requestors (70%)  their list, one of their requests, now and then a new request started in conversation
//   coordinators (12%) the desk, a brief, a request's trail
//   reviewers, committee, finance (13%) the desk, a brief
//   analysts (5%)     a question in Ask
// Reports per-step latency percentiles, throughput and errors as JSON and a markdown table.
//   PERF_URL=http://127.0.0.1:8790 VUS=300 DURATION=60 THINK_MS=1000 npx tsx src/perf/load.ts
import { writeFile } from "node:fs/promises";
import pg from "pg";

const URL_ = process.env.PERF_URL ?? "http://127.0.0.1:8790";
const VUS = Number(process.env.VUS ?? 300);
const DURATION = Number(process.env.DURATION ?? 60) * 1000;
const THINK = Number(process.env.THINK_MS ?? 1000);
const RAMP = Number(process.env.RAMP_S ?? 10) * 1000;
const ADMIN = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres@localhost:5432/fundingenvoy_perf?host=/tmp";
const OUT = process.env.PERF_OUT;

const samples = new Map<string, number[]>();
const errors = new Map<string, { n: number; sample: string }>();
let inFlight = 0;

async function hit(label: string, cookie: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const t = performance.now();
  inFlight++;
  try {
    const r = await fetch(URL_ + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    const ms = performance.now() - t;
    if (r.status >= 400) {
      const e = errors.get(label) ?? { n: 0, sample: `${r.status} ${text.slice(0, 160)}` };
      e.n++; errors.set(label, e);
      return undefined;
    }
    (samples.get(label) ?? samples.set(label, []).get(label)!).push(ms);
    return text ? JSON.parse(text) : undefined;
  } catch (err) {
    const e = errors.get(label) ?? { n: 0, sample: String(err) };
    e.n++; errors.set(label, e);
    return undefined;
  } finally {
    inFlight--;
  }
}

async function login(userId: string): Promise<string> {
  const r = await fetch(`${URL_}/api/auth/demo-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
  if (r.status !== 200) throw new Error(`login ${userId}: ${r.status} ${await r.text()}`);
  const c = r.headers.getSetCookie().find((x) => x.startsWith("fe_session="))!;
  return c.split(";")[0]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const think = () => sleep(THINK * (0.5 + Math.random()));
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

const QUESTIONS = [
  "How much did we pay by country this year?", "What is the approval rate by request type?", "Median days to decision by month",
  "Which rules block most?", "How many requests by stage?", "Amount requested by reviewing group in 2026",
];

async function main() {
  const db = new pg.Client({ connectionString: ADMIN });
  await db.connect();
  const tenant = (await db.query<{ id: string }>("select id from tenants where slug = 'halden'")).rows[0]!.id;
  const staff = (await db.query<{ id: string; roles: string[] }>("select id, roles from users where tenant_id = $1 and kind = 'internal' and active and not ('sales' = any(roles)) and not ('access-admin' = any(roles))", [tenant])).rows;
  const openIds = (await db.query<{ id: string }>("select id from requests where tenant_id = $1 and status not in ('draft','closed','declined','withdrawn') order by random() limit 3000", [tenant])).rows.map((r) => r.id);
  const reqs = (await db.query<{ requestor_id: string; ids: string[] }>(`select requestor_id, array_agg(id) as ids from requests where tenant_id = $1 and status <> 'draft' and requestor_id in (select id from users where email like 'perf.requestor%' order by random() limit ${Math.ceil(VUS * 0.8)}) group by requestor_id`, [tenant])).rows;
  const stats = (await db.query<{ requests: string; events: string; open: string; size: string }>("select (select count(*) from requests) as requests, (select count(*) from events) as events, (select count(*) from requests where status not in ('draft','closed','declined','withdrawn')) as open, pg_size_pretty(pg_database_size(current_database())) as size")).rows[0]!;
  await db.end();
  console.log(`dataset: ${stats.requests} requests (${stats.open} open), ${stats.events} events, ${stats.size}`);

  const roleOf = (r: string) => staff.filter((s) => s.roles.includes(r));
  const seats: { kind: string; userId: string; mine?: string[] }[] = [];
  for (let i = 0; i < VUS; i++) {
    const x = i / VUS;
    if (x < 0.7) { const r = reqs[i % reqs.length]!; seats.push({ kind: "requestor", userId: r.requestor_id, mine: r.ids }); }
    else if (x < 0.82) seats.push({ kind: "coordinator", userId: pick(roleOf("coordinator")).id });
    else if (x < 0.95) seats.push({ kind: "reviewer", userId: pick([...roleOf("medical-reviewer"), ...roleOf("compliance-reviewer"), ...roleOf("committee-chair"), ...roleOf("finance")]).id });
    else seats.push({ kind: "analyst", userId: pick([...roleOf("process-owner"), ...roleOf("compliance-auditor")]).id });
  }

  const end = Date.now() + RAMP + DURATION;
  let measuring = false;
  setTimeout(() => { samples.clear(); errors.clear(); measuring = true; }, RAMP);
  let peak = 0;
  const peakTimer = setInterval(() => { if (measuring) peak = Math.max(peak, inFlight); }, 50);

  const vu = async (s: (typeof seats)[number], idx: number) => {
    await sleep((RAMP * idx) / VUS);
    const cookie = await login(s.userId);
    let n = 0;
    while (Date.now() < end) {
      n++;
      if (s.kind === "requestor") {
        await hit("requestor: my requests", cookie, "GET", "/api/my/requests"); await think();
        await hit("requestor: open a request", cookie, "GET", `/api/requests/${pick(s.mine!)}`); await think();
        if (n % 8 === 0) { await hit("requestor: start a request (write)", cookie, "POST", "/api/requests", { text: "We'd like to request $20,000 for a regional heart failure update for nurses in June 2027." }); await think(); }
      } else if (s.kind === "coordinator") {
        await hit("coordinator: desk", cookie, "GET", "/api/desk"); await think();
        const id = pick(openIds);
        await hit("coordinator: brief", cookie, "GET", `/api/requests/${id}/brief`); await think();
        await hit("coordinator: request trail", cookie, "GET", `/api/requests/${id}/trail`); await think();
      } else if (s.kind === "reviewer") {
        await hit("reviewer: desk", cookie, "GET", "/api/desk"); await think();
        await hit("reviewer: brief", cookie, "GET", `/api/requests/${pick(openIds)}/brief`); await think();
      } else {
        await hit("analyst: ask", cookie, "POST", "/api/ask", { question: pick(QUESTIONS) }); await think(); await think();
      }
    }
  };
  const t0 = Date.now();
  await Promise.all(seats.map((s, i) => vu(s, i)));
  clearInterval(peakTimer);
  const secs = (Date.now() - t0 - RAMP) / 1000;

  const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
  const rows = [...samples.entries()].sort().map(([label, xs]) => {
    xs.sort((a, b) => a - b);
    return { label, n: xs.length, rps: +(xs.length / secs).toFixed(1), p50: +pct(xs, 50).toFixed(0), p95: +pct(xs, 95).toFixed(0), p99: +pct(xs, 99).toFixed(0), max: +xs.at(-1)!.toFixed(0), errors: errors.get(label)?.n ?? 0 };
  });
  const total = rows.reduce((s, r) => s + r.n, 0);
  const errTotal = [...errors.values()].reduce((s, e) => s + e.n, 0);
  const result = { at: new Date().toISOString(), vus: VUS, thinkMs: THINK, seconds: +secs.toFixed(0), dataset: stats, requests: total, rps: +(total / secs).toFixed(1), peakInFlight: peak, errors: errTotal, errorSamples: Object.fromEntries(errors), steps: rows };
  const md = [
    `${VUS} people · think time ${THINK} ms · ${secs.toFixed(0)} s measured · ${total.toLocaleString()} requests (${result.rps}/s) · peak ${peak} in flight · ${errTotal} errors`, "",
    "| Step | Count | Per second | p50 ms | p95 ms | p99 ms | Max ms | Errors |", "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((r) => `| ${r.label} | ${r.n} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.errors} |`),
  ].join("\n");
  console.log(md);
  if (errTotal) console.log("\nerrors:", JSON.stringify(Object.fromEntries(errors), null, 1));
  if (OUT) await writeFile(OUT, JSON.stringify({ ...result, markdown: md }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

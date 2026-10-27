// Load-test data: fills the Halden demo tenant of a separate performance database with a realistic history.
//   - PERF_REQUESTS requests (default 500,000) over 2016 to April 2027, chronologically, with a live pipeline:
//     recent requests are open at the stage their age implies; older ones are closed, declined or withdrawn.
//   - Open requests carry a full state cloned from the scenario's real requests. Closed history carries what the
//     analytics read (decision, flags, information rounds, routing, a few stored checks, agreement signatures).
//   - 20,000 organizations shared with the tenant, 25,000 requestors, a task per open request, a payment per paid
//     request, and about six audit events per request, sealed into the tenant's hash chain so it still verifies.
// Run after migrate + seed + scenario on the performance database (see docs/PERFORMANCE.md).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sealEvent, GENESIS_HASH, type AuditEventInput } from "@fe/core";

const ADMIN = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres@localhost:5432/fundingenvoy_perf?host=/tmp";
const N = Number(process.env.PERF_REQUESTS ?? 500_000);
const ORGS = Number(process.env.PERF_ORGS ?? 20_000);
const REQUESTORS = Number(process.env.PERF_REQUESTORS ?? 25_000);
const START = Date.parse("2016-01-04T09:00:00Z");
const END = Date.parse("2027-04-01T17:00:00Z");
const DAY = 86_400_000;

let seed = 42;
const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
const weighted = <T>(xs: ReadonlyArray<readonly [T, number]>) => { let r = rnd() * xs.reduce((s, x) => s + x[1], 0); for (const [v, w] of xs) if ((r -= w) <= 0) return v; return xs[0]![0]; };

const COUNTRIES = [["US", 60], ["GB", 20], ["FR", 20]] as const;
const CURRENCY: Record<string, string> = { US: "USD", GB: "GBP", FR: "EUR" };
const SUBTYPES = [["ime-accredited", 55], ["ime-non-accredited", 20], ["charitable-contribution", 25]] as const;
const FAMILY: Record<string, string> = { "ime-accredited": "education", "ime-non-accredited": "education", "charitable-contribution": "charitable" };
const SUFFIX: Record<string, string> = { education: "IME", charitable: "CHA" };
const OPEN_STAGES: [string, number, string, string][] = [ // stage, max age in days, status, owner role
  ["completeness", 2, "submitted", "coordinator"], ["triage", 4, "submitted", "coordinator"], ["medical-review", 14, "in-review", "medical-reviewer"],
  ["compliance-review", 21, "in-review", "compliance-reviewer"], ["committee", 35, "committee", "committee-chair"], ["agreement", 50, "agreement", "legal"],
  ["payment", 60, "payment", "finance"], ["reconciliation", 200, "reconciliation", "coordinator"], ["outcomes", 240, "outcomes", "coordinator"],
];
const GROUPS: Record<string, string> = { US: "US medical education", GB: "UK and Ireland", FR: "France" };
const RULES = ["R-07", "R-08", "R-11b", "R-12", "R-14", "R-24", "US-TAX-01", "UK-ABPI-02"];
const WORDS = ["Heart", "Cardiac", "Vascular", "Lipid", "Rhythm", "Valve", "Failure", "Prevention", "Nursing", "Primary Care", "Rural", "Metro", "Coastal", "Northern", "Southern", "Valley"];
const KINDS = [["Society", "association"], ["Foundation", "charity"], ["University", "university"], ["Medical Center", "teaching-hospital"], ["CME LLC", "accredited-provider"], ["Patient Alliance", "patient-organization"]] as const;

async function main() {
  const db = new pg.Client({ connectionString: ADMIN });
  await db.connect();
  const t0 = Date.now();
  const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${m}`);

  const tenant = (await db.query<{ id: string }>("select id from tenants where slug = 'halden'")).rows[0]!.id;
  const staff = (await db.query<{ id: string; name: string; roles: string[] }>("select id, name, roles from users where tenant_id = $1 and kind = 'internal' and active", [tenant])).rows;
  const byRole = (r: string) => staff.filter((s) => s.roles.includes(r));
  const templates = (await db.query<{ state: Record<string, unknown>; versions: unknown; subtype: string }>("select state, versions, subtype from requests where tenant_id = $1 and status not in ('draft') and subtype is not null", [tenant])).rows;
  if (!templates.length) throw new Error("Run the seed and the scenario on this database first: open requests are cloned from the scenario's requests.");
  const versions = JSON.stringify(templates[0]!.versions);
  log(`tenant ${tenant}: ${staff.length} staff, ${templates.length} template requests`);

  // ─── Organizations and requestors ──────────────────────────────────────────────────────────────────────────
  const orgs: { id: string; country: string; name: string }[] = [];
  for (let i = 0; i < ORGS; i++) {
    const country = weighted(COUNTRIES);
    const [noun, type] = pick(KINDS);
    orgs.push({ id: randomUUID(), country, name: `${pick(WORDS)} ${pick(WORDS)} ${noun} ${i + 1}` });
    (orgs[i] as { type?: string }).type = type;
  }
  for (let i = 0; i < orgs.length; i += 5000) {
    const b = orgs.slice(i, i + 5000);
    await db.query("insert into organizations (id, legal_name, type, country) select * from unnest($1::uuid[], $2::text[], $3::text[], $4::char(2)[])",
      [b.map((o) => o.id), b.map((o) => o.name), b.map((o) => (o as { type?: string }).type), b.map((o) => o.country)]);
    await db.query("insert into org_shares (org_id, tenant_id) select unnest($1::uuid[]), $2", [b.map((o) => o.id), tenant]);
  }
  log(`${orgs.length} organizations shared with the tenant`);

  const requestors: { id: string; org: (typeof orgs)[number]; name: string }[] = [];
  for (let i = 0; i < REQUESTORS; i++) requestors.push({ id: randomUUID(), org: orgs[i % orgs.length]!, name: `Requestor ${i + 1}` });
  for (let i = 0; i < requestors.length; i += 5000) {
    const b = requestors.slice(i, i + 5000);
    await db.query("insert into users (id, email, name, kind, org_id, roles, source) select id, email, name, 'requestor', org, '{requestor}', 'seed' from unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[]) as t(id, email, name, org)",
      [b.map((r) => r.id), b.map((_, j) => `perf.requestor${i + j + 1}@load.example`), b.map((r) => r.name), b.map((r) => r.org.id)]);
  }
  log(`${requestors.length} requestors`);

  // ─── Chain head ────────────────────────────────────────────────────────────────────────────────────────────
  const head = (await db.query<{ seq: string; hash: string }>("select seq, hash from event_heads where tenant_id = $1", [tenant])).rows[0];
  let seq = Number(head?.seq ?? 0), prev = head?.hash ?? GENESIS_HASH;
  const lastAt = (await db.query<{ at: Date | null }>("select max(at) as at from events where tenant_id = $1", [tenant])).rows[0]?.at;
  let clock = Math.max(lastAt ? lastAt.getTime() : 0, Date.now()); // history is appended after what is already in the chain

  // ─── Requests, tasks, payments, events ─────────────────────────────────────────────────────────────────────
  const BATCH = 5000;
  const counters: Record<string, number> = {};
  const totals = { open: 0, closed: 0, declined: 0, withdrawn: 0, tasks: 0, payments: 0, events: 0 };
  const now = END;
  for (let start = 0; start < N; start += BATCH) {
    const R: unknown[][] = Array.from({ length: 16 }, () => []);
    const T: unknown[][] = Array.from({ length: 6 }, () => []);
    const P: unknown[][] = Array.from({ length: 7 }, () => []);
    const E: unknown[][] = Array.from({ length: 12 }, () => []);
    for (let i = start; i < Math.min(N, start + BATCH); i++) {
      const submitted = START + ((END - START) * i) / N + rnd() * 3_600_000;
      const age = (now - submitted) / DAY;
      const rq = pick(requestors);
      const country = rq.org.country;
      const subtype = weighted(SUBTYPES);
      const family = FAMILY[subtype]!;
      const amount = family === "charitable" ? Math.round(1000 + rnd() * 24000) : Math.round(5000 + rnd() * 95000);
      const currency = CURRENCY[country]!;
      const year = new Date(submitted).getUTCFullYear();
      counters[year] = (counters[year] ?? 100000) + 1;
      const ref = `${year}-${counters[year]}-${SUFFIX[family]}`;
      const id = randomUUID();
      const open = OPEN_STAGES.find(([, maxAge]) => age <= maxAge);
      const outcome = open ? undefined : weighted([["closed", 87], ["declined", 9], ["withdrawn", 4]] as const);
      const stage = open ? open[0] : outcome === "closed" ? "close-and-disclose" : outcome === "declined" ? "committee" : "medical-review";
      const status = open ? open[2] : outcome!;
      const decided = !open || ["agreement", "payment", "reconciliation", "outcomes"].includes(stage) ? (outcome === "withdrawn" ? null : submitted + (18 + rnd() * 30) * DAY) : null;
      const startDate = new Date(submitted + (50 + rnd() * 90) * DAY).toISOString().slice(0, 10);
      const flagged = rnd() < 0.12;
      const stageEntered = open ? Math.max(submitted, now - rnd() * Math.min(age, 10) * DAY) : decided ?? submitted;
      let state: Record<string, unknown>;
      if (open) {
        const tpl = templates.find((t) => t.subtype === subtype) ?? pick(templates);
        state = { ...tpl.state, id, ref, stage, status, subtype, family, country, organizationId: rq.org.id, requestorId: rq.id, submittedAt: new Date(submitted).toISOString(),
          title: `${rq.org.name.split(" ").slice(0, 2).join(" ")} programme ${ref}`, reviewingGroup: { id: country.toLowerCase(), label: GROUPS[country], rule: "T-3" } };
      } else {
        const decision = outcome === "withdrawn" ? undefined : { outcome: outcome === "declined" ? "decline" : rnd() < 0.3 ? "approve-with-conditions" : "approve", amount, at: new Date(decided!).toISOString() };
        const signed = outcome === "closed" ? new Date(decided! + (rnd() < 0.92 ? 5 : 80) * DAY).toISOString() : undefined;
        state = {
          budget: [], coi: {}, attestations: {}, documents: [], typeConfirmed: true, tenantId: tenant, createdAt: new Date(submitted).toISOString(),
          id, ref, stage, status, subtype, family, country, organizationId: rq.org.id, requestorId: rq.id, submittedAt: new Date(submitted).toISOString(),
          title: `${rq.org.name.split(" ").slice(0, 2).join(" ")} programme ${ref}`,
          fields: { "activity.startDate": { value: startDate }, "amount.requested": { value: amount }, "amount.currency": { value: currency } },
          flags: flagged ? [{ ruleId: pick(RULES), choice: "submit-with-flag" }] : [],
          infoRequests: rnd() < 0.3 ? [{ id: "i1", status: "answered", questions: [{ text: "Please send the final programme.", answer: "Attached." }] }] : [],
          reviewingGroup: { id: country.toLowerCase(), label: GROUPS[country], rule: "T-3" },
          checks: rnd() < 0.25 ? [{ ruleId: pick(RULES), status: "fail", severity: "block" }] : [],
          ...(decision ? { decision } : {}),
          ...(signed ? { agreement: { signatures: [{ side: "requestor", at: signed }, { side: "company", at: signed }] } } : {}),
        };
      }
      R[0]!.push(id); R[1]!.push(ref); R[2]!.push(rq.org.id); R[3]!.push(rq.id); R[4]!.push(family); R[5]!.push(subtype); R[6]!.push(country); R[7]!.push(status); R[8]!.push(stage);
      R[9]!.push(new Date(stageEntered)); R[10]!.push(state.title); R[11]!.push(amount); R[12]!.push(currency); R[13]!.push(JSON.stringify(state)); R[14]!.push(new Date(submitted));
      R[15]!.push(decided ? new Date(decided) : null);
      if (open) totals.open++; else totals[outcome!]++;

      if (open) {
        T[0]!.push(id); T[1]!.push(open[0]); T[2]!.push(`${ref}: ${open[0].replace("-", " ")}`); T[3]!.push(open[3]); T[4]!.push(new Date(stageEntered + 10 * DAY)); T[5]!.push(new Date(stageEntered));
        totals.tasks++;
      }
      const paid = outcome === "closed" || (open && ["reconciliation", "outcomes"].includes(stage));
      if (paid) {
        P[0]!.push(randomUUID()); P[1]!.push(id); P[2]!.push(amount); P[3]!.push(currency); P[4]!.push(new Date(decided! + 20 * DAY)); P[5]!.push(country === "US" ? "6150-IME" : "6150-EU"); P[6]!.push(pick(byRole("finance")).id);
        totals.payments++;
      }

      // Audit events: what the platform would have recorded for this request.
      const requestor = { type: "person" as const, id: rq.id, name: rq.name, roles: ["requestor" as const] };
      const person = (role: string) => { const p = pick(byRole(role).length ? byRole(role) : staff); return { type: "person" as const, id: p.id, name: p.name, roles: p.roles as never }; };
      const agent = { type: "agent" as const, id: "fundingenvoy", name: "FundingEnvoy" };
      const ent = { type: "request", id };
      const evs: AuditEventInput[] = [
        { tenantId: tenant, actor: requestor, entity: ent, action: "request.started", data: { requestId: id } },
        { tenantId: tenant, actor: agent, entity: ent, action: "assistant.extracted", data: { requestId: id, fields: 14 } },
        { tenantId: tenant, actor: requestor, entity: ent, action: "request.submitted", data: { requestId: id, ref } },
        { tenantId: tenant, actor: person("coordinator"), entity: ent, action: "workflow.transitioned", data: { requestId: id, to: "medical-review" } },
      ];
      if (decided) evs.push({ tenantId: tenant, actor: person("committee-chair"), entity: ent, action: "decision.recorded", data: { requestId: id, outcome: (state.decision as { outcome?: string } | undefined)?.outcome ?? "approve" } });
      if (paid) evs.push({ tenantId: tenant, actor: person("finance"), entity: ent, action: "payment.released", data: { requestId: id, amount, currency } });
      for (const ev of evs) {
        clock += 1 + Math.floor(rnd() * 3);
        const s = sealEvent(ev, ++seq, randomUUID(), new Date(clock).toISOString(), prev);
        prev = s.hash;
        E[0]!.push(s.seq); E[1]!.push(s.id); E[2]!.push(s.at); E[3]!.push(JSON.stringify(s.actor)); E[4]!.push(s.entity.type); E[5]!.push(s.entity.id); E[6]!.push(s.action);
        E[7]!.push(JSON.stringify(s.data)); E[8]!.push(s.prevHash); E[9]!.push(s.hash);
        totals.events++;
      }
    }
    await db.query("begin");
    await db.query(`insert into requests (id, tenant_id, ref, org_id, requestor_id, family, subtype, country, status, stage, stage_entered_at, title, amount, currency, state, versions, submitted_at, decided_at, created_at, updated_at)
      select id, $17, ref, org, rq, fam, sub, c, st, stg, entered, title, amt, cur, state, $18::jsonb, sub_at, dec_at, sub_at, greatest(entered, sub_at)
      from unnest($1::uuid[], $2::text[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::char(2)[], $8::text[], $9::text[], $10::timestamptz[], $11::text[], $12::numeric[], $13::char(3)[], $14::jsonb[], $15::timestamptz[], $16::timestamptz[])
        as t(id, ref, org, rq, fam, sub, c, st, stg, entered, title, amt, cur, state, sub_at, dec_at)`, [...R, tenant, versions]);
    if (T[0]!.length) await db.query("insert into tasks (tenant_id, request_id, kind, title, assignee_role, due_at, created_at) select $7, * from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[])", [...T, tenant]);
    if (P[0]!.length) await db.query(`insert into payments (id, tenant_id, request_id, milestone, label, amount, currency, status, paid_at, released_at, gl_account, released_by)
      select id, $8, rq, 1, 'Single payment', amt, cur, 'paid', paid, paid, gl, rel from unnest($1::uuid[], $2::uuid[], $3::numeric[], $4::char(3)[], $5::timestamptz[], $6::text[], $7::uuid[]) as t(id, rq, amt, cur, paid, gl, rel)`, [...P, tenant]);
    await db.query(`insert into events (tenant_id, seq, id, at, actor, entity_type, entity_id, action, data, prev_hash, hash)
      select $11, * from unnest($1::bigint[], $2::uuid[], $3::timestamptz[], $4::jsonb[], $5::text[], $6::text[], $7::text[], $8::jsonb[], $9::text[], $10::text[])`, [...E.slice(0, 10), tenant]);
    await db.query("insert into event_heads (tenant_id, seq, hash) values ($1, $2, $3) on conflict (tenant_id) do update set seq = excluded.seq, hash = excluded.hash", [tenant, seq, prev]);
    await db.query("commit");
    if ((start / BATCH) % 10 === 9 || start + BATCH >= N) log(`${Math.min(N, start + BATCH).toLocaleString()} requests`);
  }
  log("analyze");
  await db.query("analyze");
  const size = (await db.query<{ s: string }>("select pg_size_pretty(pg_database_size(current_database())) as s")).rows[0]!.s;
  log(`done: ${JSON.stringify(totals)} · database ${size}`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

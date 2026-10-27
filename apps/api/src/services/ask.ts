// Ask: natural-language analytics over a governed metrics library.
// A question becomes a plan (metric, grouping, filters, period) chosen from the library; this module writes
// the SQL from whitelisted fragments and runs it under the asker's row-level security. No model writes SQL.
import { many } from "@fe/db";
import { asUser, HttpError, type SessionUser } from "../auth.ts";
import { record, today } from "./requests.ts";
import { provider } from "./assistant.ts";

export interface Metric { id: string; label: string; definition: string; unit: "count" | "money" | "days" | "ratio" | "percent"; synonyms: string[]; sql: string; base: "requests" | "payments" | "events" }
export interface Dimension { id: string; label: string; synonyms: string[]; sql: string }

export const METRICS: Metric[] = [
  { id: "requests", label: "Requests submitted", definition: "Requests submitted in the period (drafts excluded).", unit: "count", synonyms: ["requests", "how many", "number of requests", "submissions", "volume"], sql: "count(*)", base: "requests" },
  { id: "amount_requested", label: "Amount requested", definition: "Sum of the requested amount on submitted requests, in request currency.", unit: "money", synonyms: ["amount requested", "requested", "asked for", "funding requested", "spend requested"], sql: "coalesce(sum(r.amount), 0)", base: "requests" },
  { id: "amount_paid", label: "Amount paid", definition: "Sum of payments marked paid in the period.", unit: "money", synonyms: ["spend", "paid", "pay", "amount paid", "payments", "money out", "funding paid", "paid out"], sql: "coalesce(sum(p.amount), 0)", base: "payments" },
  { id: "time_to_decision", label: "Median days to decision", definition: "Median calendar days from submission to the committee decision, for requests decided in the period.", unit: "days", synonyms: ["time to decision", "days to decision", "how long", "decision time", "turnaround", "cycle time"], sql: "round((percentile_cont(0.5) within group (order by extract(epoch from r.decided_at - r.submitted_at) / 86400))::numeric, 1)", base: "requests" },
  { id: "info_rounds", label: "Information rounds per request", definition: "Information requests sent ÷ requests submitted, both in the period.", unit: "ratio", synonyms: ["information rounds", "info requests", "information requests", "rounds", "follow up", "follow-up", "back and forth", "questions to requestors"], sql: "round(coalesce(sum(r.info_rounds), 0)::numeric / nullif(count(*), 0), 2)", base: "requests" },
  { id: "approval_rate", label: "Approval rate", definition: "Requests approved (with or without conditions) ÷ requests decided, in the period.", unit: "percent", synonyms: ["approval rate", "approved", "success rate", "how many approved", "decline rate", "declined"], sql: "round(100.0 * count(*) filter (where r.decision_outcome in ('approve','approve-with-conditions')) / nullif(count(*) filter (where r.decided_at is not null), 0), 1)", base: "requests" },
  { id: "agreements_before_start", label: "Agreements executed before activity start", definition: "Of requests with a signed agreement, the share whose last signature precedes the activity start date (SOP 7.1, ACCME 4.2).", unit: "percent", synonyms: ["agreement before", "executed before", "signed before", "agreements on time", "late agreements"], sql: "round(100.0 * count(*) filter (where (select max((s->>'at')::timestamptz) from jsonb_array_elements(r.state->'agreement'->'signatures') s) < (r.state->'fields'->'activity.startDate'->>'value')::timestamptz) / nullif(count(*) filter (where jsonb_array_length(coalesce(r.state->'agreement'->'signatures','[]'::jsonb)) >= 2), 0), 1)", base: "requests" },
  { id: "flags", label: "Requests submitted with a flag", definition: "Requests the requestor chose to submit with at least one flag for the reviewer.", unit: "count", synonyms: ["flags", "flagged", "submitted with a flag", "exceptions", "late requests"], sql: "count(*) filter (where r.flag_count > 0)", base: "requests" },
  { id: "blocking_rules", label: "Requests failing a rule at submission", definition: "Requests whose stored checks include the rule in fail or pending at submission; group by rule to see which rules block most.", unit: "count", synonyms: ["which rules", "rules block", "blocking", "blocked", "what blocks", "most common gap", "gaps"], sql: "count(*)", base: "requests" },
];

export const DIMENSIONS: Dimension[] = [
  { id: "type", label: "Request type", synonyms: ["type", "request type", "subtype", "kind", "category"], sql: "coalesce(r.subtype, 'unclassified')" },
  { id: "country", label: "Country", synonyms: ["country", "countries", "where", "geography", "region"], sql: "r.country" },
  { id: "stage", label: "Stage", synonyms: ["stage", "step", "where they are", "status"], sql: "r.stage" },
  { id: "organization", label: "Organization", synonyms: ["organization", "organisation", "requestor", "recipient", "who"], sql: "o.legal_name" },
  { id: "month", label: "Month", synonyms: ["month", "monthly", "per month", "over time", "trend"], sql: "to_char(coalesce(r.submitted_at, r.created_at), 'YYYY-MM')" },
  { id: "group", label: "Reviewing group", synonyms: ["reviewing group", "team", "group", "triage group"], sql: "coalesce(r.group_label, 'not routed')" },
  { id: "rule", label: "Rule", synonyms: ["rule", "rules", "check"], sql: "c.rule" },
];

export interface QueryPlan { metric: string; groupBy: string[]; filters: { dimension: string; value: string }[]; period?: { from: string; to: string; label: string } }

function quarter(q: number, y: number) {
  const m = (q - 1) * 3;
  return { from: `${y}-${String(m + 1).padStart(2, "0")}-01`, to: new Date(Date.UTC(y, m + 3, 1)).toISOString().slice(0, 10), label: `Q${q} ${y}` };
}

/** Questions without a period cover the last twelve months; the answer says so, and "all time" or a year widens it. */
export function lastTwelveMonths(now: Date): NonNullable<QueryPlan["period"]> {
  const to = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().slice(0, 10);
  return { from, to, label: "last 12 months" };
}

/** Deterministic planner used by the demo provider; Claude plans into the same shape. */
export function planQuestion(q: string, now = new Date()): QueryPlan | undefined {
  const t = q.toLowerCase();
  const metric = [...METRICS].sort((a, b) => Math.max(...b.synonyms.map((s) => (t.includes(s) ? s.length : 0))) - Math.max(...a.synonyms.map((s) => (t.includes(s) ? s.length : 0))))
    .find((m) => m.synonyms.some((s) => t.includes(s)));
  if (!metric) return undefined;
  const groupBy: string[] = [];
  for (const d of DIMENSIONS) {
    if (d.synonyms.some((s) => new RegExp(`\\b(by|per|in which|which|each|across|and)\\s+(${s})\\b`).test(t) || new RegExp(`\\bby\\s+${s}\\b`).test(t))) groupBy.push(d.id);
  }
  if (metric.id === "blocking_rules" && !groupBy.includes("rule")) groupBy.unshift("rule");
  const filters: QueryPlan["filters"] = [];
  const countries: Record<string, string> = { "united states": "US", " us ": "US", usa: "US", "united kingdom": "GB", " uk ": "GB", britain: "GB", france: "FR", french: "FR" };
  for (const [k, v] of Object.entries(countries)) if (` ${t} `.includes(k) && !groupBy.includes("country")) { filters.push({ dimension: "country", value: v }); break; }
  if (/\bcharit/.test(t) && !groupBy.includes("type")) filters.push({ dimension: "type", value: "charitable-contribution" });
  else if (/non-accredited/.test(t) && !groupBy.includes("type")) filters.push({ dimension: "type", value: "ime-non-accredited" });
  else if (/\baccredited\b/.test(t) && !groupBy.includes("type")) filters.push({ dimension: "type", value: "ime-accredited" });
  const y = now.getUTCFullYear();
  let period: QueryPlan["period"];
  const qm = /\bq([1-4])(?:\s+(\d{4}))?\b/.exec(t);
  if (qm) period = quarter(Number(qm[1]), qm[2] ? Number(qm[2]) : y);
  else if (/this year|year to date|ytd/.test(t)) period = { from: `${y}-01-01`, to: `${y + 1}-01-01`, label: `${y} to date` };
  else if (/last year/.test(t)) period = { from: `${y - 1}-01-01`, to: `${y}-01-01`, label: String(y - 1) };
  else if (/last quarter/.test(t)) { const cq = Math.floor(now.getUTCMonth() / 3) + 1; period = cq === 1 ? quarter(4, y - 1) : quarter(cq - 1, y); }
  else if (/last (30 days|month)/.test(t)) period = { from: new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10), to: new Date(now.getTime() + 86400000).toISOString().slice(0, 10), label: "last 30 days" };
  else if (/\b(in|for|during)\s+(20\d\d)\b/.test(t)) { const yy = Number(/\b(?:in|for|during)\s+(20\d\d)\b/.exec(t)![1]); period = { from: `${yy}-01-01`, to: `${yy + 1}-01-01`, label: String(yy) }; }
  else if (!/\b(all time|ever|since (the )?(start|beginning))\b/.test(t)) period = lastTwelveMonths(now);
  return { metric: metric.id, groupBy: groupBy.slice(0, 2), filters, period };
}

const FILTER_SQL: Record<string, string> = { country: "r.country", type: "r.subtype", stage: "r.stage", group: "r.group_label" };

export function buildSql(plan: QueryPlan, tenantParam = "$1"): { sql: string; params: unknown[] } {
  const metric = METRICS.find((m) => m.id === plan.metric);
  if (!metric) throw new HttpError(400, "Unknown metric.");
  const dims = plan.groupBy.map((g) => DIMENSIONS.find((d) => d.id === g)).filter((d): d is Dimension => Boolean(d));
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length + 1}`; };
  const where = [`r.tenant_id = ${tenantParam}`, "r.status <> 'draft'"];
  const dateCol = metric.base === "payments" ? "p.paid_at" : metric.id === "time_to_decision" || metric.id === "approval_rate" ? "r.decided_at" : "r.submitted_at";
  // Bounds are timestamps, not dates: under row-level security only leakproof operators can use an index, and
  // timestamptz-to-date comparison is not one.
  if (plan.period) where.push(`${dateCol} >= ${p(`${plan.period.from}T00:00:00Z`)}::timestamptz`, `${dateCol} < ${p(`${plan.period.to}T00:00:00Z`)}::timestamptz`);
  for (const f of plan.filters) if (FILTER_SQL[f.dimension]) where.push(`${FILTER_SQL[f.dimension]} = ${p(f.value)}`);
  if (metric.base === "payments") where.push("p.status = 'paid'");
  if (metric.id === "time_to_decision") where.push("r.decided_at is not null and r.submitted_at is not null");
  const from = [
    dims.some((d) => d.id === "organization") ? "requests r join organizations o on o.id = r.org_id" : "requests r",
    metric.base === "payments" ? "join payments p on p.request_id = r.id" : "",
    dims.some((d) => d.id === "rule") || metric.id === "blocking_rules" ? "cross join lateral unnest(r.blocking_rules) as c(rule)" : "",
  ].filter(Boolean).join(" ");
  const sel = dims.map((d, i) => `${d.sql} as d${i}`);
  // Money is never added across currencies: amounts are grouped by currency and reported as they are.
  const money = metric.unit === "money";
  if (money) sel.push(`${metric.base === "payments" ? "p.currency" : "r.currency"} as cur`);
  const groups = [...dims.map((_, i) => `d${i}`), ...(money ? ["cur"] : [])];
  const sql = `select ${[...sel, `${metric.sql} as value`].join(", ")} from ${from} where ${where.join(" and ")}${groups.length ? ` group by ${groups.join(", ")} order by value desc nulls last limit 50` : ""}`;
  return { sql, params };
}

const SYMBOL: Record<string, string> = { USD: "$", GBP: "£", EUR: "€" };
function fmt(v: unknown, unit: Metric["unit"], currency?: unknown): string {
  if (v === null || v === undefined) return "no data";
  const n = Number(v);
  if (unit === "money") { const c = String(currency ?? "USD"); return `${SYMBOL[c] ?? `${c} `}${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`; }
  if (unit === "percent") return `${n}%`;
  if (unit === "days") return `${n} days`;
  return String(n % 1 === 0 ? n : n.toFixed(2));
}

// Analytics share the database with everyday work. At most four questions run at once; the rest wait their turn.
let running = 0;
const waiting: (() => void)[] = [];
async function analytics<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= Number(process.env.FE_ANALYTICS_CONCURRENCY ?? 4)) await new Promise<void>((r) => waiting.push(r)); // a finishing question hands over its slot
  else running++;
  try { return await fn(); } finally { const next = waiting.shift(); if (next) next(); else running--; }
}

export async function ask(u: SessionUser, question: string) {
  const p = await provider();
  const plan: QueryPlan | undefined = p.planQuery ? await p.planQuery(question, METRICS, DIMENSIONS, today()) : planQuestion(question, new Date(`${today()}T12:00:00Z`));
  if (!plan) {
    return { answer: "I can't answer that from the metrics library yet. Try one of these, or ask the process owner to add a metric.", suggestions: METRICS.slice(0, 6).map((m) => m.label), plan: undefined };
  }
  const metric = METRICS.find((m) => m.id === plan.metric)!;
  const { sql, params } = buildSql(plan);
  const rows = await analytics(() => asUser(u, async (tx) => {
    await tx.query("set local statement_timeout = '15s'");
    return many<Record<string, unknown>>(tx, sql, [u.tenantId, ...params]);
  }));
  const dims = plan.groupBy.map((g) => DIMENSIONS.find((d) => d.id === g)!);
  const money = metric.unit === "money";
  const perCurrency = money && new Set(rows.map((r) => r.cur)).size > 1 ? " Amounts are per currency and are not converted." : "";
  let answer: string;
  if (!rows.length) answer = `No ${metric.label.toLowerCase()} to report${plan.period ? ` for ${plan.period.label}` : ""}.`;
  else if (!dims.length) answer = `${metric.label}${plan.period ? ` (${plan.period.label})` : ""}${plan.filters.length ? `, ${plan.filters.map((f) => `${f.dimension} ${f.value}`).join(", ")}` : ""}: ${rows.map((r) => fmt(r.value, metric.unit, r.cur)).join(" · ")}.`;
  else {
    const top = rows[0]!;
    answer = `${metric.label}${plan.period ? ` (${plan.period.label})` : ""} is highest for ${dims.map((d, i) => `${d.label.toLowerCase()} ${String(top[`d${i}`])}`).join(", ")}: ${fmt(top.value, metric.unit, top.cur)}${rows.length > 1 ? `, out of ${rows.length} groups` : ""}.${perCurrency}`;
  }
  const excluded = u.attributes.countries ? `Your access is limited to ${String(u.attributes.countries)}.` : undefined;
  await asUser(u, (tx) => record(tx, { tenantId: u.tenantId!, actor: { type: "person", id: u.id, name: u.name, roles: u.roles }, entity: { type: "analytics", id: metric.id }, action: "analytics.asked", data: { question: question.slice(0, 500), plan, sql, rows: rows.length } }));
  return {
    answer, plan,
    metric: { id: metric.id, label: metric.label, definition: metric.definition, unit: metric.unit },
    columns: [...dims.map((d) => d.label), ...(money ? ["Currency"] : []), metric.label],
    rows: rows.map((r) => [...dims.map((_, i) => r[`d${i}`]), ...(money ? [r.cur] : []), r.value]),
    how: { measure: metric.definition, period: plan.period?.label ?? "All time", groupedBy: dims.map((d) => d.label), filters: plan.filters, access: excluded ?? "All requests in this tenant that your role may see.", sql, planner: p.name === "claude" ? "Claude, constrained to the metrics library" : "Keyword planner (demo)" },
  };
}

export function library() {
  return { metrics: METRICS.map(({ sql: _s, ...m }) => m), dimensions: DIMENSIONS.map(({ sql: _s, ...d }) => d) };
}

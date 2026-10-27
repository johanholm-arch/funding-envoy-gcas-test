import type { ActionHint, CheckResult, CheckSpec, CheckStatus, Evidence, Rule, Severity } from "../types.ts";
import { evaluate, type Facts } from "../conditions.ts";
import { buildFacts, budgetTotal, resolveRef, type EvalContext, type EvalDocument } from "../facts.ts";
import { daysBetween, formatDate, monthsBetween, toDate } from "../dates.ts";
import { formatMoney, formatPct, toNumber } from "../money.ts";

export type Phase = "draft" | "submit" | "review" | "pre-payment";

interface Outcome {
  status: CheckStatus;
  vars?: Record<string, unknown>;
  evidence?: Evidence[];
  detail?: string; // appended to the message when useful
}

type CheckFn<K extends CheckSpec["kind"]> = (spec: Extract<CheckSpec, { kind: K }>, ctx: EvalContext, facts: Facts) => Outcome;

const missing = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function param(v: number | string, facts: Facts): number | undefined {
  if (typeof v === "number") return v;
  return toNumber(v.startsWith("param.") ? facts[v] : resolveRef(v, facts));
}

function docsOfType(ctx: EvalContext, type: string): EvalDocument[] {
  return ctx.documents.filter((d) => d.type === type);
}

const CHECKS: { [K in CheckSpec["kind"]]: CheckFn<K> } = {
  fieldsPresent(spec, _ctx, facts) {
    const absent = spec.fields.filter((k) => missing(resolveRef(k, facts)));
    return absent.length
      ? { status: "fail", vars: { missing: absent.join(", ") }, evidence: absent.map((k) => ({ label: "Missing", value: k })) }
      : { status: "pass" };
  },

  documentsPresent(spec, ctx) {
    const evidence: Evidence[] = [];
    const absent: string[] = [];
    const stale: string[] = [];
    for (const t of spec.types) {
      const ds = docsOfType(ctx, t);
      if (!ds.length) { absent.push(t); continue; }
      const d = ds[ds.length - 1]!;
      evidence.push({ label: t, value: d.name });
      if (spec.maxAgeMonths && d.dated) {
        const age = monthsBetween(toDate(d.dated)!, toDate(ctx.today)!);
        if (age > spec.maxAgeMonths) stale.push(`${t} (${age} months old)`);
      }
    }
    if (absent.length) return { status: "fail", vars: { missing: absent.join(", ") }, evidence };
    if (stale.length) return { status: "judge", vars: { stale: stale.join(", ") }, evidence, detail: `Older than ${spec.maxAgeMonths} months: ${stale.join(", ")}.` };
    return { status: "pass", evidence };
  },

  attestationsComplete(spec, ctx, facts) {
    const required = spec.ids ?? requiredAttestations(ctx, facts);
    const absent = required.filter((id) => !ctx.request.attestations[id]);
    const evidence = required.filter((id) => ctx.request.attestations[id]).map((id) => {
      const a = ctx.request.attestations[id]!;
      return { label: id, value: `${a.by.name} · ${a.at.slice(0, 16).replace("T", " ")}` };
    });
    return absent.length ? { status: "fail", vars: { missing: absent.join(", "), done: required.length - absent.length, total: required.length }, evidence }
      : { status: "pass", vars: { done: required.length, total: required.length }, evidence };
  },

  coiComplete(_spec, ctx) {
    const qs = ctx.subtype?.coi ?? [];
    const answered = qs.filter((q) => ctx.request.coi[q]);
    const vars = { answered: answered.length, total: qs.length, left: qs.length - answered.length };
    return answered.length === qs.length ? { status: "pass", vars } : { status: "fail", vars };
  },

  coiAllNo(_spec, ctx) {
    const qs = ctx.subtype?.coi ?? [];
    const yes = Object.values(ctx.request.coi).filter((a) => a.answer === "yes");
    if (yes.length) return { status: "fail", vars: { yes: yes.length }, evidence: yes.map((a) => ({ label: a.questionId, value: a.detail ?? "yes" })) };
    if (qs.some((q) => !ctx.request.coi[q])) return { status: "pending" };
    return { status: "pass" };
  },

  leadTime(spec, ctx, facts) {
    const date = toDate(resolveRef(spec.dateField, facts));
    const min = param(spec.minDays, facts);
    if (!date || min === undefined) return { status: "pending" };
    const from = spec.from === "submittedAt" && ctx.request.submittedAt ? toDate(ctx.request.submittedAt)! : toDate(ctx.today)!;
    const days = daysBetween(from, date);
    return { status: days >= min ? "pass" : "fail", vars: { days, min, date: formatDate(date) }, evidence: [{ label: "Activity starts", value: `${formatDate(date)} · ${days} days away` }] };
  },

  ratioMax(spec, ctx, facts) {
    const nums = spec.numerator.map((k) => toNumber(resolveRef(k, facts)));
    const den = toNumber(resolveRef(spec.denominator, facts));
    const max = param(spec.max, facts);
    if (nums.some((n) => n === undefined) || !den || max === undefined) return { status: "pending" };
    const open = spec.includeOpenRequests ? ctx.openRequestsAmount ?? 0 : 0;
    const total = (nums as number[]).reduce((a, b) => a + b, 0) + open;
    const ratio = total / den;
    const cur = (facts.currency as string) ?? "USD";
    return {
      status: ratio <= max + 1e-9 ? "pass" : "fail",
      vars: { ratio: formatPct(ratio), max: formatPct(max, 0), total: formatMoney(total, cur), denominator: formatMoney(den, cur, { compact: true }), open: formatMoney(open, cur), amount: formatMoney(nums[0], cur) },
      evidence: [{ label: "Computation", value: `(${formatMoney(total - open, cur)} + ${formatMoney(open, cur)} open) ÷ ${formatMoney(den, cur)} = ${formatPct(ratio)}` }],
    };
  },

  equalsWithin(spec, _ctx, facts) {
    const a = toNumber(resolveRef(spec.a, facts));
    const b = toNumber(resolveRef(spec.b, facts));
    if (a === undefined || b === undefined) return { status: "pending" };
    const diff = Math.abs(a - b);
    const cur = (facts.currency as string) ?? "USD";
    return { status: diff <= (spec.tolerance ?? 0) + 1e-9 ? "pass" : "fail", vars: { a: formatMoney(a, cur), b: formatMoney(b, cur), diff: formatMoney(diff, cur) } };
  },

  budgetLines(spec, ctx) {
    const lines = ctx.request.budget;
    if (!lines.length) return { status: "pending" };
    const blocked = lines.filter((l) => spec.blockCategories.includes(l.category));
    const kw = spec.keywords ?? {};
    const judged = lines.filter((l) => !blocked.includes(l) && ((spec.judgeCategories ?? []).includes(l.category)
      || Object.values(kw).flat().some((k) => l.description.toLowerCase().includes(k.toLowerCase()))));
    const total = budgetTotal(ctx.request);
    const overhead = lines.filter((l) => l.category === "management-fee").reduce((s, l) => s + l.amount, 0);
    const overPct = spec.maxOverheadPct !== undefined && total > 0 && overhead / total > spec.maxOverheadPct;
    const describe = (l: (typeof lines)[number]) => `Line ${l.line} "${l.description}", ${formatMoney(l.amount)}`;
    const evidence = [...blocked, ...judged].map((l) => ({ label: `Line ${l.line}`, value: `${l.description} · ${l.category} · ${formatMoney(l.amount)}`, source: l.source }));
    if (blocked.length || overPct) return { status: "fail", vars: { lines: blocked.map(describe).join("; "), overhead: formatPct(overhead / (total || 1)) }, evidence };
    if (judged.length) return { status: "judge", vars: { lines: judged.map(describe).join("; "), line: judged[0]!.line, description: judged[0]!.description, lineAmount: formatMoney(judged[0]!.amount) }, evidence };
    return { status: "pass", vars: { count: lines.length } };
  },

  screeningClear(spec, ctx) {
    const res = spec.lists.map((l) => ctx.organization.screening.filter((s) => s.list === l).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0]);
    const evidence = res.filter(Boolean).map((s) => ({ label: s!.list, value: `${s!.result} · ${s!.listVersion} · ${s!.checkedAt.slice(0, 10)}` }));
    if (res.some((s) => !s)) return { status: "pending", evidence, vars: { lists: spec.lists.join(", ") } };
    if (res.some((s) => s!.result === "match" && s!.adjudication?.outcome !== "false-positive")) return { status: "fail", evidence };
    if (res.some((s) => s!.result === "possible-match" && !s!.adjudication)) return { status: "judge", evidence };
    if (spec.maxAgeDays && res.some((s) => daysBetween(toDate(s!.checkedAt)!, toDate(ctx.today)!) > spec.maxAgeDays!)) return { status: "pending", evidence, detail: "Screening is out of date and will be re-run." };
    return { status: "pass", evidence, vars: { lists: spec.lists.join(", "), date: formatDate(res[0]!.checkedAt) } };
  },

  recipientIsOrganization(_spec, ctx) {
    return ctx.organization.type === "individual" ? { status: "fail" } : { status: "pass", vars: { orgType: ctx.organization.type } };
  },

  datesConsistent(spec, _ctx, facts) {
    const vals = spec.fields.map((k) => resolveRef(k, facts)).filter((v) => !missing(v)).map((v) => String(v).slice(0, 10));
    if (vals.length < 2) return { status: "pending" };
    return new Set(vals).size === 1 ? { status: "pass", vars: { date: formatDate(vals[0]) } } : { status: "fail", vars: { values: [...new Set(vals)].map(formatDate).join(" vs ") } };
  },

  documentQuote(spec, ctx) {
    const ds = docsOfType(ctx, spec.documentType);
    if (!ds.length || ds.every((d) => !d.pagesText?.length)) return { status: "pending" };
    for (const d of ds) {
      for (const [i, text] of (d.pagesText ?? []).entries()) {
        const lower = text.toLowerCase();
        const bad = (spec.mustNotContainAny ?? []).find((p) => lower.includes(p.toLowerCase()));
        if (bad) return { status: "fail", evidence: [{ label: "Found", value: sentenceAround(text, bad), source: { kind: "document", documentId: d.id, documentName: d.name, page: i + 1, quote: sentenceAround(text, bad) } }] };
      }
    }
    for (const d of ds) {
      for (const [i, text] of (d.pagesText ?? []).entries()) {
        const hit = spec.mustContainAny.find((p) => text.toLowerCase().includes(p.toLowerCase()));
        if (hit) {
          const quote = sentenceAround(text, hit);
          return { status: "pass", vars: { quote, page: i + 1 }, evidence: [{ label: `${d.name} p.${i + 1}`, value: quote, source: { kind: "document", documentId: d.id, documentName: d.name, page: i + 1, quote } }] };
        }
      }
    }
    return { status: "judge" };
  },

  predicate(spec, _ctx, facts) {
    return { status: evaluate(spec.condition, facts) ? "pass" : "fail" };
  },

  priorApproval(spec, _ctx, facts) {
    const rec = resolveRef(spec.recordField, facts);
    if (missing(rec)) return { status: "fail", vars: { authority: spec.authority } };
    if (spec.leadDays) {
      const filed = toDate(resolveRef(`${spec.recordField}Date`, facts));
      const start = toDate(resolveRef("activity.startDate", facts));
      if (filed && start && daysBetween(filed, start) < spec.leadDays) {
        return { status: "fail", vars: { authority: spec.authority, record: String(rec) }, detail: `Filed ${daysBetween(filed, start)} days before the activity; ${spec.leadDays} required.` };
      }
    }
    return { status: "pass", vars: { authority: spec.authority, record: String(rec) }, evidence: [{ label: spec.authority, value: String(rec) }] };
  },

  teachingHospitalMatch(_spec, ctx) {
    const ids = new Set(ctx.teachingHospitalIds ?? []);
    const hit = ctx.organization.type === "teaching-hospital" || Object.values(ctx.organization.identifiers).some((v) => ids.has(v));
    return hit ? { status: "judge", detail: "On the CMS teaching hospital list: a grant paid to it is directly reportable." } : { status: "pass" };
  },

  productNameAbsent(spec, ctx, facts) {
    const names = ctx.productNames ?? [];
    for (const k of spec.fields) {
      const v = String(resolveRef(k, facts) ?? "");
      const hit = names.find((n) => v.toLowerCase().includes(n.toLowerCase()));
      if (hit) return { status: "fail", vars: { product: hit, field: k }, evidence: [{ label: k, value: v }] };
    }
    return { status: "pass" };
  },

  agreementBeforeStart(_spec, ctx, facts) {
    const start = toDate(resolveRef("activity.startDate", facts));
    const ag = ctx.agreement;
    if (!ag || !start) return { status: "pending" };
    if (!ag.signatures.length) return { status: "pending" };
    const late = ag.signatures.filter((s) => toDate(s.at)! >= start);
    const evidence = ag.signatures.map((s) => ({ label: s.party, value: `${s.name} · ${formatDate(s.at)}` }));
    return late.length ? { status: "fail", evidence } : { status: "pass", evidence, vars: { start: formatDate(start) } };
  },

  amountMax(spec, _ctx, facts) {
    const v = toNumber(resolveRef(spec.field, facts));
    const max = param(spec.max, facts);
    if (v === undefined || max === undefined) return { status: "pending" };
    return { status: v <= max ? "pass" : "fail", vars: { value: formatMoney(v, spec.currency), max: formatMoney(max, spec.currency) } };
  },
};

function sentenceAround(text: string, phrase: string): string {
  const i = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (i < 0) return phrase;
  const lineStart = text.lastIndexOf("\n", i) + 1;
  let lineEnd = text.indexOf("\n", i);
  if (lineEnd < 0) lineEnd = text.length;
  return text.slice(lineStart, lineEnd).trim().slice(0, 300);
}

export function requiredAttestations(ctx: EvalContext, facts: Facts): string[] {
  const ids = ctx.subtype?.attestations ?? [];
  return ids.filter((id) => {
    const def = ctx.catalogue.attestations.find((a) => a.id === id);
    return !def?.requiredWhen || evaluate(def.requiredWhen, facts);
  });
}

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

export interface EvaluateOptions {
  phase?: Phase;
  disabled?: string[];
  includeOutOfScope?: boolean;
}

export function evaluateRule(rule: Rule, ctx: EvalContext, facts: Facts): CheckResult {
  const fn = CHECKS[rule.check.kind] as CheckFn<CheckSpec["kind"]>;
  let out: Outcome;
  try {
    out = fn(rule.check as never, ctx, facts);
  } catch (e) {
    out = { status: "pending", detail: `Check could not run: ${(e as Error).message}` };
  }
  const vars: Record<string, unknown> = { ...flatFacts(facts), ...(ctx.parameters ?? {}), ...(out.vars ?? {}) };
  const tpl = out.status === "pass" ? rule.messages.pass : out.status === "judge" ? rule.messages.judge ?? rule.messages.fail : rule.messages.fail;
  let message = render(tpl, vars);
  if (out.detail && out.status !== "pass") message = `${message} ${out.detail}`.trim();
  if (out.status === "pending") message = `${rule.statement}: waiting for information. ${out.detail ?? ""}`.trim();
  return {
    ruleId: rule.id,
    statement: rule.statement,
    status: out.status,
    severity: rule.severity,
    message,
    requestorMessage: rule.messages.requestor ? render(rule.messages.requestor, vars) : undefined,
    basis: rule.basis,
    evidence: out.evidence ?? [],
    actions: out.status === "pass" ? [] : (rule.actions ?? []),
    computed: out.vars,
  };
}

function flatFacts(facts: Facts): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(facts)) {
    o[k] = v;
    if (k.startsWith("field.")) o[k.slice(6)] = v;
  }
  return o;
}

export function evaluateRules(rules: Rule[], ctx: EvalContext, opts: EvaluateOptions = {}): CheckResult[] {
  const facts = buildFacts(ctx);
  const disabled = new Set(opts.disabled ?? []);
  const results: CheckResult[] = [];
  for (const rule of rules) {
    if (disabled.has(rule.id) && !rule.locked) continue;
    if (opts.phase && rule.appliesAt && !rule.appliesAt.includes(opts.phase)) continue;
    if (!evaluate(rule.scope, facts)) {
      if (opts.includeOutOfScope) results.push({ ruleId: rule.id, statement: rule.statement, status: "na", severity: rule.severity, message: "Does not apply to this request.", basis: rule.basis, evidence: [], actions: [] });
      continue;
    }
    results.push(evaluateRule(rule, ctx, facts));
  }
  return results;
}

/** Order for display: blocking failures, decisions for the requestor, items for a reviewer, pending, passes. */
export function sortChecks(checks: CheckResult[]): CheckResult[] {
  const rank = (c: CheckResult) => {
    if ((c.status === "fail" || c.status === "pending") && c.severity === "block") return 0;
    if (c.status === "fail" && c.severity === "warn") return 1;
    if (c.status === "judge" || (c.status === "fail" && c.severity === "judge")) return 2;
    if (c.status === "pending") return 3;
    if (c.status === "fail") return 4;
    if (c.status === "pass") return 5;
    return 6;
  };
  return [...checks].sort((a, b) => rank(a) - rank(b));
}

export interface CheckSummary {
  mustFix: CheckResult[];
  yourCall: CheckResult[];
  forReviewer: CheckResult[];
  pending: CheckResult[];
  passed: CheckResult[];
  notes: CheckResult[];
  submittable: boolean;
}

export function summarize(checks: CheckResult[]): CheckSummary {
  const s: CheckSummary = { mustFix: [], yourCall: [], forReviewer: [], pending: [], passed: [], notes: [], submittable: true };
  for (const c of checks) {
    if (c.status === "na") continue;
    if (c.status === "pass") s.passed.push(c);
    else if (c.severity === "block" && (c.status === "fail" || c.status === "pending")) s.mustFix.push(c);
    else if (c.status === "judge" || c.severity === "judge") s.forReviewer.push(c);
    else if (c.severity === "warn" && c.status === "fail") s.yourCall.push(c);
    else if (c.status === "pending") s.pending.push(c);
    else s.notes.push(c);
  }
  s.submittable = s.mustFix.length === 0;
  return s;
}

export const SEVERITY_LABEL: Record<Severity, string> = { block: "Must fix", warn: "Your call", judge: "For a reviewer", inform: "Note" };
export const KNOWN_CHECK_KINDS = Object.keys(CHECKS) as CheckSpec["kind"][];
export type { ActionHint };

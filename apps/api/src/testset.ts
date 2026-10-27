// Runs the synthetic test set (content/halden/testset) against the composed rulebook, without a database.
// Each case states the expected status of every rule, whether it is submittable and where it routes.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Actor, BudgetLine, Catalogue, Organization, Pack, RequestState, Rulebook, ScreeningResult } from "@fe/core";
import { buildFacts, composeRulebook, evaluate, evaluateRules, summarize } from "@fe/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../content");

export interface TestCase {
  id: string; title: string; purpose: string; organizationId: string; subtype: string; country: string; today: string; phase?: "draft" | "submit" | "review" | "pre-payment";
  fields: Record<string, unknown>; budget: BudgetLine[]; documents: string[]; documentText?: Record<string, string>; attestations: string[];
  coi: Record<string, "yes" | "no">; screening: "clear" | "possible-match" | "match"; openRequestsAmount?: number;
  agreement?: RequestState["agreement"];
  expected: { checks: Record<string, string>; submittable: boolean; reviewingGroup?: string; notes?: string };
}

export interface CaseResult {
  id: string; title: string; ok: boolean;
  mismatches: { ruleId: string; expected: string; actual: string; message?: string }[];
  submittable: { expected: boolean; actual: boolean };
  reviewingGroup: { expected?: string; actual?: string };
}

const load = async <T>(rel: string) => JSON.parse(await readFile(path.join(ROOT, rel), "utf8")) as T;

export interface TestsetInputs {
  catalogue: Catalogue; rulebook: Rulebook; packs: Pack[]; organizations: Organization[]; productNames: string[]; cases: TestCase[];
}

export interface TestsetReport { results: CaseResult[]; passed: number; total: number; ruleCoverage: Record<string, { pass: number; fail: number; other: number }> }

export async function runTestset(): Promise<TestsetReport> {
  const catalogue = await load<Catalogue>("halden/catalogue.json");
  const rulebook = await load<Rulebook>("halden/rulebook.json");
  const packs = await Promise.all((await readdir(path.join(ROOT, "packs"))).filter((f) => f.endsWith(".json")).map((f) => load<Pack>(`packs/${f}`)));
  const tenant = await load<{ products?: ({ name: string } | string)[] }>("halden/tenant.json");
  const organizations = await load<Organization[]>("halden/organizations.json");
  const files = (await readdir(path.join(ROOT, "halden/testset"))).filter((f) => /^tc-\d+\.json$/.test(f)).sort();
  const cases = await Promise.all(files.map((f) => load<TestCase>(`halden/testset/${f}`)));
  return evaluateCases({ catalogue, rulebook, packs, organizations, cases, productNames: (tenant.products ?? []).map((p) => (typeof p === "string" ? p : p.name)) });
}

export async function loadTestCases(): Promise<TestCase[]> {
  const files = (await readdir(path.join(ROOT, "halden/testset"))).filter((f) => /^tc-\d+\.json$/.test(f)).sort();
  return Promise.all(files.map((f) => load<TestCase>(`halden/testset/${f}`)));
}

/** Pure evaluation of test cases against a catalogue, rulebook and packs (published or draft). */
export function evaluateCases(inp: TestsetInputs): TestsetReport {
  const { catalogue, rulebook, packs, organizations: orgs, cases } = inp;
  const composed = composeRulebook(rulebook, packs);
  const triage = (composed.parameters.triage as { ruleId: string; group: string }[] | undefined) ?? [];
  const routing = new Set(triage.map((t) => t.ruleId));
  const results: CaseResult[] = [];
  const coverage: Record<string, { pass: number; fail: number; other: number }> = {};
  const person: Actor = { type: "person", id: "requestor", name: "Test Requestor", roles: ["requestor"] };

  for (const tc of cases) {
    const base = orgs.find((o) => o.id === tc.organizationId);
    if (!base) throw new Error(`${tc.id}: unknown organization ${tc.organizationId}`);
    // Screening re-runs at submission and before payment, so each case sees it as run on its own date.
    const screening: ScreeningResult[] = (base.screening ?? []).map((s) => ({ ...s, result: "clear" as const, checkedAt: `${tc.today}T08:00:00Z` }));
    if (tc.screening !== "clear") {
      const target = screening.find((s) => s.list.startsWith("OFAC")) ?? screening[0];
      if (target) target.result = tc.screening;
      else screening.push({ list: "OFAC-SDN", listVersion: "test", checkedAt: `${tc.today}T00:00:00Z`, result: tc.screening });
    }
    const org: Organization = { ...base, screening };
    const sub = catalogue.subtypes.find((s) => s.id === tc.subtype);
    const at = `${tc.today}T12:00:00Z`;
    const state: RequestState = {
      id: tc.id, tenantId: "t", ref: tc.id, organizationId: org.id, requestorId: "requestor", family: sub?.family, subtype: tc.subtype, typeConfirmed: true,
      country: tc.country, status: tc.phase === "pre-payment" ? "agreement" : "draft", stage: tc.phase === "pre-payment" ? "agreement" : "intake",
      fields: Object.fromEntries(Object.entries(tc.fields).map(([k, value]) => [k, { value, status: "confirmed" as const, source: { kind: "form" as const } }])),
      budget: tc.budget ?? [], documents: [], attestations: Object.fromEntries(tc.attestations.map((a) => [a, { id: a, version: "1", text: "", by: person, at }])),
      coi: Object.fromEntries(Object.entries(tc.coi ?? {}).map(([q, a]) => [q, { questionId: q, answer: a, detail: a === "yes" ? "Test detail" : undefined, by: person, at }])),
      checks: [], flags: [], versions: { rulebook: 1, workflow: 1, catalogue: 1, packs: {} }, createdAt: at, agreement: tc.agreement,
    };
    const documents = tc.documents.map((type, i) => ({ id: `doc-${i}`, type, name: `${type}.txt`, sha256: "", pagesText: tc.documentText?.[type] ? [tc.documentText[type]!] : undefined }));
    const ctx = {
      request: state, organization: org, catalogue, subtype: sub, documents, today: tc.today, openRequestsAmount: tc.openRequestsAmount ?? 0,
      parameters: composed.parameters, agreement: tc.agreement,
      productNames: inp.productNames,
    };
    const checks = evaluateRules(composed.rules.filter((r) => !routing.has(r.id)), ctx, { phase: tc.phase, includeOutOfScope: true });
    const byId = new Map(checks.map((c) => [c.ruleId, c]));
    const mismatches: CaseResult["mismatches"] = [];
    for (const [ruleId, exp] of Object.entries(tc.expected.checks)) {
      if (routing.has(ruleId)) continue;
      const c = byId.get(ruleId);
      const actual = c?.status ?? "na";
      if (actual !== exp) mismatches.push({ ruleId, expected: exp, actual, message: c?.message });
    }
    for (const c of checks) {
      const cov = (coverage[c.ruleId] ??= { pass: 0, fail: 0, other: 0 });
      if (c.status === "pass") cov.pass++; else if (c.status === "fail") cov.fail++; else cov.other++;
    }
    const facts = buildFacts(ctx);
    const group = triage.find((t) => { const r = composed.rules.find((x) => x.id === t.ruleId); return r && evaluate(r.scope, facts); })?.group;
    const sub2 = summarize(checks).submittable;
    results.push({
      id: tc.id, title: tc.title,
      ok: mismatches.length === 0 && sub2 === tc.expected.submittable && (!tc.expected.reviewingGroup || tc.expected.reviewingGroup === group),
      mismatches, submittable: { expected: tc.expected.submittable, actual: sub2 }, reviewingGroup: { expected: tc.expected.reviewingGroup, actual: group },
    });
  }
  return { results, passed: results.filter((r) => r.ok).length, total: results.length, ruleCoverage: coverage };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runTestset().then(({ results, passed, total }) => {
    for (const r of results) {
      const extra = [
        r.submittable.expected !== r.submittable.actual ? `submittable expected ${r.submittable.expected}, got ${r.submittable.actual}` : "",
        r.reviewingGroup.expected && r.reviewingGroup.expected !== r.reviewingGroup.actual ? `routes to "${r.reviewingGroup.actual}", expected "${r.reviewingGroup.expected}"` : "",
      ].filter(Boolean).join("; ");
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} ${r.title}${extra ? ` — ${extra}` : ""}`);
      for (const m of r.mismatches) console.log(`     ${m.ruleId}: expected ${m.expected}, got ${m.actual}${m.message ? ` (${m.message.slice(0, 140)})` : ""}`);
    }
    console.log(`\n${passed} of ${total} test cases agree with the rulebook.`);
    process.exit(passed === total ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(2); });
}

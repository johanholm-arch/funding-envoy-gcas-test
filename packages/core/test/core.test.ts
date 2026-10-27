import { describe, expect, it } from "vitest";
import {
  evaluate, evaluateRules, summarize, composeRulebook, sealEvent, verifyChain, GENESIS_HASH,
  transition, validateWorkflow, effectiveLevel, gateProposal, assertPersonForLockedAction, assertNotCommercial,
  addBusinessDays, daysBetween, toDate,
  type Actor, type Catalogue, type EvalContext, type Organization, type Pack, type RequestState, type Rule, type WorkflowDef, type AuditEvent,
} from "../src/index.ts";

const person = (roles: Actor["roles"], id = "p1"): Actor => ({ type: "person", id, name: "Test Person", roles });
const agent: Actor = { type: "agent", id: "fe", name: "FundingEnvoy" };

const catalogue: Catalogue = {
  version: 1,
  families: [{ id: "education", name: "Education", description: "" }],
  subtypes: [{
    id: "ime-accredited", family: "education", name: "Accredited IME", description: "", distinguishers: [], sections: [],
    fields: [], documents: [], attestations: ["accuracy", "anti-discrimination"], coi: ["q1", "q2"],
    salesRule: "none", payeeRule: "accredited-provider", reviewingGroupRule: "T-3",
  }],
  attestations: [
    { id: "accuracy", label: "Accuracy", text: "...", version: "1", mode: "tick" },
    { id: "anti-discrimination", label: "Anti-discrimination", text: "...", version: "1", mode: "tick" },
  ],
  coiQuestions: [{ id: "q1", text: "?" }, { id: "q2", text: "?" }],
};

const org: Organization = {
  id: "o1", legalName: "New England Cardiology Society", type: "association", country: "US",
  identifiers: { ein: "04-0000001" }, governmentControlled: false,
  annualRevenue: { amount: 1_200_000, currency: "USD", fiscalYear: "2025" },
  officers: [], signers: [],
  screening: ["LEIE", "SAM", "OFAC-SDN"].map((list) => ({ list, listVersion: "2026-10", checkedAt: "2026-10-21T13:59:00Z", result: "clear" as const })),
};

function req(over: Partial<RequestState> = {}): RequestState {
  const fv = (value: unknown) => ({ value, status: "confirmed" as const, source: { kind: "form" as const } });
  return {
    id: "r1", tenantId: "t1", ref: "2026-01642-IME", organizationId: "o1", requestorId: "u1",
    family: "education", subtype: "ime-accredited", typeConfirmed: true, country: "US", status: "draft", stage: "intake",
    fields: {
      title: fv("Advances in Heart Failure Management 2027"),
      "amount.requested": fv(50000), "amount.currency": fv("USD"),
      "activity.startDate": fv("2027-05-14"),
    },
    budget: [
      { line: 1, description: "Venue", category: "venue", amount: 46100 },
      { line: 9, description: "Faculty dinner", category: "meals", amount: 2400 },
    ],
    documents: [], attestations: {}, coi: {}, checks: [], flags: [],
    versions: { rulebook: 1, workflow: 1, catalogue: 1, packs: {} }, createdAt: "2026-10-21T13:58:00Z",
    ...over,
  };
}

const ctx = (r: RequestState, over: Partial<EvalContext> = {}): EvalContext => ({
  request: r, organization: org, catalogue, subtype: catalogue.subtypes[0], documents: [], today: "2027-04-02",
  parameters: { revenueCap: 0.25, leadTimeDays: 60 }, ...over,
});

const rule = (id: string, check: Rule["check"], severity: Rule["severity"] = "block", scope: Rule["scope"] = { always: true }): Rule => ({
  id, statement: id, basis: { layer: "policy", ref: id }, scope, check, severity,
  messages: { pass: "{{ratio}} of revenue", fail: "{{ratio}} exceeds {{max}}" }, source: "tenant",
});

describe("conditions", () => {
  it("evaluates nested predicates and loose equality", () => {
    const facts = { country: "US", amount: "48500", subtype: "ime-accredited" };
    expect(evaluate({ all: [{ fact: "country", op: "in", value: ["US", "GB"] }, { fact: "amount", op: "lt", value: 50000 }] }, facts)).toBe(true);
    expect(evaluate({ not: { fact: "subtype", op: "eq", value: "IME-ACCREDITED" } }, facts)).toBe(false);
    expect(evaluate({ fact: "missing", op: "missing" }, facts)).toBe(true);
  });
});

describe("rule engine", () => {
  it("computes the revenue cap with open requests and a parameter reference", () => {
    const r = rule("R-04", { kind: "ratioMax", numerator: ["amount.requested"], denominator: "org.annualRevenue", max: "param.revenueCap", includeOpenRequests: true });
    const [res] = evaluateRules([r], ctx(req(), { openRequestsAmount: 0 }));
    expect(res!.status).toBe("pass");
    expect(res!.message).toBe("4.2% of revenue");
    const [over] = evaluateRules([r], ctx(req(), { openRequestsAmount: 260_000 }));
    expect(over!.status).toBe("fail");
  });

  it("treats the cap boundary as inclusive", () => {
    const r = rule("R-04", { kind: "ratioMax", numerator: ["amount.requested"], denominator: "org.annualRevenue", max: 0.25 });
    const exact = req({ fields: { ...req().fields, "amount.requested": { value: 300000, status: "confirmed", source: { kind: "form" } } } });
    expect(evaluateRules([r], ctx(exact))[0]!.status).toBe("pass");
  });

  it("lead time boundary is >= minDays", () => {
    const r = rule("R-07", { kind: "leadTime", dateField: "activity.startDate", minDays: 60 }, "warn");
    const at = (today: string) => evaluateRules([r], ctx(req(), { today }))[0]!.status;
    expect(at("2027-03-14")).toBe("pass"); // 61
    expect(at("2027-03-15")).toBe("pass"); // 60
    expect(at("2027-03-16")).toBe("fail"); // 59
  });

  it("flags budget mismatch, hospitality and blocked categories", () => {
    const eq = rule("R-18", { kind: "equalsWithin", a: "amount.requested", b: "budget.total" }, "warn");
    expect(evaluateRules([eq], ctx(req()))[0]!.status).toBe("fail");
    const bl = rule("R-HOSP", { kind: "budgetLines", blockCategories: ["entertainment", "learner-travel"], judgeCategories: ["meals"] }, "judge");
    expect(evaluateRules([bl], ctx(req()))[0]!.status).toBe("judge");
    const withEnt = req({ budget: [...req().budget, { line: 12, description: "Gala", category: "entertainment", amount: 500 }] });
    expect(evaluateRules([bl], ctx(withEnt))[0]!.status).toBe("fail");
  });

  it("requires attestations and COI answers, and routes a yes", () => {
    const att = rule("ATT", { kind: "attestationsComplete" });
    const coi = rule("COI", { kind: "coiComplete" });
    const yes = rule("COI-NO", { kind: "coiAllNo" }, "judge");
    const r0 = req();
    expect(evaluateRules([att, coi], ctx(r0)).map((c) => c.status)).toEqual(["fail", "fail"]);
    const by = person(["requestor"]);
    const r1 = req({
      attestations: { accuracy: { id: "accuracy", version: "1", text: "", by, at: "2026-10-21T14:31:00Z" }, "anti-discrimination": { id: "anti-discrimination", version: "1", text: "", by, at: "2026-10-21T14:31:00Z" } },
      coi: { q1: { questionId: "q1", answer: "no", by, at: "x" }, q2: { questionId: "q2", answer: "yes", detail: "Board member consults", by, at: "x" } },
    });
    expect(evaluateRules([att, coi, yes], ctx(r1)).map((c) => c.status)).toEqual(["pass", "pass", "fail"]);
  });

  it("finds independence language in a document with page provenance", () => {
    const q = rule("R-15", { kind: "documentQuote", documentType: "prospectus", mustContainAny: ["no role in planning, faculty or content"] }, "judge");
    const docs = [{ id: "d1", type: "prospectus", name: "HF2027_Prospectus.pdf", sha256: "x", pagesText: ["Page one", "Supporter role: Supporters have no role in planning, faculty or content.\nNext"] }];
    const [res] = evaluateRules([q], ctx(req(), { documents: docs }));
    expect(res!.status).toBe("pass");
    expect(res!.evidence[0]!.source?.page).toBe(2);
    expect(evaluateRules([q], ctx(req()))[0]!.status).toBe("pending");
  });

  it("blocks individuals and screening matches", () => {
    const ind = rule("CORE-G1", { kind: "recipientIsOrganization" });
    expect(evaluateRules([ind], ctx(req(), { organization: { ...org, type: "individual" } }))[0]!.status).toBe("fail");
    const scr = rule("SCR", { kind: "screeningClear", lists: ["LEIE", "SAM", "OFAC-SDN"] });
    expect(evaluateRules([scr], ctx(req()))[0]!.status).toBe("pass");
    const pm = { ...org, screening: [...org.screening, { list: "OFAC-SDN", listVersion: "2026-11", checkedAt: "2026-11-01T00:00:00Z", result: "possible-match" as const }] };
    expect(evaluateRules([scr], ctx(req(), { organization: pm }))[0]!.status).toBe("judge");
  });

  it("omits out-of-scope rules and summarizes submittability", () => {
    const uk = rule("UK-1", { kind: "fieldsPresent", fields: ["certifiedBy"] }, "block", { fact: "country", op: "eq", value: "GB" });
    const missingTitle = rule("F", { kind: "fieldsPresent", fields: ["needsAssessment"] });
    const res = evaluateRules([uk, missingTitle], ctx(req()));
    expect(res.map((r) => r.ruleId)).toEqual(["F"]);
    expect(summarize(res).submittable).toBe(false);
    expect(evaluateRules([uk], ctx(req()), { includeOutOfScope: true })[0]!.status).toBe("na");
  });
});

describe("rulebook composition", () => {
  const pack: Pack = {
    id: "core", name: "Core", version: 1, effectiveFrom: "2026-01-01", jurisdiction: "GLOBAL",
    rules: [{ ...rule("CORE-G1", { kind: "recipientIsOrganization" }), locked: true, source: "pack:core" }],
    parameters: [{ key: "leadTimeDays", label: "Lead time", value: 45, source: "x", verified: true }],
    clauses: [], disclosures: [], calendar: [], verification: { status: "verified", notes: [] },
  };
  it("keeps locked rules and lets tenant parameters override", () => {
    const c = composeRulebook({ version: 3, status: "published", packs: [{ id: "core", version: 1 }], rules: [rule("CORE-G1", { kind: "predicate", condition: { always: true } }), rule("R-07", { kind: "leadTime", dateField: "activity.startDate", minDays: 60 })], disabled: ["CORE-G1"], parameters: { leadTimeDays: 60 } }, [pack]);
    expect(c.rules.map((r) => r.id)).toEqual(["CORE-G1", "R-07"]);
    expect(c.rules[0]!.check.kind).toBe("recipientIsOrganization");
    expect(c.parameters.leadTimeDays).toBe(60);
    expect(c.warnings.length).toBe(2);
  });
});

describe("audit chain", () => {
  it("verifies an intact chain and detects tampering", () => {
    const events: AuditEvent[] = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= 5; i++) {
      const e = sealEvent({ tenantId: "t1", actor: agent, entity: { type: "request", id: "r1" }, action: `a${i}`, data: { i } }, i, `e${i}`, `2026-10-21T14:0${i}:00Z`, prev);
      events.push(e);
      prev = e.hash;
    }
    expect(verifyChain(events).ok).toBe(true);
    const tampered = events.map((e) => (e.seq === 3 ? { ...e, data: { i: 99 } } : e));
    const v = verifyChain(tampered);
    expect(v.ok).toBe(false);
    expect(v.firstBreak?.seq).toBe(3);
  });
});

describe("workflow and gates", () => {
  const wf: WorkflowDef = {
    version: 1, status: "published", name: "t", source: { document: "SOP", version: "4", clauses: {} },
    stages: [
      { id: "intake", order: 1, name: "Intake", ownerRoles: ["requestor"], sopRefs: ["3.1"], assistant: { level: 3, maxLevel: 4, does: "" },
        outcomes: [{ id: "submit", label: "Submit", next: "compliance-review", actorRoles: ["requestor"] }] },
      { id: "compliance-review", order: 2, name: "Compliance", ownerRoles: ["compliance-reviewer"], sopRefs: ["6.1"], assistant: { level: 2, maxLevel: 2, does: "" },
        skipWhen: { fact: "coi.anyYes", op: "falsy" },
        variations: [{ when: { fact: "country", op: "eq", value: "FR" }, note: "always for FR", companyChoice: true, patch: { skipWhen: undefined } }],
        outcomes: [{ id: "complete", label: "Complete", next: "committee", actorRoles: ["compliance-reviewer"] }] },
      { id: "committee", order: 3, name: "Committee", ownerRoles: ["committee-member"], sopRefs: ["6.2"], assistant: { level: 2, maxLevel: 2, does: "" },
        outcomes: [
          { id: "approve", label: "Approve", next: "closed", actorRoles: ["committee-member", "committee-chair"], locked: "decide-funding" },
          { id: "decline", label: "Decline", next: "declined", actorRoles: ["committee-member", "committee-chair"], locked: "decide-funding", requiresReason: true },
        ] },
    ],
  };

  it("validates a sound workflow", () => {
    expect(validateWorkflow(wf).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("skips compliance unless flagged, and not in France", () => {
    const us = transition({ wf, currentStageId: "intake", outcomeId: "submit", actor: person(["requestor"]), facts: { "coi.anyYes": false, country: "US" } });
    expect(us.to).toBe("committee");
    expect(us.skipped).toEqual(["compliance-review"]);
    const fr = transition({ wf, currentStageId: "intake", outcomeId: "submit", actor: person(["requestor"]), facts: { "coi.anyYes": false, country: "FR" } });
    expect(fr.to).toBe("compliance-review");
  });

  it("refuses a funding decision by the assistant and a decline without reason", () => {
    expect(() => transition({ wf, currentStageId: "committee", outcomeId: "approve", actor: agent, facts: {} })).toThrow(/named person/);
    expect(() => transition({ wf, currentStageId: "committee", outcomeId: "decline", actor: person(["committee-chair"]), facts: {} })).toThrow(/reason/);
    expect(transition({ wf, currentStageId: "committee", outcomeId: "approve", actor: person(["committee-chair"]), facts: {} }).status).toBe("closed");
  });

  it("caps the assistant at Recommend where a locked action lives", () => {
    const committee = { ...wf.stages[2]!, assistant: { level: 4 as const, maxLevel: 4 as const, does: "" } };
    expect(effectiveLevel(committee, undefined, {})).toBe(2);
    expect(validateWorkflow({ ...wf, stages: [wf.stages[0]!, wf.stages[1]!, committee] }).some((i) => i.message.includes("person-only decision"))).toBe(true);
    expect(effectiveLevel(wf.stages[0]!, { version: 1, profile: "cautious", overrides: [], confidenceFloor: 0.7 }, {})).toBe(2);
  });

  it("lets the assistant act at a stage that has unlocked outcomes, but never take the locked one", () => {
    const agreement = { id: "agreement", order: 4, name: "Agreement", ownerRoles: ["legal" as const], sopRefs: ["7.1"], assistant: { level: 3 as const, maxLevel: 4 as const, does: "" },
      outcomes: [{ id: "complete", label: "Signed", next: "closed", actorRoles: ["legal" as const], locked: "sign-agreement" as const }, { id: "send", label: "Send for signature", next: "agreement", actorRoles: ["legal" as const] }] };
    expect(effectiveLevel(agreement, undefined, {})).toBe(3);
    const wf2 = { ...wf, stages: [...wf.stages, { ...agreement, order: 4 }] };
    expect(() => transition({ wf: wf2, currentStageId: "agreement", outcomeId: "complete", actor: agent, facts: {} })).toThrow(/named person/);
  });

  it("gates proposals by level and confidence", () => {
    expect(gateProposal(4, { confidence: 0.97, floor: 0.7 })).toBe("applied");
    expect(gateProposal(4, { confidence: 0.5, floor: 0.7 })).toBe("held-for-person");
    expect(gateProposal(3, {})).toBe("held-for-person");
    expect(gateProposal(1, {})).toBe("dropped");
  });

  it("keeps sales out and requires roles for locked actions", () => {
    expect(() => assertNotCommercial(person(["sales"]))).toThrow(/Sales/);
    expect(() => assertPersonForLockedAction("release-payment", person(["coordinator"]))).toThrow();
    expect(() => assertPersonForLockedAction("release-payment", person(["finance"]))).not.toThrow();
  });

  it("adds business days across a weekend", () => {
    expect(addBusinessDays(toDate("2026-10-23")!, 1).toISOString().slice(0, 10)).toBe("2026-10-26");
  });
});

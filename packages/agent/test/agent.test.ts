import { describe, expect, it } from "vitest";
import type { Catalogue, FieldDef } from "@fe/core";
import { DemoProvider, parseBudgetCsv, parseClauses, readDocument, retrieve, scopeCheck, splitPages } from "../src/index.ts";

const prospectus = `=== Page 1 ===
# Advances in Heart Failure Management 2027
Title: Advances in Heart Failure Management 2027
Start: 2027-05-14 08:00
End: 2027-05-15 16:30
Location: Boston, MA, US
=== Page 2 ===
Accredited provider: Beacon CME
Credits: 11.0 AMA PRA Category 1 Credits
Supporter role: Supporters have no role in planning, faculty or content.
=== Page 6 ===
Outcomes: Pre/post knowledge test; 90-day practice survey (Moore level 5)`;

const fields: FieldDef[] = [
  { key: "title", label: "Title", kind: "text", section: "a" },
  { key: "activity.startDate", label: "Start date", kind: "datetime", section: "a" },
  { key: "activity.endDate", label: "End date", kind: "datetime", section: "a" },
  { key: "activity.location", label: "Location", kind: "text", section: "a" },
  { key: "provider.name", label: "Accredited provider", kind: "text", section: "a" },
  { key: "provider.accredited", label: "Provider is accredited", kind: "boolean", section: "a" },
  { key: "credits", label: "Credits", kind: "text", section: "a" },
  { key: "outcomes.methods", label: "Outcomes", kind: "longtext", section: "a" },
  { key: "outcomes.level", label: "Outcomes level", kind: "enum", section: "a", options: ["moore-1", "moore-5"] },
  { key: "audience.geography", label: "Audience geography", kind: "enum", section: "a", options: ["mainly-us", "mainly-uk"] },
  { key: "amount.requested", label: "Amount requested", kind: "money", section: "b" },
  { key: "amount.currency", label: "Currency", kind: "text", section: "b" },
];

describe("documents", () => {
  it("splits pages and keeps page numbers", () => {
    const pages = splitPages(prospectus);
    expect(pages.length).toBe(3);
    expect(pages[1]).toContain("Beacon CME");
  });

  it("parses a CSV budget with cell provenance", () => {
    const csv = `Line,Description,Category,Amount\n1,Venue hire,venue,18000\n9,"Faculty dinner, provider-planned",meals,2400\n,Total,,20400`;
    const lines = parseBudgetCsv(csv, "d1", "HF2027_Budget.csv");
    expect(lines.map((l) => l.amount)).toEqual([18000, 2400]);
    expect(lines[1]!.description).toBe("Faculty dinner, provider-planned");
    expect(lines[1]!.source?.cell).toBe("D3");
  });

  it("reads markdown documents through readDocument", async () => {
    const r = await readDocument(Buffer.from(prospectus), "HF2027_Prospectus.md", "text/markdown");
    expect(r.pages.length).toBe(3);
  });
});

describe("demo provider", () => {
  const p = new DemoProvider();
  it("extracts labelled facts with page provenance and derives accreditation and Moore level", async () => {
    const out = await p.extractFields({ documents: [{ id: "d1", name: "HF2027_Prospectus.md", pages: splitPages(prospectus) }], fields });
    const get = (k: string) => out.proposals.find((x) => x.key === k);
    expect(get("provider.name")?.value).toBe("Beacon CME");
    expect(get("provider.name")?.source.page).toBe(2);
    expect(get("activity.startDate")?.value).toBe("2027-05-14T08:00");
    expect(get("provider.accredited")?.value).toBe(true);
    expect(get("outcomes.level")?.value).toBe("moore-5");
    expect(get("audience.geography")?.value).toBe("mainly-us");
    expect(out.trace.provider).toBe("demo");
  });

  it("reads amount, currency and dates from a message", async () => {
    const out = await p.extractFromMessage("I'd like to request $50,000 to support a CME programme in Boston, 14–15 May 2027.", fields, "m1");
    const get = (k: string) => out.proposals.find((x) => x.key === k)?.value;
    expect(get("amount.requested")).toBe(50000);
    expect(get("amount.currency")).toBe("USD");
    expect(get("activity.startDate")).toBe("2027-05-14");
    expect(get("activity.endDate")).toBe("2027-05-15");
  });

  it("classifies an accredited request and asks the deciding question", async () => {
    const catalogue = { version: 1, families: [], attestations: [], coiQuestions: [], subtypes: [
      { id: "ime-accredited", name: "Accredited education" }, { id: "ime-non-accredited", name: "Non-accredited education" }, { id: "charitable-contribution", name: "Charitable contribution" },
    ] } as unknown as Catalogue;
    const r = await p.classifyRequest({ text: "CME symposium", proposals: [{ key: "provider.name", value: "Beacon CME", confidence: 0.9, source: { kind: "document" } }], catalogue, country: "US" });
    expect(r.subtype).toBe("ime-accredited");
    expect(r.question?.text).toContain("Beacon CME");
  });

  it("classifies documents by name and content", async () => {
    const r = await p.classifyDocument({ name: "NECS_W9_2026.txt", mime: "text/plain", pages: ["Request for Taxpayer Identification Number"] }, [{ type: "w9", label: "W-9" }, { type: "budget", label: "Budget" }]);
    expect(r.type).toBe("w9");
    expect(r.confidence).toBeGreaterThan(0.9);
  });
});

describe("policy guidance", () => {
  const md = `# Grants and Donations Policy v6
## 6 What we fund
6.1 No funding of individuals. Halden does not fund individual healthcare professionals, travel for named people, or product promotion.
6.4 Meals and hospitality. Halden does not fund entertainment. A modest working meal that is part of an accredited agenda and decided by the provider may sit inside the programme budget.
## 5 Limits
5.2 Revenue cap. Cumulative funding to one organization in a calendar year may not exceed 25% of its annual gross revenue.`;
  const clauses = parseClauses(md, "Policy", "Grants and Donations Policy v6");

  it("parses numbered clauses", () => {
    expect(clauses.map((c) => c.ref)).toEqual(["Policy 6.1", "Policy 6.4", "Policy 5.2"]);
  });

  it("retrieves the right clause", () => {
    expect(retrieve("Can we ask for support for the faculty dinner?", clauses)[0]!.clause.ref).toBe("Policy 6.4");
    expect(retrieve("what percent of our revenue can you fund", clauses)[0]!.clause.ref).toBe("Policy 5.2");
  });

  it("declines predictions, amount advice and drafting in code, before any model", () => {
    expect(scopeCheck("Will this be approved?")).toBe("prediction");
    expect(scopeCheck("How much do you usually give for a symposium?")).toBe("amount-advice");
    expect(scopeCheck("Can you write the needs assessment for us?")).toBe("rationale-drafting");
    expect(scopeCheck("Please submit it for me")).toBe("attestation");
    expect(scopeCheck("Can we include the faculty dinner?")).toBeUndefined();
  });

  it("answers from the clause with a quote", async () => {
    const a = await new DemoProvider().answerPolicy("faculty dinner", retrieve("Can we ask for support for the faculty dinner?", clauses).map((r) => r.clause));
    expect(a.citations[0]!.ref).toBe("Policy 6.4");
    expect(a.answer).toContain("working meal");
  });
});

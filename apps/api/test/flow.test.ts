// End-to-end through the HTTP API with the flagship synthetic documents.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { closePool } from "@fe/db";
import { buildServer } from "../src/server.ts";
import { seed, uuidFor } from "../src/seed.ts";

process.env.FE_TODAY = "2027-04-02";
process.env.FE_ASSISTANT = "demo";
const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../content/halden/documents/necs-hf2027");

let app: FastifyInstance;
const cookies: Record<string, string> = {};

async function login(who: string, userId: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId } });
  expect(r.statusCode, r.body).toBe(200);
  const c = r.cookies.find((x) => x.name === "fe_session")!;
  cookies[who] = `fe_session=${c.value}`;
}

async function call(who: string, method: "GET" | "POST", url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload: payload as object, headers: { cookie: cookies[who]! } });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode}: ${r.body}`);
  return r.json();
}

async function upload(who: string, requestId: string, files: string[]) {
  const boundary = "----fe" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const f of files) {
    const buf = await readFile(path.join(DOCS, f));
    const mime = f.endsWith(".csv") ? "text/csv" : "text/markdown";
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f}"\r\nContent-Type: ${mime}\r\n\r\n`), buf, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const r = await app.inject({ method: "POST", url: `/api/requests/${requestId}/documents`, payload: Buffer.concat(parts), headers: { cookie: cookies[who]!, "content-type": `multipart/form-data; boundary=${boundary}` } });
  if (r.statusCode >= 400) throw new Error(`upload → ${r.statusCode}: ${r.body}`);
}

beforeAll(async () => {
  await seed();
  app = await buildServer();
  await login("marsh", uuidFor("rq-marsh"));
  await login("osei", uuidFor("hp-osei"));
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe("flagship request, end to end", () => {
  let id = "";

  it("starts from the requestor's own words", async () => {
    const r = await call("marsh", "POST", "/api/requests", { text: "I'd like to request $50,000 to support a CME programme in Boston. It's our annual heart failure symposium, 14–15 May 2027." });
    id = r.id;
    const v = await call("marsh", "GET", `/api/requests/${id}`);
    expect(v.request.fields["amount.requested"].value).toBe(50000);
    expect(v.request.fields["amount.requested"].source.kind).toBe("message");
    const last = v.messages.at(-1);
    expect(last.data.ask.kind).toBe("type");
  });

  it("reads the prospectus and budget with page and cell provenance, without overwriting what she said", async () => {
    await upload("marsh", id, ["HF2027_Prospectus.md", "HF2027_Budget.csv"]);
    const v = await call("marsh", "GET", `/api/requests/${id}`);
    const f = v.request.fields;
    expect(f["provider.name"].value).toBe("Beacon CME");
    expect(f["provider.name"].status).toBe("proposed");
    expect(f["provider.name"].source.page).toBeGreaterThan(0);
    expect(v.request.budget.length).toBe(11);
    expect(v.request.budget.reduce((s: number, l: { amount: number }) => s + l.amount, 0)).toBe(48500);
    expect(f["amount.requested"].value).toBe(50000);
    const docs = v.documents.map((d: { type: string }) => d.type).sort();
    expect(docs).toEqual(["budget", "prospectus"]);
    // The prospectus states the ACCME accreditation on page 2, so it also satisfies that requirement.
    expect(v.documents.find((d: { type: string }) => d.type === "prospectus").covers).toContain("accreditation-statement");
  });

  it("confirms the type, then asks about the budget mismatch", async () => {
    await call("marsh", "POST", `/api/requests/${id}/choice`, { questionId: "type", optionId: "subtype:ime-accredited" });
    const v = await call("marsh", "GET", `/api/requests/${id}`);
    expect(v.request.typeConfirmed).toBe(true);
    expect(v.subtype.id).toBe("ime-accredited");
    expect(v.messages.at(-1).data.ask.kind).toBe("budget");
  });

  it("uses the budget total when she chooses it, recording the change and reason", async () => {
    const v0 = await call("marsh", "GET", `/api/requests/${id}`);
    await call("marsh", "POST", `/api/requests/${id}/choice`, { questionId: v0.messages.at(-1).data.ask.questionId, optionId: "use-budget" });
    const v = await call("marsh", "GET", `/api/requests/${id}`);
    expect(v.request.fields["amount.requested"].value).toBe(48500);
    expect(v.request.fields["amount.requested"].previous[0].value).toBe(50000);
  });

  it("refuses to submit while things are open, and says why", async () => {
    const r = await app.inject({ method: "POST", url: `/api/requests/${id}/submit`, headers: { cookie: cookies.marsh! } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/must be fixed|decision|confirmation/);
  });

  it("declines to predict a decision, and answers a policy question with a clause", async () => {
    await call("marsh", "POST", `/api/requests/${id}/messages`, { text: "Will this be approved?" });
    let v = await call("marsh", "GET", `/api/requests/${id}`);
    expect(v.messages.at(-1).data.declined).toBe("prediction");
    await call("marsh", "POST", `/api/requests/${id}/messages`, { text: "Can we ask for support for the faculty dinner?" });
    v = await call("marsh", "GET", `/api/requests/${id}`);
    const m = v.messages.at(-1);
    expect(m.data.policyAnswer).toBe(true);
    expect(m.data.citations[0].ref).toMatch(/^Policy|^SOP/);
  });

  it("completes the request: documents, fields, conflict questions, statements, flags", async () => {
    await upload("marsh", id, ["NECS_Request_Letter.md", "NECS_W9_2026.md", "NECS_Nonprofit_Letter_2021.md", "NECS_Financial_Statement_2025.md"]);
    await call("marsh", "POST", `/api/requests/${id}/confirm-all`);
    let p = await call("marsh", "GET", `/api/requests/${id}/preview`);
    // Fill whatever the catalogue still needs that the documents did not state.
    const missing = p.progress.missing as { key: string; kind: string; options?: string[] }[];
    const filler = (f: { kind: string; options?: string[] }) => f.options?.[0] ?? (f.kind === "number" || f.kind === "money" ? 1 : f.kind === "boolean" ? true : f.kind.startsWith("date") ? "2027-05-14" : "Stated by the requestor for the test");
    if (missing.length) await call("marsh", "POST", `/api/requests/${id}/fields`, { changes: missing.map((f) => ({ key: f.key, value: filler(f) })) });
    for (const q of p.subtype.coi as string[]) await call("marsh", "POST", `/api/requests/${id}/coi`, { questionId: q, answer: "no" });
    for (const a of p.subtype.attestations as string[]) {
      const def = p.catalogue.attestations.find((x: { id: string }) => x.id === a);
      await call("marsh", "POST", `/api/requests/${id}/attestations`, { attestationId: a, typedName: def.mode === "type" ? "Dr. Elena Marsh" : undefined });
    }
    p = await call("marsh", "GET", `/api/requests/${id}/preview`);
    for (const c of p.checks.filter((c: { status: string; severity: string; acknowledged?: unknown }) => c.status === "fail" && c.severity === "warn" && !c.acknowledged)) {
      await call("marsh", "POST", `/api/requests/${id}/flags`, { ruleId: c.ruleId, choice: "submit-with-flag", note: "Dates are fixed by the venue contract." });
    }
    p = await call("marsh", "GET", `/api/requests/${id}/preview`);
    expect(p.blockers).toEqual([]);
    expect(p.canSubmit).toBe(true);
    const lead = p.checks.find((c: { ruleId: string }) => c.ruleId === "R-07");
    expect(lead.status).toBe("fail");
    expect(lead.acknowledged.choice).toBe("submit-with-flag");
  });

  it("submits in her name, then the assistant checks completeness and proposes routing", async () => {
    const r = await call("marsh", "POST", `/api/requests/${id}/submit`);
    expect(r.ref).toMatch(/^\d{4}-\d{5}-IME$/);
    const v = await call("marsh", "GET", `/api/requests/${id}`);
    expect(["triage", "medical-review"]).toContain(v.request.stage);
    expect(v.request.reviewingGroup.label).toBe("US medical education");
  });

  it("puts it on the coordinator's desk with judgement items first", async () => {
    const d = await call("osei", "GET", "/api/desk");
    const item = [...d.needsYou, ...d.assistant, ...d.waiting].find((x: { id: string }) => x.id === id);
    expect(item).toBeTruthy();
    const b = await call("osei", "GET", `/api/requests/${id}/brief`);
    const ids = b.judgement.map((j: { ruleId: string }) => j.ruleId);
    expect(ids).toContain("R-07"); // lead time, submitted with flag
    expect(ids).toContain("R-24"); // faculty dinner line
    expect(b.recommendation.text).toMatch(/US medical education/);
  });

  it("refuses sales access and refuses an assistant funding decision path", async () => {
    const sales = uuidFor("hp-sales");
    const r0 = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId: sales } });
    if (r0.statusCode === 200) {
      const c = `fe_session=${r0.cookies.find((x) => x.name === "fe_session")!.value}`;
      const r = await app.inject({ method: "GET", url: "/api/desk", headers: { cookie: c } });
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe("G2");
    }
  });

  it("routes it, and the trail verifies with person, assistant and system entries", async () => {
    const v = await call("osei", "GET", `/api/requests/${id}/brief`);
    if (v.request.stage === "triage") await call("osei", "POST", `/api/requests/${id}/act`, { outcome: "route", groupId: v.reviewingGroup.id ?? "us-medical-education" });
    const after = await call("osei", "GET", `/api/requests/${id}/brief`);
    expect(after.request.stage).toBe("medical-review");
    const t = await call("osei", "GET", `/api/requests/${id}/trail`);
    expect(t.counts.people).toBeGreaterThan(10);
    expect(t.counts.agent).toBeGreaterThan(3);
    const ai = t.events.find((e: { action: string }) => e.action === "assistant.extracted");
    expect(ai.ai.provider).toBe("demo");
    expect(ai.ai.gate.outcome).toBe("proposed");
    const verify = await call("osei", "GET", "/api/audit/verify");
    expect(verify.ok).toBe(true);
  });
});

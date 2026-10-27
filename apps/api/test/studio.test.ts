// Studio governance: draft → validate → test set → signed publication; in-flight requests keep their version.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "@fe/db";
import { buildServer } from "../src/server.ts";
import { seed, uuidFor } from "../src/seed.ts";

process.env.FE_TODAY = "2027-04-02";
process.env.FE_ASSISTANT = "demo";
let app: FastifyInstance;
const cookies: Record<string, string> = {};

async function login(who: string, userId: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId } });
  cookies[who] = `fe_session=${r.cookies.find((x) => x.name === "fe_session")!.value}`;
}
async function call(who: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload: payload as object, headers: { cookie: cookies[who]! } });
  return { status: r.statusCode, body: r.json() };
}

beforeAll(async () => {
  await seed();
  app = await buildServer();
  await login("whitfield", uuidFor("hp-whitfield"));
  await login("osei", uuidFor("hp-osei"));
  await login("marsh", uuidFor("rq-marsh"));
});
afterAll(async () => { await app.close(); await closePool(); });

describe("Studio", () => {
  it("shows every configuration kind with its signed version, and the published test set passes", async () => {
    const o = await call("whitfield", "GET", "/api/studio");
    expect(o.status).toBe(200);
    const rb = o.body.find((k: { kind: string }) => k.kind === "rulebook");
    expect(rb.published.version).toBe(1);
    expect(rb.published.signedName).toMatch(/Whitfield/);
    const t = await call("whitfield", "GET", "/api/studio/tests");
    expect(t.body.passed).toBe(46);
  });

  it("refuses Studio to a coordinator", async () => {
    expect((await call("osei", "GET", "/api/studio")).status).toBe(403);
  });

  it("drafts a rulebook change, shows which test cases now disagree, and refuses to publish without a reason", async () => {
    const { body: before } = await call("marsh", "POST", "/api/requests", { text: "Started before the policy change: $20,000 for a CME course in Boston." });
    const d = await call("whitfield", "POST", "/api/studio/rulebook/drafts", { note: "Lead time 45 days" });
    expect(d.status).toBe(200);
    const draft = await call("whitfield", "GET", `/api/studio/rulebook/${d.body.version}`);
    const body = { ...draft.body.body, parameters: { ...draft.body.body.parameters, leadTimeDays: 45 } };
    expect((await call("whitfield", "PUT", `/api/studio/rulebook/${d.body.version}`, { body })).status).toBe(200);
    const v = await call("whitfield", "GET", `/api/studio/rulebook/${d.body.version}/validate`);
    expect(v.body.tests.passed).toBeLessThan(46);
    const differing = v.body.tests.results.filter((r: { ok: boolean }) => !r.ok).map((r: { id: string }) => r.id);
    expect(differing).toContain("tc-04"); // 59 days now passes the 45-day rule
    const refused = await call("whitfield", "POST", `/api/studio/rulebook/${d.body.version}/publish`, { typedName: "Jane Whitfield" });
    expect(refused.status).toBe(409);
    const ok = await call("whitfield", "POST", `/api/studio/rulebook/${d.body.version}/publish`, { typedName: "Jane Whitfield", acceptDifferences: "Lead time reduced to 45 days by SOP v5; test cases to be updated." });
    expect(ok.status).toBe(200);
    expect(ok.body.diff.summary).toMatch(/parameters changed/);
    const { body: after } = await call("marsh", "POST", "/api/requests", { text: "Started after the policy change: $20,000 for a CME course in Boston." });
    const r1 = await call("marsh", "GET", `/api/requests/${before.id}`);
    const r2 = await call("marsh", "GET", `/api/requests/${after.id}`);
    expect(r1.body.versions.rulebook).toBe(1);
    expect(r2.body.versions.rulebook).toBe(d.body.version);
  });

  it("shows the autonomy dial with person-only stages capped", async () => {
    const a = await call("whitfield", "GET", "/api/studio/autonomy");
    const committee = a.body.stages.find((s: { id: string }) => s.id === "committee");
    const agreement = a.body.stages.find((s: { id: string }) => s.id === "agreement");
    expect(committee.max).toBe(2);
    expect(agreement.level).toBe(3);
  });

  it("re-drafts the workflow from a new SOP and lists what it leaves unsaid", async () => {
    const r = await call("whitfield", "POST", "/api/studio/sop", { title: "Management of Grants and Donations SOP v5", markdown: [
      "# SOP v5", "4.1 Lead time. Requests must be submitted at least 45 days before the activity.",
      "6.2 Committee. The committee decides where appropriate, with a quorum of four.", "6.5 Single approver. Charitable contributions under a threshold may be approved by one person.",
    ].join("\n") });
    expect(r.status).toBe(200);
    expect(r.body.clauses.changed).toContain("4.1");
    expect(r.body.stageImpact.length).toBeGreaterThan(0);
    expect(r.body.questions.map((q: { clause: string }) => q.clause)).toContain("SOP 6.5");
    expect(r.body.drafts.workflow).toBeGreaterThan(1);
  });
});

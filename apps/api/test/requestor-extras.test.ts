// Endpoints the web app asked for: committee members, readiness without side effects, reusing an earlier document,
// adding a budget line, signing sides, and the greeting.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "@fe/db";
import { buildServer } from "../src/server.ts";
import { seed, uuidFor } from "../src/seed.ts";
import { Driver, runScenario } from "../src/scenario.ts";
import { greetingName } from "../src/services/assistant.ts";

process.env.FE_TODAY = "2027-04-02";
process.env.FE_ASSISTANT = "demo";
let app: FastifyInstance;
let d: Driver;
let rows: Awaited<ReturnType<typeof runScenario>>;

beforeAll(async () => {
  await seed();
  app = await buildServer();
  rows = await runScenario(app);
  d = new Driver(app);
  for (const [w, c] of [["quinlan", "rq-quinlan"], ["haddad", "hp-haddad"], ["osei", "hp-osei"]] as const) await d.login(w, c);
}, 120_000);
afterAll(async () => { await app.close(); await closePool(); });

describe("requestor and committee extras", () => {
  it("greets titled people by title and surname", () => {
    expect(greetingName("Dr. Elena Marsh")).toBe("Dr. Marsh");
    expect(greetingName("Teresa Quinlan")).toBe("Teresa");
  });

  it("lists the committee, chair first", async () => {
    const m = await d.call("osei", "GET", "/api/committee/members");
    expect(m.length).toBeGreaterThanOrEqual(4);
    expect(m[0].roles).toContain("committee-chair");
    expect(m.map((x: { id: string }) => x.id)).toContain(uuidFor("hp-lindqvist"));
  });

  it("reuses a document from the organization's earlier request, and adds a budget line", async () => {
    const r = await d.call("quinlan", "POST", "/api/requests", { text: "We'd like $3,000 for a carers' evening in September 2027." });
    const res = await d.call("quinlan", "POST", `/api/requests/${r.id}/documents/reuse`, { type: "w9" });
    expect(res.ok).toBe(true);
    await d.call("quinlan", "POST", `/api/requests/${r.id}/budget`, { addLine: { description: "Venue hire", category: "venue", amount: 1200 } });
    const v = await d.call("quinlan", "GET", `/api/requests/${r.id}`);
    expect(v.documents.map((x: { type: string }) => x.type)).toContain("w9");
    expect(v.request.budget.at(-1).description).toBe("Venue hire");
    expect(v.readiness.canSubmit).toBe(false);
    expect(v.readiness.blockers.length).toBeGreaterThan(0);
    expect(v.messages.at(-1).body).toMatch(/2027-01643-CHA/);
    const empty = await d.call("quinlan", "POST", "/api/requests", {});
    const e = await d.call("quinlan", "GET", `/api/requests/${empty.id}`);
    expect((e.messages[0].body as string).startsWith("Hello Teresa.")).toBe(true);
  });

  it("says which side a person signs for and whether they can sign now", async () => {
    const heartline = rows[2]!.id;
    const a = await d.call("haddad", "GET", `/api/requests/${heartline}/agreement`);
    expect(a.mySide).toBeTruthy();
    expect(a.canSign).toBe(false); // both sides have signed
    const q = await d.call("quinlan", "GET", `/api/requests/${heartline}/agreement`);
    expect(q.mySide).toBe("Heartline Patient Alliance");
    const b = await d.call("osei", "GET", `/api/requests/${heartline}/brief`);
    expect(b.requestor.name).toBe("Teresa Quinlan");
  });
});

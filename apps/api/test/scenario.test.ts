// The demo scenario runs cleanly on a fresh seed and leaves something real on each seat's desk.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "@fe/db";
import { buildServer } from "../src/server.ts";
import { seed } from "../src/seed.ts";
import { Driver, runScenario } from "../src/scenario.ts";

process.env.FE_TODAY = "2027-04-02";
process.env.FE_ASSISTANT = "demo";
let app: FastifyInstance;
let rows: Awaited<ReturnType<typeof runScenario>>;

beforeAll(async () => {
  await seed();
  app = await buildServer();
  rows = await runScenario(app);
}, 120_000);
afterAll(async () => { await app.close(); await closePool(); });

describe("demo scenario", () => {
  it("puts requests at review, committee, payment and intake", () => {
    expect(rows.map((r) => r.stage)).toEqual(["medical-review", "committee", "payment", "intake"]);
    expect(rows.slice(0, 3).every((r) => /^2027-\d{5}-(IME|CHA)$/.test(r.ref ?? ""))).toBe(true);
    expect(new Set(rows.map((r) => r.ref)).size).toBe(rows.length);
  });

  it("gives the medical reviewer, the committee chair and finance something to do", async () => {
    const d = new Driver(app);
    await d.login("patel", "hp-patel");
    await d.login("alvarez", "hp-alvarez");
    await d.login("kowalski", "hp-kowalski");
    await d.login("nair", "hp-nair");
    const has = async (who: string, ref: string) => {
      const desk = await d.call(who, "GET", "/api/desk");
      return [...desk.needsYou, ...desk.assistant, ...desk.waiting].some((x: { ref?: string }) => x.ref === ref);
    };
    expect(await has("alvarez", rows[1]!.ref!)).toBe(true);
    expect(await has("kowalski", rows[2]!.ref!)).toBe(true);
    expect((await d.call("nair", "GET", "/api/audit/verify")).ok).toBe(true);
  });

  it("leaves the flagship requestor free to start the live demo", async () => {
    const d = new Driver(app);
    await d.login("marsh", "rq-marsh");
    expect((await d.call("marsh", "GET", "/api/my/requests")).length ?? 0).toBe(0);
    const r = await d.call("marsh", "POST", "/api/requests", { text: "I'd like to request $50,000 for our heart failure symposium in Boston." });
    expect(r.id).toBeTruthy();
  });
});

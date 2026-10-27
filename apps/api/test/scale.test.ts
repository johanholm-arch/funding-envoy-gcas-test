// Behaviour introduced for scale: checkpointed chain verification, per-currency money in Ask, desk counts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "@fe/db";
import { buildServer } from "../src/server.ts";
import { seed } from "../src/seed.ts";
import { Driver, runScenario } from "../src/scenario.ts";
import { planQuestion } from "../src/services/ask.ts";

process.env.FE_TODAY = "2027-04-02";
process.env.FE_ASSISTANT = "demo";
let app: FastifyInstance;
let d: Driver;

beforeAll(async () => {
  await seed();
  app = await buildServer();
  await runScenario(app);
  d = new Driver(app);
  await d.login("nair", "hp-nair");
  await d.login("whitfield", "hp-whitfield");
  await d.login("osei", "hp-osei");
}, 120_000);
afterAll(async () => { await app.close(); await closePool(); });

describe("scale behaviour", () => {
  it("verifies the whole chain, records a checkpoint, then verifies from it", async () => {
    const full = await d.call("nair", "GET", "/api/audit/verify?full=1");
    expect(full.ok).toBe(true);
    expect(full.mode).toBe("full");
    expect(full.checked).toBeGreaterThan(50);
    await d.call("osei", "GET", "/api/desk"); // more activity after the checkpoint
    await d.login("osei2", "hp-osei");
    const quick = await d.call("nair", "GET", "/api/audit/verify");
    expect(quick.ok).toBe(true);
    expect(quick.mode).toBe("since-checkpoint");
    expect(quick.from.seq).toBe(full.checked);
    expect(quick.checked).toBeGreaterThan(0);
    expect(quick.checked).toBeLessThan(full.checked);
  });

  it("never adds money across currencies", async () => {
    const r = await d.call("whitfield", "POST", "/api/ask", { question: "Amount requested by country, all time" });
    expect(r.columns).toContain("Currency");
    const byCountry = new Map(r.rows.map((x: unknown[]) => [x[0], x[1]]));
    expect(byCountry.get("GB")).toBe("GBP");
    expect(byCountry.get("FR")).toBe("EUR");
  });

  it("plans periods from the demo date, defaulting to the last twelve months", () => {
    const now = new Date("2027-04-02T12:00:00Z");
    expect(planQuestion("How many requests by stage?", now)!.period!.label).toBe("last 12 months");
    expect(planQuestion("Amount paid in 2026 by country", now)!.period!.label).toBe("2026");
    expect(planQuestion("How much did we pay this year?", now)!.metric).toBe("amount_paid");
    expect(planQuestion("Approval rate, all time", now)!.period).toBeUndefined();
  });

  it("counts every pile on the desk and says how many items it shows", async () => {
    const desk = await d.call("osei", "GET", "/api/desk");
    expect(desk.counts.needsYou + desk.counts.assistant + desk.counts.waiting).toBeGreaterThanOrEqual(3);
    expect(desk.shown.needsYou).toBe(100);
    expect(desk.needsYou.length).toBeLessThanOrEqual(desk.counts.needsYou);
  });
});

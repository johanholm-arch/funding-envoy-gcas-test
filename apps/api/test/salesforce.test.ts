// The Salesforce connector against the simulated org: a funder connects, FundingEnvoy reads the org and suggests the
// mapping, the process owner publishes it, a requestor submits, and the request lands in Salesforce in the
// requestor's name at four checkpoints. The grants team then works it in Salesforce and FundingEnvoy hears back.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool, withContext } from "@fe/db";
import { buildServer } from "../src/server.ts";
import { seed } from "../src/seed.ts";
import { Driver } from "../src/scenario.ts";

process.env.FE_TODAY = "2027-04-02";
process.env.FE_ASSISTANT = "demo";
let app: FastifyInstance;
let d: Driver;
const NAME = `Corvane Pharma ${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
let funder: { id: string; slug: string };
let requestId: string;
let sfId: string;

const cookies = () => (d as unknown as { cookies: Record<string, string> }).cookies;
async function loginAs(who: string, name: string, tenantSlug?: string, tenantId?: string) {
  const people = (await app.inject({ method: "GET", url: "/api/demo/personas" })).json().people as { id: string; name: string; tenant_id: string | null }[];
  const p = people.find((x) => x.name === name && (!tenantId || x.tenant_id === tenantId))!;
  const r = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId: p.id, tenantSlug } });
  expect(r.statusCode, r.body).toBe(200);
  cookies()[who] = `fe_session=${r.cookies.find((x) => x.name === "fe_session")!.value}`;
}

beforeAll(async () => {
  await seed();
  app = await buildServer();
  d = new Driver(app);
  await d.login("brandt", "hp-brandt");
  funder = await d.call("brandt", "POST", "/api/ops/funders", { name: NAME, color: "#3D5A80", countries: ["US"], processOwnerName: "Priya Natarajan" });
  await loginAs("owner", "Priya Natarajan", undefined, funder.id);
  await loginAs("quinlan", "Teresa Quinlan", funder.slug);
}, 120_000);
afterAll(async () => {
  if (funder?.id) await withContext({ operator: true }, async (tx) => {
    await tx.query("select fe_demo_reset_tenant($1)", [funder.id]);
    await tx.query("delete from tenants where id = $1", [funder.id]);
  });
  await app.close(); await closePool();
});

describe("connecting Salesforce in Studio", () => {
  it("connects to the simulated org, and explains why a live one isn't possible yet", async () => {
    const v0 = await d.call("owner", "GET", "/api/connect/salesforce");
    expect(v0.connected).toBe(false);
    expect(v0.configSource).toBe("none");
    expect((await d.try("owner", "POST", "/api/connect/salesforce/test", { mode: "live", myDomain: v0.defaults.myDomain })).status).toBe(409);
    const t = await d.call("owner", "POST", "/api/connect/salesforce/test", { mode: "simulated", myDomain: v0.defaults.myDomain });
    expect(t.org.apiVersion).toBe("66.0");
    expect(t.identity.profile).toMatch(/API Only/);
    expect(t.limits.DailyApiRequests.Max).toBeGreaterThan(100000);
  });

  it("reads the org and suggests how FundingEnvoy's fields and values match it", async () => {
    const r = await d.call("owner", "POST", "/api/connect/salesforce/read", {});
    expect(r.objects.map((o: { name: string }) => o.name)).toContain("gx__Request__c");
    expect(r.validationRules.length).toBe(4);
    const v = await d.call("owner", "GET", "/api/connect/salesforce");
    expect(v.configSource).toBe("suggested");
    const map = Object.fromEntries(v.config.fields.map((m: { fe: string; sf: string }) => [m.fe, m.sf]));
    expect(map).toMatchObject({
      title: "Name", "amount.requested": "gx__Requested_Amount__c", "amount.currency": "CurrencyIsoCode", "request.subtype": "gx__Grant_Type__c",
      "activity.startDate": "gx__Start_Date_Time__c", "activity.endDate": "gx__End_Date_Time__c", "audience.geography": "gx__Geographic_Coverage__c",
    });
    expect(v.config.values.gx__Grant_Type__c).toMatchObject({ "ime-accredited": "IME - Accredited", "ime-non-accredited": "IME - Non-Accredited" });
    expect(v.config.values.gx__Geographic_Coverage__c["mainly-us"]).toBe("Mainly US");
    expect(v.config.documents).toMatchObject({ budget: "Budget", w9: "W-9", "coi-policy": "Conflict of Interest Policy" });
    expect(v.issues.filter((i: { severity: string }) => i.severity === "error")).toEqual([]);
  });

  it("refuses a mapping that leaves out a field Salesforce requires", async () => {
    const v = await d.call("owner", "GET", "/api/connect/salesforce");
    const broken = { ...v.config, fields: v.config.fields.filter((m: { sf: string }) => m.sf !== "gx__Requested_Amount__c") };
    const trial = await d.call("owner", "POST", "/api/connect/salesforce/trial", { config: broken });
    expect(trial.ok).toBe(false);
    expect(trial.result.errors[0].errorCode).toBe("REQUIRED_FIELD_MISSING");
  });

  it("saves, tries and publishes the mapping with the process owner's signature", async () => {
    const v = await d.call("owner", "GET", "/api/connect/salesforce");
    const saved = await d.call("owner", "POST", "/api/connect/salesforce/config", { config: v.config });
    const trial = await d.call("owner", "POST", "/api/connect/salesforce/trial", {});
    expect(trial.ok, JSON.stringify(trial.result)).toBe(true);
    const sim = await d.call("owner", "GET", "/api/salesforce-sim");
    expect(sim.requests.length).toBe(0); // the trial record was taken out again
    const check = await d.call("owner", "GET", `/api/studio/connector/${saved.version}/validate`);
    expect(check.issues.filter((i: { severity: string }) => i.severity === "error")).toEqual([]);
    await d.call("owner", "POST", `/api/studio/connector/${saved.version}/publish`, { typedName: "Priya Natarajan" });
    const me = await d.call("owner", "GET", "/api/me");
    expect(me.tenant.connections.salesforce).toMatchObject({ mode: "simulated", enabled: true });
  });
});

describe("a request written to Salesforce", () => {
  it("submits in the requestor's name at four checkpoints, and leaves FundingEnvoy's desk alone", async () => {
    const r = await d.call("quinlan", "POST", "/api/requests", { text: "Heartline would like to ask for $4,500 for our peer support groups for people living with heart failure." });
    requestId = r.id;
    await d.upload("quinlan", r.id, "heartline", ["Heartline_Request_Letter.md", "Heartline_Programme_Description.md", "Heartline_Budget.csv", "Heartline_Nonprofit_Letter_2019.md", "Heartline_W9_2026.md", "Heartline_Annual_Report_2025.md"]);
    const s = await d.prepareAndSubmit("quinlan", r.id, { subtype: "charitable-contribution", typedName: "Teresa Quinlan", flagNote: "Groups run year-round." });
    expect(s.blockers ?? []).toEqual([]);
    const v = await d.call("quinlan", "GET", `/api/requests/${r.id}`);
    expect(v.request.status).toBe("with-salesforce");
    expect(v.request.external).toMatchObject({ system: "salesforce", simulated: true, status: "Submitted for Review" });
    sfId = v.request.external.recordId;
    const sim = await d.call("owner", "GET", "/api/salesforce-sim");
    const rec = sim.requests.find((x: { id: string }) => x.id === sfId);
    expect(rec.fields).toMatchObject({ gx__Status__c: "Submitted for Review", gx__Grant_Type__c: "Charitable Contribution - General", gx__Requested_Amount__c: 4500, CurrencyIsoCode: "USD", FundingEnvoy_Request_Id__c: r.id });
    expect(rec.fields.gx__Review_Summary__c).toMatch(/Pre-submission review summary/);
    expect(rec.createdBy).toMatchObject({ name: "Teresa Quinlan", via: "portal" });
    expect(rec.files.length).toBeGreaterThanOrEqual(5);
    expect(rec.files.map((f: { fields: { gx__Category__c: string } }) => f.fields.gx__Category__c)).toContain("W-9");
    expect(rec.account).toMatch(/Heartline/);
    const trail = await d.call("owner", "GET", `/api/requests/${r.id}/trail`);
    const steps = (trail.events ?? trail).filter((e: { action: string }) => e.action === "connector.salesforce.checkpoint").map((e: { data: { step: string } }) => e.data.step);
    expect(steps).toEqual(["organization", "draft", "documents", "submit"]);
  });

  it("turns a coordinator's question in Salesforce into a task for the requestor, and sends the answer back", async () => {
    const q = "Please confirm how many peer support groups run each month.";
    const drained = await d.call("owner", "POST", `/api/salesforce-sim/requests/${sfId}/act`, { action: "request-info", text: q });
    expect(drained.processed).toBeGreaterThanOrEqual(1);
    let v = await d.call("quinlan", "GET", `/api/requests/${requestId}`);
    expect(v.request.status).toBe("info-requested");
    const ir = v.request.infoRequests.at(-1);
    expect(ir.questions[0].text).toBe(q);
    await d.call("quinlan", "POST", `/api/requests/${requestId}/info/${ir.id}`, { answers: [{ questionId: ir.questions[0].id, answer: "Twelve groups meet each month, in four cities." }] });
    v = await d.call("quinlan", "GET", `/api/requests/${requestId}`);
    expect(v.request.status).toBe("with-salesforce");
    const sim = await d.call("owner", "GET", "/api/salesforce-sim");
    const rec = sim.requests.find((x: { id: string }) => x.id === sfId);
    expect(rec.fields.gx__Status__c).toBe("Submitted for Review");
    expect(rec.comments.at(-1).fields.gx__Body__c).toMatch(/Twelve groups meet each month/);
    expect(rec.comments.at(-1).createdBy.via).toBe("portal");
  });

  it("records the decision made in Salesforce, and the trail still verifies", async () => {
    await d.call("owner", "POST", `/api/salesforce-sim/requests/${sfId}/act`, { action: "approve", amount: 4000 });
    const v = await d.call("quinlan", "GET", `/api/requests/${requestId}`);
    expect(v.request.status).toBe("approved");
    expect(v.request.decision).toMatchObject({ outcome: "approve", amount: 4000 });
    expect(v.request.decision.by.name).toMatch(/Priya Natarajan \(in Salesforce\)/);
    const sim = await d.call("owner", "GET", "/api/salesforce-sim");
    expect(sim.events.every((e: { processed: boolean }) => e.processed)).toBe(true);
    expect((await d.call("owner", "GET", "/api/audit/verify")).ok).toBe(true);
  });
});

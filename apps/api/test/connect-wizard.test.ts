// The Connect wizard against a stand-in org shaped like the IQVIA demo org: grant requests live in OCE__Meeting__c,
// labelled "Request", among many other objects. FundingEnvoy should find it, read it, suggest the matches, and ask
// only what it can't work out: here, which Subtype each grant type is, and which status means "more information".
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool, withContext } from "@fe/db";
import { buildServer } from "../src/server.ts";
import { seed } from "../src/seed.ts";
import { Driver } from "../src/scenario.ts";

process.env.FE_TODAY = "2027-04-02";
process.env.FE_ASSISTANT = "demo";
const KEY = "3MVG9wizard_consumer_key_for_tests_0123456789";
const SECRET = "wizard-secret-value";
let app: FastifyInstance;
let sf: Server;
let d: Driver;
let funder: { id: string };
const cookies = () => (d as unknown as { cookies: Record<string, string> }).cookies;

const f = (name: string, label: string, type: string, more: Record<string, unknown> = {}) => ({ name, label, type, nillable: true, createable: true, defaultedOnCreate: false, externalId: false, ...more });
const pick = (values: string[]) => ({ picklistValues: values.map((value) => ({ value, active: true })) });
const OBJECTS: Record<string, { label: string; custom: boolean; fields: ReturnType<typeof f>[]; count: number }> = {
  Account: { label: "Account", custom: false, count: 900, fields: [f("Id", "Account ID", "id", { createable: false }), f("Name", "Account Name", "string", { nillable: false }), f("BillingCountry", "Billing Country", "string"), f("OCE__TaxId__c", "Tax ID", "string")] },
  ContentVersion: { label: "Content Version", custom: false, count: 50, fields: [f("Id", "ID", "id", { createable: false }), f("Title", "Title", "string")] },
  OCE__Meeting__c: { label: "Request", custom: true, count: 14, fields: [
    f("Id", "Record ID", "id", { createable: false }),
    f("Name", "Title", "string", { nillable: false }),
    f("OCE__Subtype__c", "Subtype", "picklist", { nillable: false, ...pick(["Speaker Program", "Medical Education Grant", "Charitable Donation", "Sponsorship"]) }),
    f("OCE__StartDateTime__c", "Start Date/Time", "datetime", { nillable: false }),
    f("OCE__EndDateTime__c", "End Date/Time", "datetime", { nillable: false }),
    f("OCE__Status__c", "Status", "picklist", pick(["Draft", "Ready for Review", "Approved", "Rejected", "Cancelled"])),
    f("OCE__DeliveryFormat__c", "Delivery Format", "picklist", pick(["In Person", "Virtual", "Hybrid", "Enduring"])),
    f("OCE__AttendeeCount__c", "Attendee Count", "int"),
    f("OCE__Account__c", "Organization", "reference", { referenceTo: ["Account"] }),
    f("OCE__Comments__c", "Comments", "textarea"),
    f("OCE__FBServedBy__c", "F&B Served by", "picklist", pick(["Venue", "Caterer"])),
  ] },
  OCE__MeetingExpense__c: { label: "Request Expense", custom: true, count: 30, fields: [f("Id", "ID", "id", { createable: false }), f("OCE__Amount__c", "Amount", "currency")] },
  OCE__CallSampleRequest__c: { label: "Call Sample Request", custom: true, count: 5, fields: [f("Id", "ID", "id", { createable: false }), f("OCE__Quantity__c", "Quantity", "int")] },
  ENGAGE__ApplicationSettings__c: { label: "Application Settings", custom: true, count: 1, fields: [f("Id", "ID", "id", { createable: false })] },
  OCE__Speaker__c: { label: "Speaker", custom: true, count: 40, fields: [f("Id", "ID", "id", { createable: false })] },
};

function standIn(): Promise<number> {
  sf = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url!, "http://x");
    const json = (s: number, j: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (url.pathname === "/services/oauth2/token") return new URLSearchParams(body).get("client_secret") === SECRET ? json(200, { access_token: "tok", instance_url: "https://gfms--demo.my.salesforce.com" }) : json(400, { error: "invalid_client", error_description: "invalid client credentials" });
    if (url.pathname.endsWith("/userinfo")) return json(200, { preferred_username: "admin@gfms.demo" });
    if (url.pathname.endsWith("/limits")) return json(200, { DailyApiRequests: { Max: 115000, Remaining: 114000 } });
    if (url.pathname.endsWith("/tooling/query")) return json(200, { records: [{ ValidationName: "End_After_Start", Description: "", ErrorMessage: "End must be after start.", EntityDefinition: { QualifiedApiName: "OCE__Meeting__c" } }] });
    if (url.pathname.endsWith("/query")) {
      const q = url.searchParams.get("q") ?? "";
      const m = /SELECT COUNT\(\) FROM (\S+)/.exec(q);
      if (m) return json(200, { totalSize: OBJECTS[m[1]!]?.count ?? 0, records: [] });
      return json(200, { records: [{ Id: "00D", Name: "GFMS Sales Demo", OrganizationType: "Enterprise Edition", IsSandbox: false }] });
    }
    if (url.pathname.endsWith("/sobjects")) return json(200, { sobjects: Object.entries(OBJECTS).map(([name, o]) => ({ name, label: o.label, custom: o.custom, queryable: true, createable: true })) });
    const m = /\/sobjects\/([^/]+)\/describe$/.exec(url.pathname);
    if (m && OBJECTS[m[1]!]) return json(200, { name: m[1], label: OBJECTS[m[1]!]!.label, fields: OBJECTS[m[1]!]!.fields });
    json(404, [{ errorCode: "NOT_FOUND", message: "not found" }]);
  });
  return new Promise((r) => sf.listen(0, "127.0.0.1", () => r((sf.address() as { port: number }).port)));
}

beforeAll(async () => {
  process.env.FE_SALESFORCE_TEST_BASE = `http://127.0.0.1:${await standIn()}`;
  await seed();
  app = await buildServer();
  d = new Driver(app);
  await d.login("brandt", "hp-brandt");
  funder = await d.call("brandt", "POST", "/api/ops/funders", { name: `Wizard Pharma ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, color: "#33415C", countries: ["US"], processOwnerName: "Mira Solberg" });
  const people = (await app.inject({ method: "GET", url: "/api/demo/personas" })).json().people as { id: string; name: string; tenant_id: string }[];
  const r = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId: people.find((p) => p.name === "Mira Solberg" && p.tenant_id === funder.id)!.id } });
  cookies().owner = `fe_session=${r.cookies.find((x) => x.name === "fe_session")!.value}`;
}, 120_000);
afterAll(async () => {
  if (funder?.id) await withContext({ operator: true }, async (tx) => {
    await tx.query("select fe_demo_reset_tenant($1)", [funder.id]);
    await tx.query("delete from tenants where id = $1", [funder.id]);
  });
  delete process.env.FE_SALESFORCE_TEST_BASE;
  await app.close(); await closePool(); sf.close();
});

describe("the Connect wizard, with a company's org", () => {
  it("step 1: connects", async () => {
    await d.call("owner", "POST", "/api/connect/salesforce/live/credentials", { myDomain: "gfms--demo.my.salesforce.com", clientId: KEY, clientSecret: SECRET });
    const t = await d.call("owner", "POST", "/api/connect/salesforce/live/test");
    expect(t.org.name).toBe("GFMS Sales Demo");
    const w = await d.call("owner", "GET", "/api/connect/salesforce/wizard");
    expect(w.company).toMatchObject({ myDomain: "gfms--demo.my.salesforce.com", lastTest: { ok: true } });
    expect(w.company.requestObject).toBeUndefined();
  });

  it("step 2: finds where grant requests live, in plain words, and can search by name", async () => {
    const r = await d.call("owner", "POST", "/api/connect/salesforce/live/find");
    expect(r.candidates[0]).toMatchObject({ name: "OCE__Meeting__c", label: "Request", records: 14 });
    expect(r.candidates[0].signals).toEqual(expect.arrayContaining(["a title", "start and end dates", "a status", "a type", "a link to an organization"]));
    expect(r.candidates.map((c: { name: string }) => c.name)).not.toContain("ENGAGE__ApplicationSettings__c");
    const s = await d.call("owner", "GET", "/api/connect/salesforce/live/search?q=meet");
    expect(s.results.map((x: { name: string }) => x.name)).toContain("OCE__Meeting__c");
    const c = await d.call("owner", "POST", "/api/connect/salesforce/live/choose", { name: "OCE__Meeting__c" });
    expect(c.requestObject).toEqual({ name: "OCE__Meeting__c", label: "Request" });
  });

  it("step 3: matches what it can, and asks only what it can't", async () => {
    const m = await d.call("owner", "GET", "/api/connect/salesforce/mapping?mode=live");
    const map = Object.fromEntries(m.config.fields.map((x: { fe: string; sf: string }) => [x.fe, x.sf]));
    expect(map).toMatchObject({ title: "Name", "activity.startDate": "OCE__StartDateTime__c", "activity.endDate": "OCE__EndDateTime__c", "activity.format": "OCE__DeliveryFormat__c", "audience.expected": "OCE__AttendeeCount__c", "request.subtype": "OCE__Subtype__c" });
    expect(m.config.systemFields).toMatchObject({ requestOrganization: "OCE__Account__c", requestStatus: "OCE__Status__c" });
    expect(m.config.statusValues).toMatchObject({ draft: "Draft", submitted: "Ready for Review", approved: "Approved", declined: "Rejected", closed: "Cancelled" });
    expect(m.config.values.OCE__DeliveryFormat__c["in-person"]).toBe("In Person");
    const ids = m.needs.map((n: { id: string }) => n.id);
    expect(ids).toContain("statuses"); // nothing means "more information requested"
    expect(m.needs.find((n: { id: string }) => n.id === "statuses").rows.map((r: { key: string }) => r.key)).toEqual(["infoRequested"]);
    expect(ids).toContain("external-id");
    const subtype = m.needs.find((n: { id: string }) => n.id === "values-OCE__Subtype__c");
    expect(subtype.options.map((o: { value: string }) => o.value)).toContain("Medical Education Grant");
    expect(subtype.rows.find((r: { key: string }) => r.key === "ime-accredited").current).toBe("Medical Education Grant"); // its guess, to confirm
    // Answer the questions: every grant type becomes a Subtype; "Draft" stands in for "more information".
    const values = { ...m.config.values, OCE__Subtype__c: { "ime-accredited": "Medical Education Grant", "ime-non-accredited": "Medical Education Grant", "charitable-contribution": "Charitable Donation" } };
    const saved = await d.call("owner", "POST", "/api/connect/salesforce/mapping", { mode: "live", config: { ...m.config, values, statusValues: { ...m.config.statusValues, infoRequested: "Draft" }, confirmed: ["values-OCE__Subtype__c"] } });
    expect(saved.saved.by).toBe("Mira Solberg");
    expect(saved.needs.map((n: { id: string }) => n.id)).toEqual(["external-id"]);
    // Saving a company org's mapping never puts a draft in the way of publishing the rest of the setup.
    const setup = await d.call("owner", "GET", "/api/studio/setup");
    expect(setup.drafts.map((x: { kind: string }) => x.kind)).not.toContain("connector");
  });

  it("choosing a different object starts the matching again", async () => {
    await d.call("owner", "POST", "/api/connect/salesforce/live/choose", { name: "OCE__MeetingExpense__c" });
    const w = await d.call("owner", "GET", "/api/connect/salesforce/wizard");
    expect(w.company.requestObject.name).toBe("OCE__MeetingExpense__c");
    expect(w.company.mappingSaved).toBeUndefined();
    expect((await d.try("owner", "POST", "/api/connect/salesforce/live/choose", { name: "No_Such__c" })).status).toBe(409);
  });
});

describe("the Connect wizard, with the practice org", () => {
  it("connects in one click and asks only to confirm the grant types, already filled in", async () => {
    await d.call("owner", "POST", "/api/connect/salesforce/practice/connect");
    const m = await d.call("owner", "GET", "/api/connect/salesforce/mapping?mode=simulated");
    expect(m.requestObject.name).toBe("gx__Request__c");
    expect(m.needs.map((n: { id: string }) => n.id).sort()).toEqual(["values-gx__Grant_Family__c", "values-gx__Grant_Type__c"]);
    expect(m.needs.every((n: { rows: { current: string }[] }) => n.rows.every((r) => r.current))).toBe(true);
    expect(m.matched.length).toBeGreaterThan(10);
    // Saving without confirming keeps the check open; confirming both closes it.
    const unconfirmed = await d.call("owner", "POST", "/api/connect/salesforce/mapping", { mode: "simulated", config: m.config });
    expect(unconfirmed.needs.length).toBe(2);
    const saved = await d.call("owner", "POST", "/api/connect/salesforce/mapping", { mode: "simulated", config: { ...m.config, confirmed: ["values-gx__Grant_Type__c", "values-gx__Grant_Family__c"] } });
    expect(saved.needs).toEqual([]);
  });
});

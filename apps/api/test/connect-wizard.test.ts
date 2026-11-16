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
const OBJECTS: Record<string, { label: string; custom: boolean; fields: ReturnType<typeof f>[]; count: number; children?: { childSObject: string; field: string; relationshipName: string | null }[]; types?: string[] }> = {
  Account: { label: "Account", custom: false, count: 900, fields: [f("Id", "Account ID", "id", { createable: false }), f("Name", "Account Name", "string", { nillable: false }), f("BillingCountry", "Billing Country", "string"), f("OCE__TaxId__c", "Tax ID", "string")] },
  ContentVersion: { label: "Content Version", custom: false, count: 50, fields: [f("Id", "ID", "id", { createable: false }), f("Title", "Title", "string")] },
  OCE__Meeting__c: { label: "Request", custom: true, count: 14, types: ["Speaker_Program", "Medical_Education_Grant"], children: [
    { childSObject: "OCE__MeetingDetail__c", field: "OCE__Meeting__c", relationshipName: "OCE__MeetingDetails__r" },
    { childSObject: "OCE__MeetingExpense__c", field: "OCE__Meeting__c", relationshipName: "OCE__MeetingExpenses__r" },
    { childSObject: "OCE__MeetingAttendee__c", field: "OCE__Meeting__c", relationshipName: "OCE__Attendees__r" },
    { childSObject: "ContentDocumentLink", field: "LinkedEntityId", relationshipName: "ContentDocumentLinks" },
    { childSObject: "Task", field: "WhatId", relationshipName: "Tasks" },
    { childSObject: "OCE__Meeting__History", field: "ParentId", relationshipName: "Histories" },
  ], fields: [
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
  OCE__MeetingDetail__c: { label: "Request Detail", custom: true, count: 20, fields: [f("Id", "ID", "id", { createable: false })] },
  OCE__MeetingAttendee__c: { label: "Request Attendee", custom: true, count: 0, fields: [f("Id", "ID", "id", { createable: false })] },
  OCE__MeetingExpenseBudgetAllocation__c: { label: "Request Expense Budget Allocation", custom: true, count: 12, fields: [f("Id", "ID", "id", { createable: false })] },
  Task: { label: "Task", custom: false, count: 99, fields: [f("Id", "ID", "id", { createable: false })] },
  ContentDocumentLink: { label: "Content Document Link", custom: false, count: 5, fields: [f("Id", "ID", "id", { createable: false })] },
  OCE__MeetingExpense__c: { label: "Request Expense", custom: true, count: 30, children: [{ childSObject: "OCE__MeetingExpenseBudgetAllocation__c", field: "OCE__MeetingExpense__c", relationshipName: "OCE__Allocations__r" }], fields: [f("Id", "ID", "id", { createable: false }), f("OCE__Amount__c", "Amount", "currency")] },
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
      const g = /COUNT\(Id\) n FROM (\S+)/.exec(q);
      if (g?.[1] === "OCE__Meeting__c") return json(200, { totalSize: 2, records: [{ dn: "Speaker_Program", n: 9 }, { dn: "Medical_Education_Grant", n: 5 }] });
      if (g?.[1] === "OCE__MeetingDetail__c") return json(200, { totalSize: 1, records: [{ dn: "Medical_Education_Grant", n: 20 }] });
      if (g) return json(200, { totalSize: 2, records: [{ dn: "Speaker_Program", n: 25 }, { dn: "Medical_Education_Grant", n: 5 }] });
      return json(200, { records: [{ Id: "00D", Name: "GFMS Sales Demo", OrganizationType: "Enterprise Edition", IsSandbox: false }] });
    }
    if (url.pathname.endsWith("/sobjects")) return json(200, { sobjects: Object.entries(OBJECTS).map(([name, o]) => ({ name, label: o.label, custom: o.custom, queryable: true, createable: true })) });
    if (url.pathname.endsWith("/OCE__Meeting__c/describe/layouts")) {
      const fld = (n: string) => OBJECTS.OCE__Meeting__c!.fields.find((x) => x.name === n)!;
      const item = (n: string, required = false) => ({ label: fld(n).label, required, editableForNew: true, placeholder: false, layoutComponents: [{ type: "Field", value: n, details: fld(n) }] });
      const layout = (id: string, extra: unknown[]) => ({ id, relatedLists: [{ label: "Request Expenses", sobject: "OCE__MeetingExpense__c" }, { label: "Request Details", sobject: "OCE__MeetingDetail__c" }], editLayoutSections: [
        { heading: "Information", useHeading: true, layoutRows: [{ layoutItems: [item("Name", true), item("OCE__Subtype__c", true)] }, { layoutItems: [item("OCE__StartDateTime__c", true), item("OCE__EndDateTime__c", true)] }, { layoutItems: [{ label: "", placeholder: true, editableForNew: false, layoutComponents: [] }] }] },
        { heading: "Program", useHeading: true, layoutRows: [{ layoutItems: extra }] },
        { heading: "System Information", useHeading: true, layoutRows: [{ layoutItems: [{ label: "Created By", editableForNew: false, layoutComponents: [{ type: "Field", value: "CreatedById", details: f("CreatedById", "Created By", "reference") }] }] }] },
      ] });
      return json(200, {
        layouts: [layout("00hSP", [item("OCE__FBServedBy__c"), item("OCE__AttendeeCount__c")]), layout("00hMEG", [item("OCE__DeliveryFormat__c"), item("OCE__AttendeeCount__c"), item("OCE__Comments__c"), item("OCE__Status__c")])],
        recordTypeMappings: [
          { recordTypeId: "012M", name: "Master", developerName: "Master", layoutId: "00hSP", master: true, available: true },
          { recordTypeId: "012SP", name: "Speaker Program", developerName: "Speaker_Program", layoutId: "00hSP", available: true, picklistsForRecordType: [{ picklistName: "OCE__Subtype__c", picklistValues: [{ value: "Speaker Program", active: true }] }] },
          { recordTypeId: "012MEG", name: "Medical Education Grant", developerName: "Medical_Education_Grant", layoutId: "00hMEG", available: true, picklistsForRecordType: [{ picklistName: "OCE__Subtype__c", picklistValues: [{ value: "Medical Education Grant", active: true }, { value: "Retired", active: false }] }] },
        ],
      });
    }
    const m = /\/sobjects\/([^/]+)\/describe$/.exec(url.pathname);
    if (m && OBJECTS[m[1]!]) {
      const o = OBJECTS[m[1]!]!;
      return json(200, { name: m[1], label: o.label, fields: o.fields, childRelationships: o.children ?? [],
        recordTypeInfos: [{ name: "Master", developerName: "Master", master: true, active: true, available: true }, ...(o.types ?? []).map((t) => ({ name: t.replace(/_/g, " "), developerName: t, master: false, active: true, available: true }))] });
    }
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

  it("step 2: reads a request as a family of records: its request types, its children and theirs", async () => {
    const { map, parts } = await d.call("owner", "GET", "/api/connect/salesforce/live/request-map");
    expect(map.root).toMatchObject({ name: "OCE__Meeting__c", label: "Request", records: 14 });
    expect(map.root.types).toEqual([{ name: "Speaker Program", developerName: "Speaker_Program", records: 9 }, { name: "Medical Education Grant", developerName: "Medical_Education_Grant", records: 5 }]);
    // Children, most used first; system children (tasks, history, files links) are left out.
    expect(map.children.map((x: { name: string }) => x.name)).toEqual(["OCE__MeetingExpense__c", "OCE__MeetingDetail__c", "OCE__MeetingAttendee__c"]);
    expect(map.children[1]).toMatchObject({ label: "Request Detail", records: 20, byType: { Medical_Education_Grant: 20 } });
    expect(map.children[0].children[0]).toMatchObject({ name: "OCE__MeetingExpenseBudgetAllocation__c", label: "Request Expense Budget Allocation", records: 12 });
    expect(map.documents).toBe(true);
    expect(map.links.map((l: { object: string }) => l.object)).toContain("Account");
    // Parts with records are ticked to begin with; an empty one is not.
    expect(parts.sort()).toEqual(["OCE__MeetingDetail__c", "OCE__MeetingExpenseBudgetAllocation__c", "OCE__MeetingExpense__c"]);
    const saved = await d.call("owner", "POST", "/api/connect/salesforce/live/request-parts", { parts: ["OCE__MeetingDetail__c", "Not_A_Part__c"] });
    expect(saved.parts).toEqual(["OCE__MeetingDetail__c"]);
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

  it("reads the family on its own when the object was chosen before families were read", async () => {
    await withContext({ operator: true }, (tx) => tx.query("update connector_credentials set request_map = null where tenant_id = $1", [funder.id]));
    const { map } = await d.call("owner", "GET", "/api/connect/salesforce/live/request-map");
    expect(map.root.name).toBe("OCE__Meeting__c");
  });

  it("steps 3 and 4: shows each request type's own form, read from Salesforce, with nothing to match", async () => {
    const v = await d.call("owner", "GET", "/api/connect/salesforce/live/forms");
    expect(v.object).toEqual({ name: "OCE__Meeting__c", label: "Request" });
    // Types whose names suggest grants start ticked.
    expect(v.types).toEqual([{ name: "Speaker Program", developerName: "Speaker_Program", records: 9, grant: false }, { name: "Medical Education Grant", developerName: "Medical_Education_Grant", records: 5, grant: true }]);
    const meg = v.forms.Medical_Education_Grant;
    expect(meg.sections.map((x: { heading: string }) => x.heading)).toEqual(["Information", "Program"]); // nothing editable in System Information
    expect(meg.sections[0].fields.map((x: { label: string; required: boolean }) => `${x.label}${x.required ? "*" : ""}`)).toEqual(["Title*", "Subtype*", "Start Date/Time*", "End Date/Time*"]);
    expect(meg.sections[0].fields[1].picklist).toEqual(["Medical Education Grant"]); // this type's own values; inactive ones left out
    expect(meg.sections[1].fields.map((x: { name: string }) => x.name)).toEqual(["OCE__DeliveryFormat__c", "OCE__AttendeeCount__c", "OCE__Comments__c", "OCE__Status__c"]);
    expect(v.excluded.Medical_Education_Grant).toEqual(["OCE__Status__c"]); // the grants team sets the status, not the requestor
    expect(v.forms.Speaker_Program.sections[1].fields.map((x: { name: string }) => x.name)).toContain("OCE__FBServedBy__c");
    expect(meg.lists.map((l: { label: string }) => l.label)).toEqual(["Request Expenses", "Request Details"]);
    const g = await d.call("owner", "POST", "/api/connect/salesforce/live/grant-types", { types: ["Medical_Education_Grant", "Speaker_Program", "Bogus"] });
    expect(g.types.filter((t: { grant: boolean }) => t.grant).map((t: { developerName: string }) => t.developerName)).toEqual(["Speaker_Program", "Medical_Education_Grant"]);
    // Required fields can't be left out; others can.
    const x = await d.call("owner", "POST", "/api/connect/salesforce/live/form-excluded", { type: "Medical_Education_Grant", fields: ["OCE__Comments__c", "Name"] });
    expect(x.excluded.Medical_Education_Grant).toEqual(["OCE__Comments__c"]); // replaces the default, Status included, as the person chose
    const w = await d.call("owner", "GET", "/api/connect/salesforce/wizard");
    expect(w.company.grantTypes.sort()).toEqual(["Medical_Education_Grant", "Speaker_Program"]);
  });

  it("choosing a different object starts the matching again", async () => {
    await d.call("owner", "POST", "/api/connect/salesforce/live/choose", { name: "OCE__MeetingExpense__c" });
    const w = await d.call("owner", "GET", "/api/connect/salesforce/wizard");
    expect(w.company.requestObject.name).toBe("OCE__MeetingExpense__c");
    expect(w.company.mappingSaved).toBeUndefined();
    expect(w.company.grantTypes).toBeUndefined();
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

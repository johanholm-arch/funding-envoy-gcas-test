// The read-only connection to a real Salesforce org, against a stand-in server that answers like Salesforce:
// the client credentials sign-in (and its errors), userinfo, the Organization query, limits, describe and the
// Tooling API. Checks that the secret is stored encrypted and never returned, and that only Salesforce addresses
// are accepted.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool, withContext } from "@fe/db";
import { buildServer } from "../src/server.ts";
import { seed } from "../src/seed.ts";
import { Driver } from "../src/scenario.ts";

process.env.FE_TODAY = "2027-04-02";
process.env.FE_ASSISTANT = "demo";
const KEY = "3MVG9fake_consumer_key_for_tests_0123456789";
const SECRET = "C0FFEE-very-secret-value";
let app: FastifyInstance;
let sf: Server;
let d: Driver;
let funder: { id: string };
const seen: string[] = [];
const cookies = () => (d as unknown as { cookies: Record<string, string> }).cookies;

function standIn(): Promise<number> {
  sf = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url!, "http://x");
    seen.push(`${req.method} ${url.pathname}`);
    const json = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (url.pathname === "/services/oauth2/token") {
      const f = new URLSearchParams(body);
      if (f.get("grant_type") !== "client_credentials") return json(400, { error: "unsupported_grant_type", error_description: "grant type not supported" });
      if (f.get("client_id") !== KEY) return json(400, { error: "invalid_client_id", error_description: "client identifier invalid" });
      if (f.get("client_secret") === "no-run-as") return json(400, { error: "invalid_grant", error_description: "no client credentials user enabled" });
      if (f.get("client_secret") !== SECRET) return json(400, { error: "invalid_client", error_description: "invalid client credentials" });
      return json(200, { access_token: "00Dfake!token", instance_url: "https://acme--test.sandbox.my.salesforce.com", token_type: "Bearer", issued_at: "1793900000000" });
    }
    if (req.headers.authorization !== "Bearer 00Dfake!token") return json(401, [{ errorCode: "INVALID_SESSION_ID", message: "Session expired or invalid" }]);
    if (url.pathname === "/services/oauth2/userinfo") return json(200, { preferred_username: "integration@acme.test", name: "FundingEnvoy Integration", organization_id: "00D5g000000FAKE" });
    if (url.pathname.endsWith("/limits")) return json(200, { DailyApiRequests: { Max: 115000, Remaining: 114980 } });
    if (url.pathname.endsWith("/tooling/query")) return json(200, { totalSize: 1, records: [{ ValidationName: "Amount_Positive", Description: "Amount above zero", ErrorMessage: "Requested amount must be positive.", ErrorDisplayField: "Amount__c", EntityDefinition: { QualifiedApiName: "acme__Grant_Request__c" } }] });
    if (url.pathname.endsWith("/query")) return json(200, { totalSize: 1, records: [{ Id: "00D5g000000FAKE", Name: "Acme Pharma (test)", OrganizationType: "Enterprise Edition", IsSandbox: true, InstanceName: "USA123S" }] });
    if (url.pathname.endsWith("/sobjects")) return json(200, { sobjects: [
      { name: "Account", label: "Account", custom: false, queryable: true, createable: true },
      { name: "ContentVersion", label: "Content Version", custom: false, queryable: true, createable: true },
      { name: "acme__Grant_Request__c", label: "Grant Request", custom: true, queryable: true, createable: true },
      { name: "acme__Invoice__c", label: "Invoice", custom: true, queryable: true, createable: true },
    ] });
    const m = /\/sobjects\/([^/]+)\/describe$/.exec(url.pathname);
    if (m) return json(200, { name: m[1], label: m[1], fields: [
      { name: "Id", label: "Record ID", type: "id", nillable: false, createable: false, defaultedOnCreate: true, externalId: false },
      { name: "Name", label: "Name", type: "string", length: 80, nillable: false, createable: true, defaultedOnCreate: false, externalId: false },
      { name: "Status__c", label: "Status", type: "picklist", nillable: true, createable: true, defaultedOnCreate: false, externalId: false, picklistValues: [{ value: "Draft", active: true }, { value: "Old", active: false }] },
    ] });
    json(404, [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }]);
  });
  return new Promise((r) => sf.listen(0, "127.0.0.1", () => r((sf.address() as { port: number }).port)));
}

beforeAll(async () => {
  process.env.FE_SALESFORCE_TEST_BASE = `http://127.0.0.1:${await standIn()}`;
  await seed();
  app = await buildServer();
  d = new Driver(app);
  await d.login("brandt", "hp-brandt");
  funder = await d.call("brandt", "POST", "/api/ops/funders", { name: `Acme Pharma ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, color: "#2E4057", countries: ["US"], processOwnerName: "Lena Okoro" });
  const people = (await app.inject({ method: "GET", url: "/api/demo/personas" })).json().people as { id: string; name: string; tenant_id: string }[];
  const r = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId: people.find((p) => p.name === "Lena Okoro" && p.tenant_id === funder.id)!.id } });
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

describe("a real Salesforce org, read-only", () => {
  it("accepts only Salesforce My Domain addresses", async () => {
    for (const bad of ["evil.example.com", "acme.my.salesforce.com.evil.com", "login.salesforce.com", "http://169.254.169.254/latest"]) {
      const r = await d.try("owner", "POST", "/api/connect/salesforce/live/credentials", { myDomain: bad, clientId: KEY, clientSecret: SECRET });
      expect(r.status, bad).toBe(400);
    }
  });

  it("stores the secret encrypted and never shows it again", async () => {
    const r = await d.call("owner", "POST", "/api/connect/salesforce/live/credentials", { myDomain: "https://acme--test.sandbox.my.salesforce.com/", clientId: KEY, clientSecret: SECRET });
    expect(r).toEqual({ myDomain: "acme--test.sandbox.my.salesforce.com", clientIdHint: "…456789" });
    const v = await app.inject({ method: "GET", url: "/api/connect/salesforce", headers: { cookie: cookies().owner! } });
    expect(v.body).not.toContain(SECRET);
    expect(v.body).not.toContain(KEY);
    expect(v.json().live).toMatchObject({ configured: true, myDomain: "acme--test.sandbox.my.salesforce.com", clientIdHint: "…456789" });
    const row = await withContext({ operator: true }, (tx) => tx.query("select secret_enc from connector_credentials where tenant_id = $1", [funder.id]));
    expect(row.rows[0].secret_enc).not.toContain(SECRET);
    const trail = await d.call("owner", "GET", "/api/audit/verify");
    expect(trail.ok).toBe(true);
  });

  it("tests the connection: who it signs in as, the org, and the API budget", async () => {
    const t = await d.call("owner", "POST", "/api/connect/salesforce/live/test");
    expect(t.ok).toBe(true);
    expect(t.org).toMatchObject({ name: "Acme Pharma (test)", edition: "Enterprise Edition", sandbox: true });
    expect(t.user.username).toBe("integration@acme.test");
    expect(t.limits.DailyApiRequests.Remaining).toBe(114980);
    expect(seen).toContain("POST /services/oauth2/token");
    expect(seen.some((s) => s.startsWith("POST") && !s.includes("oauth2/token"))).toBe(false); // nothing written
  });

  it("reads the grants-related objects and the validation rules", async () => {
    const r = await d.call("owner", "POST", "/api/connect/salesforce/live/read");
    expect(r.objects.map((o: { name: string }) => o.name)).toEqual(["Account", "ContentVersion", "acme__Grant_Request__c"]);
    expect(r.validationRules[0]).toMatchObject({ object: "acme__Grant_Request__c", errorMessage: "Requested amount must be positive." });
    const v = (await d.call("owner", "GET", "/api/connect/salesforce")).live;
    expect(v.snapshot.objects.find((o: { name: string }) => o.name === "acme__Grant_Request__c")).toMatchObject({ fields: 3, custom: true });
    // The simulated org's mapping is untouched by reading a real org.
    expect((await d.call("owner", "GET", "/api/connect/salesforce")).snapshot).toBeUndefined();
  });

  it("explains Salesforce's sign-in refusals in plain words", async () => {
    await d.call("owner", "POST", "/api/connect/salesforce/live/credentials", { myDomain: "acme--test.sandbox.my.salesforce.com", clientId: KEY, clientSecret: "wrong" });
    let t = await d.try("owner", "POST", "/api/connect/salesforce/live/test");
    expect(t.status).toBe(409);
    expect(t.body.error).toMatch(/consumer key and secret don't match/);
    await d.call("owner", "POST", "/api/connect/salesforce/live/credentials", { myDomain: "acme--test.sandbox.my.salesforce.com", clientId: KEY, clientSecret: "no-run-as" });
    t = await d.try("owner", "POST", "/api/connect/salesforce/live/test");
    expect(t.body.error).toMatch(/Run As/);
    const v = (await d.call("owner", "GET", "/api/connect/salesforce")).live;
    expect(v.lastTest).toMatchObject({ ok: false, error: "invalid_grant" });
    await d.call("owner", "POST", "/api/connect/salesforce/live/remove");
    expect((await d.call("owner", "GET", "/api/connect/salesforce")).live.configured).toBe(false);
  });
});

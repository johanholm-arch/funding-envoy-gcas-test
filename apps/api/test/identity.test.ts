// Identity: OIDC sign-in through the demo identity provider (PKCE, signed ID token), SCIM provisioning of people
// and groups with roles derived from groups, access administration, and the trail of all of it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateKeyPairSync, sign } from "node:crypto";
import { closePool, withContext } from "@fe/db";
import { buildServer } from "../src/server.ts";
import { seed, uuidFor } from "../src/seed.ts";
import { verifyIdToken } from "../src/oidc.ts";

process.env.FE_TODAY = "2027-04-02";
process.env.FE_ASSISTANT = "demo";
let app: FastifyInstance;
const cookies: Record<string, string> = {};
let scimToken = "";

async function login(who: string, userId: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId } });
  cookies[who] = `fe_session=${r.cookies.find((x) => x.name === "fe_session")!.value}`;
}
async function call(who: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload: payload as object, headers: { cookie: cookies[who]! } });
  return { status: r.statusCode, body: r.body ? r.json() : undefined };
}
async function scim(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, token = scimToken) {
  const r = await app.inject({ method, url: `/scim/v2${url}`, payload: payload ? JSON.stringify(payload) : undefined, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" } });
  return { status: r.statusCode, body: r.body ? r.json() : undefined };
}

/** Walks the browser through start → identity provider → callback, returning the session cookie (or the error). */
async function ssoSignIn(email: string, extra: Record<string, string> = {}) {
  const start = await app.inject({ method: "GET", url: `/api/auth/sso/start?email=${encodeURIComponent(email)}` });
  if (start.statusCode !== 302) return { status: start.statusCode, body: start.json() };
  const idpUrl = new URL(start.headers.location as string, "http://localhost");
  for (const [k, v] of Object.entries(extra)) idpUrl.searchParams.set(k, v);
  const idp = await app.inject({ method: "GET", url: idpUrl.pathname + idpUrl.search });
  expect(idp.statusCode).toBe(302);
  const cb = new URL(idp.headers.location as string);
  const done = await app.inject({ method: "GET", url: cb.pathname + cb.search });
  const c = done.cookies.find((x) => x.name === "fe_session");
  return { status: done.statusCode, location: done.headers.location, cookie: c ? `fe_session=${c.value}` : undefined, body: done.statusCode >= 400 ? done.json() : undefined };
}

async function trail(tenant: string, action: string) {
  return withContext({ operator: true }, async (tx) => (await tx.query("select actor->>'type' as actor_type, actor->>'name' as actor_name, data from events where tenant_id = $1 and action = $2 order by seq", [tenant, action])).rows);
}

beforeAll(async () => {
  await seed();
  app = await buildServer();
  await login("ferreira", uuidFor("hp-ferreira"));
  await login("osei", uuidFor("hp-osei"));
});
afterAll(async () => { await app.close(); await closePool(); });

const HALDEN = uuidFor("tenant:halden");

describe("Single sign-on (OIDC)", () => {
  it("signs a known person in through their organization's identity provider and records it", async () => {
    const r = await ssoSignIn("k.osei@halden.example");
    expect(r.status).toBe(302);
    expect(r.cookie).toBeDefined();
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: r.cookie! } });
    expect(me.json().user.name).toMatch(/Osei/);
    const ev = await trail(HALDEN, "auth.signed-in");
    expect(ev.some((e) => e.data.method === "oidc")).toBe(true);
  });

  it("creates a new person on first sign-in with roles from their directory groups (Halden allows this)", async () => {
    const r = await ssoSignIn("new.reviewer@halden.example", { demo_groups: "FE-Medical-Review,All-Staff" });
    expect(r.status).toBe(302);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: r.cookie! } });
    expect(me.json().user.roles).toEqual(["medical-reviewer"]);
    const created = await trail(HALDEN, "access.person-created");
    expect(created.at(-1)!.actor_name).toBe("Single sign-on");
  });

  it("refuses an unprovisioned person where the organization requires provisioning (Meridian)", async () => {
    const r = await ssoSignIn("stranger@meridian.example", { demo_groups: "FRB-Members" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("not-provisioned");
  });

  it("has no single sign-on for an unknown domain", async () => {
    expect((await ssoSignIn("someone@elsewhere.example")).status).toBe(404);
  });

  it("rejects tampered, foreign or replayed ID tokens", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
    const mk = (claims: object) => {
      const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
      const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
    };
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: "https://idp.example", aud: "c1", sub: "s", exp: now + 60, iat: now, nonce: "n", email: "a@b.example" };
    const o = { issuer: "https://idp.example", clientId: "c1", nonce: "n", jwks: { keys: [jwk] } };
    expect(verifyIdToken(mk(good), o).sub).toBe("s");
    const t = mk(good).split(".");
    const tampered = `${t[0]}.${Buffer.from(JSON.stringify({ ...good, email: "boss@b.example" })).toString("base64url")}.${t[2]}`;
    expect(() => verifyIdToken(tampered, o)).toThrow(/signature/);
    expect(() => verifyIdToken(mk({ ...good, aud: "other" }), o)).toThrow(/audience/);
    expect(() => verifyIdToken(mk({ ...good, nonce: "x" }), o)).toThrow(/nonce/);
    expect(() => verifyIdToken(mk({ ...good, exp: now - 3600 }), o)).toThrow(/expired/);
    expect(() => verifyIdToken(mk({ ...good, iss: "https://evil.example" }), o)).toThrow(/issuer/);
  });

  it("refuses persona sign-in once the organization enforces single sign-on", async () => {
    const s = await call("ferreira", "GET", "/api/admin/identity");
    await call("ferreira", "PUT", "/api/admin/identity", { ...s.body.sso, enforced: true });
    const r = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId: uuidFor("hp-whitfield") } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("sso-required");
    await call("ferreira", "PUT", "/api/admin/identity", { ...s.body.sso, enforced: false });
  });
});

describe("SCIM provisioning", () => {
  it("issues a token once, and refuses requests without a valid one", async () => {
    const t = await call("ferreira", "POST", "/api/admin/scim-tokens", { label: "Okta" });
    expect(t.status).toBe(200);
    scimToken = t.body.token;
    expect((await scim("GET", "/Users", undefined, "nope")).status).toBe(401);
    const cfg = await scim("GET", "/ServiceProviderConfig");
    expect(cfg.body.patch.supported).toBe(true);
  });

  it("creates a person, puts them in a group, and derives their roles from it", async () => {
    const u = await scim("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "i.novak@halden.example", name: { givenName: "Ivana", familyName: "Novak" }, externalId: "00u1", active: true });
    expect(u.status).toBe(201);
    expect(u.body.displayName).toBe("Ivana Novak");
    expect((await scim("POST", "/Users", { userName: "i.novak@halden.example" })).status).toBe(409);
    const found = await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "I.Novak@halden.example"')}`);
    expect(found.body.totalResults).toBe(1);

    const g = await scim("POST", "/Groups", { displayName: "FE-Finance", members: [{ value: u.body.id }] });
    expect(g.status).toBe(201);
    let p = (await call("ferreira", "GET", "/api/admin/people")).body.people.find((x: { email: string }) => x.email === "i.novak@halden.example");
    expect(p.roles).toEqual(["finance"]);
    expect(p.managedBy).toBe("directory");

    // Entra-style patch: add to the committee group, then remove from finance.
    const c = await scim("POST", "/Groups", { displayName: "FE-Committee" });
    expect((await scim("PATCH", `/Groups/${c.body.id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Add", path: "members", value: [{ value: u.body.id }] }] })).status).toBe(204);
    expect((await scim("PATCH", `/Groups/${g.body.id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Remove", path: `members[value eq "${u.body.id}"]` }] })).status).toBe(204);
    p = (await call("ferreira", "GET", "/api/admin/people")).body.people.find((x: { email: string }) => x.email === "i.novak@halden.example");
    expect(p.roles).toEqual(["committee-member"]);

    // The access administrator cannot override directory-managed roles.
    expect((await call("ferreira", "PATCH", `/api/admin/people/${u.body.id}`, { roles: ["finance"] })).status).toBe(409);

    // Okta-style deactivation ends their sessions; delete removes them from view and from groups.
    const off = await scim("PATCH", `/Users/${u.body.id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", value: { active: false } }] });
    expect(off.body.active).toBe(false);
    expect((await scim("DELETE", `/Users/${u.body.id}`)).status).toBe(204);
    expect((await scim("GET", `/Users/${u.body.id}`)).status).toBe(404);
    expect((await scim("GET", `/Groups/${c.body.id}`)).body.members).toEqual([]);

    const changes = await trail(HALDEN, "access.roles-changed");
    expect(changes.every((e) => e.actor_type === "connector" || e.actor_type === "system" || e.actor_type === "person")).toBe(true);
    expect(changes.some((e) => e.actor_name === "Directory provisioning (Okta)")).toBe(true);
  });

  it("keeps each tenant's directory to itself", async () => {
    const meridianUser = uuidFor("mb-dubois");
    expect((await scim("GET", `/Users/${meridianUser}`)).status).toBe(404);
    expect((await scim("POST", "/Groups", { displayName: "Sneaky", members: [{ value: meridianUser }] })).status).toBe(400);
  });

  it("stops working when the token is revoked", async () => {
    const s = await call("ferreira", "GET", "/api/admin/identity");
    const tok = s.body.scimTokens.find((t: { label: string; revoked_at: string | null }) => t.label === "Okta" && !t.revoked_at);
    expect((await call("ferreira", "DELETE", `/api/admin/scim-tokens/${tok.id}`)).status).toBe(200);
    expect((await scim("GET", "/Users")).status).toBe(401);
  });
});

describe("Access administration", () => {
  it("is limited to access administrators, who cannot change their own roles", async () => {
    expect((await call("osei", "GET", "/api/admin/people")).status).toBe(403);
    expect((await call("ferreira", "PATCH", `/api/admin/people/${uuidFor("hp-ferreira")}`, { roles: ["finance", "access-admin"] })).status).toBe(403);
    // Access administration grants no access to funding data.
    expect((await call("ferreira", "GET", "/api/desk")).status).toBe(403);
  });

  it("changes a person's roles and switches access off, with both in the trail", async () => {
    const id = uuidFor("hp-ashworth");
    expect((await call("ferreira", "PATCH", `/api/admin/people/${id}`, { roles: ["medical-reviewer", "committee-member"] })).status).toBe(200);
    expect((await call("ferreira", "PATCH", `/api/admin/people/${id}`, { roles: ["operator"] })).status).toBe(400);
    await login("ashworth", id);
    expect((await call("ferreira", "PATCH", `/api/admin/people/${id}`, { active: false })).status).toBe(200);
    expect((await call("ashworth", "GET", "/api/me")).status).toBe(401);
    const ev = await trail(HALDEN, "access.person-deactivated");
    expect(ev.at(-1)!.actor_name).toMatch(/Ferreira/);
  });

  it("keeps the trail intact through all of it", async () => {
    await login("nair", uuidFor("hp-nair"));
    const v = await call("nair", "GET", "/api/audit/verify");
    expect(v.body.ok).toBe(true);
  });
});

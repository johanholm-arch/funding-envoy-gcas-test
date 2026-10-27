// Adding a funder from Operations, and the logo in Studio's Brand section.
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
const NAME = `Acme Biosciences ${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
let funder: { id: string; slug: string; name: string; packs: string[]; people: { name: string; roles: string[] }[] };

// A 1x1 PNG.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100e221bc330000000049454e44ae426082", "hex");

async function personId(name: string, tenantId: string) {
  const r = await app.inject({ method: "GET", url: "/api/demo/personas" });
  return (r.json().people as { id: string; name: string; tenant_id: string }[]).find((p) => p.name === name && p.tenant_id === tenantId)!.id;
}
async function loginId(who: string, userId: string, tenantSlug?: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId, tenantSlug } });
  expect(r.statusCode, r.body).toBe(200);
  (d as unknown as { cookies: Record<string, string> }).cookies[who] = `fe_session=${r.cookies.find((x) => x.name === "fe_session")!.value}`;
}
async function upload(who: string, name: string, mime: string, buf: Buffer) {
  const boundary = "----fe" + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const cookie = (d as unknown as { cookies: Record<string, string> }).cookies[who]!;
  const r = await app.inject({ method: "POST", url: "/api/studio/brand/logo", payload, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` } });
  return { status: r.statusCode, body: r.json() };
}

beforeAll(async () => {
  await seed();
  app = await buildServer();
  d = new Driver(app);
  await d.login("brandt", "hp-brandt");
  await d.login("osei", "hp-osei");
}, 120_000);
afterAll(async () => {
  // Remove the funder this test created, so test runs don't accumulate funders in the demo database.
  if (funder?.id) await withContext({ operator: true }, async (tx) => {
    await tx.query("select fe_demo_reset_tenant($1)", [funder.id]);
    await tx.query("delete from tenants where id = $1", [funder.id]);
  });
  await app.close(); await closePool();
});

describe("adding a funder", () => {
  it("is only for the managed-service operator", async () => {
    expect((await d.try("osei", "POST", "/api/ops/funders", { name: "Nope Pharma", color: "#123456", countries: ["US"] })).status).toBe(403);
  });

  it("creates a complete funder from Halden's setup, for the chosen countries", async () => {
    funder = await d.call("brandt", "POST", "/api/ops/funders", { name: NAME, color: "#7A1F5C", countries: ["US"], processOwnerName: "Johan Holm" });
    expect(funder.slug).toMatch(/^acme-biosciences-[a-z0-9]{4}/);
    expect(funder.packs.sort()).toEqual(["accredited-ce", "core", "us"]);
    expect(funder.people.length).toBe(11);
    expect(funder.people[0]).toMatchObject({ name: "Johan Holm", roles: ["process-owner"] });
    expect((await d.try("brandt", "POST", "/api/ops/funders", { name: NAME.toLowerCase(), color: "#7A1F5C", countries: ["US"] })).status).toBe(409);
    const fleet = await d.call("brandt", "GET", "/api/ops/fleet");
    expect(fleet.map((t: { name: string }) => t.name)).toContain(NAME);
    const personas = (await app.inject({ method: "GET", url: "/api/demo/personas" })).json();
    expect(personas.tenants.map((t: { name: string }) => t.name)).toContain(NAME);
  });

  it("gives its process owner a working Studio, renamed and passing its own test set", async () => {
    await loginId("holm", await personId("Johan Holm", funder.id));
    const policy = await d.call("holm", "GET", "/api/studio/policy/published");
    expect(JSON.stringify(policy.body)).not.toMatch(/Halden/);
    expect(JSON.stringify(policy.body)).toContain(NAME);
    const tests = await d.call("holm", "GET", "/api/studio/tests");
    expect(tests.total).toBeGreaterThan(10);
    expect(tests.passed).toBe(tests.total);
    const me = await d.call("holm", "GET", "/api/me");
    expect(me.tenant.brand).toMatchObject({ logoText: NAME, color: "#7A1F5C" });
    const trail = await d.call("holm", "GET", "/api/audit/verify");
    expect(trail.ok).toBe(true);
  });

  it("lets a US requestor apply to the new funder", async () => {
    await loginId("marsh-acme", (await (async () => {
      const r = await app.inject({ method: "GET", url: "/api/demo/personas" });
      return (r.json().people as { id: string; name: string }[]).find((p) => p.name === "Dr. Elena Marsh")!.id;
    })()), funder.slug);
    const r = await d.call("marsh-acme", "POST", "/api/requests", { text: "We'd like $20,000 for a heart failure update for nurses in June 2027." });
    const v = await d.call("marsh-acme", "GET", `/api/requests/${r.id}`);
    expect(v.request.fields["amount.requested"].value).toBe(20000);
  });
});

describe("logo in Studio", () => {
  it("uploads, publishes and shows the logo, and refuses files that aren't images", async () => {
    expect((await upload("holm", "logo.png", "image/png", Buffer.from("not really a png"))).status).toBe(400);
    expect((await upload("holm", "logo.gif", "image/gif", PNG)).status).toBe(400);
    const up = await upload("holm", "acme.png", "image/png", PNG);
    expect(up.status).toBe(200);
    const draft = await d.call("holm", "POST", "/api/studio/brand/drafts", { note: "Logo", body: { logoText: NAME, color: "#1F6F8B", logo: up.body } });
    const cookie = (d as unknown as { cookies: Record<string, string> }).cookies.holm!;
    const preview = await app.inject({ method: "GET", url: `/api/tenant/logo?v=${draft.version}`, headers: { cookie } });
    expect(preview.statusCode).toBe(200);
    await d.call("holm", "POST", `/api/studio/brand/${draft.version}/publish`, { typedName: "Johan Holm" });
    const me = await d.call("holm", "GET", "/api/me");
    expect(me.tenant.brand.color).toBe("#1F6F8B");
    expect(me.tenant.brand.logoUrl).toMatch(/^\/api\/tenant\/logo\?h=/);
    const img = await app.inject({ method: "GET", url: me.tenant.brand.logoUrl, headers: { cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(String(img.headers["content-security-policy"])).toMatch(/sandbox/);
    // Halden's people don't see Acme's logo.
    const osei = await d.call("osei", "GET", "/api/me");
    expect(osei.tenant.brand.logoUrl).toBeUndefined();
  });

  it("applies a published brand change to the screens (it used to stay on the old one)", async () => {
    await d.login("whitfield", "hp-whitfield");
    const draft = await d.call("whitfield", "POST", "/api/studio/brand/drafts", { note: "Colour", body: { logoText: "Halden Pharma US", color: "#7A1F5C" } });
    await d.call("whitfield", "POST", `/api/studio/brand/${draft.version}/publish`, { typedName: "Jane Whitfield" });
    await d.login("marsh", "rq-marsh");
    const me = await d.call("marsh", "GET", "/api/me");
    expect(me.tenant.brand).toMatchObject({ logoText: "Halden Pharma US", color: "#7A1F5C" });
  });
});

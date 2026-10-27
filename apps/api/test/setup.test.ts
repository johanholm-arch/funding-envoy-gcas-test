// The guided Studio: a new funder uploads its own policy and SOP, FundingEnvoy proposes the words, limits, required
// documents and stage times with their sources, the process owner confirms, and one signature publishes it all.
import { readFileSync } from "node:fs";
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
const NAME = `Borealis Health ${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
let funder: { id: string; slug: string };

// Halden's documents, rewritten as another company's: its own committee name, lead time and single-approver limit.
const own = (s: string) => s.replace(/Halden Pharma|Halden/g, "Borealis").replace(/Grants and Donations Committee/g, "Medical Education Board")
  .replace(/60 calendar days/g, "45 calendar days").replace(/less than 60 days/g, "less than 45 days").replace(/US\$5,000/g, "US$7,500");
const POLICY = own(readFileSync(new URL("../../../content/halden/policy.md", import.meta.url), "utf8"));
const SOP = own(readFileSync(new URL("../../../content/halden/sop.md", import.meta.url), "utf8"));

const cookies = () => (d as unknown as { cookies: Record<string, string> }).cookies;
async function uploadText(kind: string, name: string, text: string) {
  const boundary = "----fe" + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n`), Buffer.from(text), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await app.inject({ method: "POST", url: `/api/studio/setup/documents/${kind}`, payload, headers: { cookie: cookies().owner!, "content-type": `multipart/form-data; boundary=${boundary}` } });
  return { status: r.statusCode, body: r.json() };
}

beforeAll(async () => {
  await seed();
  app = await buildServer();
  d = new Driver(app);
  await d.login("brandt", "hp-brandt");
  funder = await d.call("brandt", "POST", "/api/ops/funders", { name: NAME, color: "#2F5D50", countries: ["US"], processOwnerName: "Ana Ruiz" });
  const people = (await app.inject({ method: "GET", url: "/api/demo/personas" })).json().people as { id: string; name: string; tenant_id: string }[];
  const r = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId: people.find((p) => p.name === "Ana Ruiz" && p.tenant_id === funder.id)!.id } });
  cookies().owner = `fe_session=${r.cookies.find((x) => x.name === "fe_session")!.value}`;
}, 120_000);
afterAll(async () => {
  if (funder?.id) await withContext({ operator: true }, async (tx) => {
    await tx.query("select fe_demo_reset_tenant($1)", [funder.id]);
    await tx.query("delete from tenants where id = $1", [funder.id]);
  });
  await app.close(); await closePool();
});

describe("guided setup", () => {
  it("starts from the copied documents and says where they came from", async () => {
    const v = await d.call("owner", "GET", "/api/studio/setup");
    expect(v.funder).toBe(NAME);
    expect(v.documents.policy.copiedFrom).toMatch(/Halden/);
    expect(v.proposal).toBeUndefined();
    expect(v.drafts).toEqual([]);
    expect(v.words.find((w: { key: string }) => w.key === "committee").value).toBeTruthy();
  });

  it("refuses a document too short to work from", async () => {
    expect((await d.try("owner", "POST", "/api/studio/setup/documents/policy", { text: "Our policy is to be fair." })).status).toBe(400);
  });

  it("reads the funder's own policy and SOP and proposes its setup, each with the sentence it came from", async () => {
    const p = await uploadText("policy", "Borealis policy.md", POLICY);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.clauses).toBeGreaterThan(10);
    const s = await d.call("owner", "POST", "/api/studio/setup/documents/sop", { text: SOP });
    expect(s.clauses).toBeGreaterThan(10);
    const prop = await d.call("owner", "POST", "/api/studio/setup/propose");
    expect(prop.words.committee.value).toBe("Medical Education Board");
    expect(prop.parameters.leadTimeDays).toMatchObject({ value: 45, ref: expect.stringMatching(/4\.1/) });
    expect(prop.parameters.singleApproverMaxUSD.value).toBe(7500);
    expect(prop.parameters.revenueCap.value).toBe(0.25);
    expect(prop.documents.length).toBeGreaterThan(3);
    for (const x of [prop.words.committee, prop.parameters.leadTimeDays, ...prop.documents]) expect((SOP + POLICY).replace(/\*\*/g, "")).toContain(x.quote.slice(0, 40));
    const v = await d.call("owner", "GET", "/api/studio/setup");
    expect(v.proposal.fresh).toBe(true);
    expect(v.words.find((w: { key: string }) => w.key === "committee").proposed.value).toBe("Medical Education Board");
    expect(v.drafts.map((x: { kind: string }) => x.kind)).toEqual(expect.arrayContaining(["policy", "sop", "workflow"]));
  });

  it("saves each confirmed step as a draft, without changing what requests use", async () => {
    await d.call("owner", "POST", "/api/studio/setup/words", { words: { committee: "Medical Education Board" } });
    await d.call("owner", "POST", "/api/studio/setup/requirements", { limits: { leadTimeDays: 45, singleApproverMaxUSD: 7500 }, documents: { bylaws: "optional" } });
    expect((await d.try("owner", "POST", "/api/studio/setup/requirements", { limits: { revenueCap: 5 } })).status).toBe(400);
    const v = await d.call("owner", "GET", "/api/studio/setup");
    const stage = v.workflow[1];
    await d.call("owner", "POST", "/api/studio/setup/workflow", { stages: [{ id: stage.id, slaBusinessDays: 4 }] });
    const core = v.checks.find((c: { locked: boolean }) => c.locked);
    if (core) expect((await d.try("owner", "POST", "/api/studio/setup/requirements", { checks: { [core.id]: false } })).status).toBe(400);
    const after = await d.call("owner", "GET", "/api/studio/setup");
    expect(after.limits.find((l: { key: string }) => l.key === "leadTimeDays").value).toBe(45);
    expect(after.workflow.find((s: { id: string }) => s.id === stage.id).slaBusinessDays).toBe(4);
    expect(after.drafts.map((x: { kind: string }) => x.kind)).toEqual(["policy", "sop", "words", "catalogue", "rulebook", "workflow"]);
    const me = await d.call("owner", "GET", "/api/me");
    expect(me.tenant.words.committee).not.toBe("Medical Education Board");
  });

  it("checks everything together and publishes it with one signature", async () => {
    const check = await d.call("owner", "GET", "/api/studio/setup/check");
    expect(check.drafts.length).toBe(6);
    expect((await d.try("owner", "POST", "/api/studio/setup/publish", { typedName: "Someone Else" })).status).toBe(400);
    const res = await d.call("owner", "POST", "/api/studio/setup/publish", { typedName: "Ana Ruiz", acceptDifferences: "Our lead time is 45 days, not 60." });
    expect(res.published.map((x: { kind: string }) => x.kind)).toEqual(["policy", "sop", "words", "catalogue", "rulebook", "workflow"]);
    const me = await d.call("owner", "GET", "/api/me");
    expect(me.tenant.words.committee).toBe("Medical Education Board");
    const v = await d.call("owner", "GET", "/api/studio/setup");
    expect(v.drafts).toEqual([]);
    expect(v.documents.policy.copiedFrom).toBeUndefined();
    expect((await d.call("owner", "GET", "/api/audit/verify")).ok).toBe(true);
  });

  it("discards drafts with a POST, whatever body type the browser sends", async () => {
    for (const type of ["text/plain;charset=UTF-8", "application/json"]) {
      const again = await d.call("owner", "POST", "/api/studio/rulebook/drafts", { note: "Try" });
      const r = await app.inject({ method: "POST", url: `/api/studio/rulebook/${again.version}/discard`, headers: { cookie: cookies().owner!, "content-type": type }, payload: "" });
      expect(r.statusCode, r.body).toBe(200);
    }
    const all = await d.call("owner", "POST", "/api/studio/setup/discard");
    expect(all.discarded).toBe(0);
  });
});

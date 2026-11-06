// A funder's real Salesforce org, read-only: the process owner saves the External Client App's consumer key and
// secret in Studio, tests the connection and reads the org. The secret is encrypted at rest and never shown again.
// Calls to Salesforce happen outside database transactions, so a slow org never holds a connection open.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { one } from "@fe/db";
import { asUser, HttpError, type SessionUser } from "../auth.ts";
import { Client, readOrg, signIn, SfLiveError, testOrg, normalizeDomain } from "../connectors/salesforce-live.ts";
import { snapshotHash } from "../connectors/salesforce-sim.ts";
import { record } from "./requests.ts";

const SYSTEM = "salesforce";
const SNAPSHOT_SYSTEM = "salesforce-live";
const ACTOR = { type: "connector" as const, id: "salesforce-live", name: "Salesforce connector (your org)" };

function key(): Buffer {
  return createHash("sha256").update(`fe-connector-secrets:${process.env.FE_SECRET_KEY ?? process.env.FE_COOKIE_SECRET ?? "fundingenvoy-demo-secret-change-me"}`).digest();
}
function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
function open(sealed: string): string {
  const [iv, tag, enc] = sealed.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]).toString("utf8");
}

function requireOwner(u: SessionUser) {
  if (!u.roles.some((r) => r === "process-owner" || r === "operator") && u.kind !== "operator") throw new HttpError(403, "Only the process owner can connect the company's Salesforce org.");
  if (!u.tenantId) throw new HttpError(400, "Choose a funder first.", "no-tenant");
}

const hint = (clientId: string) => `…${clientId.slice(-6)}`;

export async function liveView(u: SessionUser) {
  return asUser(u, async (tx) => {
    const c = await one<{ my_domain: string; client_id: string; saved_by: string; saved_at: Date; last_test: Record<string, unknown> | null }>(tx,
      "select my_domain, client_id, saved_by, saved_at, last_test from connector_credentials where tenant_id = $1 and system = $2", [u.tenantId, SYSTEM]);
    const snap = await one<{ hash: string; body: { org: unknown; objects: { name: string; label: string; fields: unknown[] }[]; validationRules: unknown[]; found?: unknown; note?: string }; read_by: string; read_at: Date }>(tx,
      "select hash, body, read_by, read_at from connector_snapshots where tenant_id = $1 and system = $2 order by read_at desc limit 1", [u.tenantId, SNAPSHOT_SYSTEM]);
    return {
      configured: Boolean(c), myDomain: c?.my_domain, clientIdHint: c ? hint(c.client_id) : undefined, savedBy: c?.saved_by, savedAt: c?.saved_at, lastTest: c?.last_test ?? undefined,
      snapshot: snap ? { hash: snap.hash, readBy: snap.read_by, readAt: snap.read_at, org: snap.body.org, objects: snap.body.objects.map((o) => ({ name: o.name, label: o.label, fields: o.fields.length, custom: o.name.endsWith("__c") })), validationRules: snap.body.validationRules, found: snap.body.found, note: snap.body.note } : undefined,
    };
  });
}

export async function saveCredentials(u: SessionUser, input: { myDomain: string; clientId?: string; clientSecret?: string }) {
  requireOwner(u);
  let domain: string;
  try { domain = normalizeDomain(input.myDomain); } catch (e) { throw new HttpError(400, (e as Error).message, "bad-domain"); }
  return asUser(u, async (tx) => {
    const cur = await one<{ secret_enc: string; client_id: string }>(tx, "select secret_enc, client_id from connector_credentials where tenant_id = $1 and system = $2", [u.tenantId, SYSTEM]);
    const clientId = input.clientId?.trim() || cur?.client_id || "";
    if (clientId.length < 20) throw new HttpError(400, "The consumer key looks too short. Copy it again from the External Client App.");
    const secret = input.clientSecret?.trim();
    if (!secret && !cur) throw new HttpError(400, "Paste the consumer secret too.");
    await tx.query(`insert into connector_credentials (tenant_id, system, my_domain, client_id, secret_enc, saved_by) values ($1,$2,$3,$4,$5,$6)
      on conflict (tenant_id, system) do update set my_domain = excluded.my_domain, client_id = excluded.client_id, secret_enc = excluded.secret_enc, saved_by = excluded.saved_by, saved_at = now(), last_test = null`,
      [u.tenantId, SYSTEM, domain, clientId, secret ? seal(secret) : cur!.secret_enc, u.name]);
    await record(tx, { tenantId: u.tenantId!, actor: { type: "person", id: u.id, name: u.name, roles: u.roles }, entity: { type: "connector", id: SYSTEM }, action: "connector.salesforce.live-credentials-saved", data: { myDomain: domain, consumerKey: hint(clientId), secretChanged: Boolean(secret) } });
    return { myDomain: domain, clientIdHint: hint(clientId) };
  });
}

export async function removeCredentials(u: SessionUser) {
  requireOwner(u);
  return asUser(u, async (tx) => {
    const r = await tx.query("delete from connector_credentials where tenant_id = $1 and system = $2", [u.tenantId, SYSTEM]);
    if (r.rowCount) await record(tx, { tenantId: u.tenantId!, actor: { type: "person", id: u.id, name: u.name, roles: u.roles }, entity: { type: "connector", id: SYSTEM }, action: "connector.salesforce.live-credentials-removed", data: {} });
    return { removed: Boolean(r.rowCount) };
  });
}

async function session(u: SessionUser) {
  const c = await asUser(u, (tx) => one<{ my_domain: string; client_id: string; secret_enc: string }>(tx, "select my_domain, client_id, secret_enc from connector_credentials where tenant_id = $1 and system = $2", [u.tenantId, SYSTEM]));
  if (!c) throw new HttpError(409, "Save the org's My Domain, consumer key and consumer secret first.");
  let secret: string;
  try { secret = open(c.secret_enc); } catch { throw new HttpError(409, "The saved secret can't be read any more (the server's secret key changed). Paste the consumer secret again."); }
  return { domain: c.my_domain, client: new Client(await signIn(c.my_domain, c.client_id, secret)) };
}

async function noteTest(u: SessionUser, result: Record<string, unknown>) {
  await asUser(u, async (tx) => {
    await tx.query("update connector_credentials set last_test = $3 where tenant_id = $1 and system = $2", [u.tenantId, SYSTEM, JSON.stringify(result)]);
    await record(tx, { tenantId: u.tenantId!, actor: ACTOR, entity: { type: "connector", id: SYSTEM }, action: "connector.salesforce.live-tested", data: { ...result, by: u.name } });
  });
}

export async function testLive(u: SessionUser) {
  requireOwner(u);
  const at = new Date().toISOString();
  try {
    const { client } = await session(u);
    const t = await testOrg(client);
    const result = { ok: true, at, org: t.org, user: t.user, limits: t.limits, calls: client.calls + 1 };
    await noteTest(u, result);
    return result;
  } catch (e) {
    if (!(e instanceof SfLiveError)) throw e;
    await noteTest(u, { ok: false, at, error: e.code, message: e.message });
    throw new HttpError(409, e.message, `salesforce:${e.code}`);
  }
}

export async function readLive(u: SessionUser) {
  requireOwner(u);
  try {
    const { client, domain } = await session(u);
    const body = await readOrg(client, domain);
    const hash = snapshotHash(body);
    await asUser(u, async (tx) => {
      await tx.query("insert into connector_snapshots (tenant_id, system, hash, body, read_by) values ($1,$2,$3,$4,$5) on conflict (tenant_id, system, hash) do update set read_at = now(), read_by = excluded.read_by", [u.tenantId, SNAPSHOT_SYSTEM, hash, JSON.stringify(body), u.name]);
      await record(tx, { tenantId: u.tenantId!, actor: ACTOR, entity: { type: "connector", id: SYSTEM }, action: "connector.salesforce.live-org-read", data: { hash, org: body.org.name, objects: body.objects.map((o) => o.name), validationRules: body.validationRules.length, calls: client.calls + 1, by: u.name } });
    });
    return { hash, org: body.org, objects: body.objects.map((o) => ({ name: o.name, label: o.label, fields: o.fields.length, custom: o.name.endsWith("__c") })), validationRules: body.validationRules, found: body.found, note: body.note, calls: client.calls + 1 };
  } catch (e) {
    if (!(e instanceof SfLiveError)) throw e;
    throw new HttpError(409, e.message, `salesforce:${e.code}`);
  }
}

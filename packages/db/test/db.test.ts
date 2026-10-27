import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { appendEvent, closePool, many, one, verifyTenantChain, withContext } from "../src/index.ts";

const A = randomUUID(), B = randomUUID();
const orgA1 = randomUUID(), orgA2 = randomUUID();
const userA1 = randomUUID(), userA2 = randomUUID();
const op = { operator: true };

async function seedRequest(tenant: string, org: string, user: string, ref: string) {
  await withContext({ tenantId: tenant }, (tx) => tx.query(
    `insert into requests (id, tenant_id, ref, org_id, requestor_id, country, status, stage, state, versions)
     values ($1,$2,$3,$4,$5,'US','draft','intake','{}','{}')`, [randomUUID(), tenant, ref, org, user]));
}

beforeAll(async () => {
  await withContext(op, async (tx) => {
    await tx.query("insert into tenants (id, slug, name) values ($1,$2,'Tenant A'),($3,$4,'Tenant B')", [A, `a-${A.slice(0, 8)}`, B, `b-${B.slice(0, 8)}`]);
    await tx.query("insert into organizations (id, legal_name, type, country) values ($1,'Org A1','association','US'),($2,'Org A2','charity','US')", [orgA1, orgA2]);
    await tx.query("insert into org_shares (org_id, tenant_id) values ($1,$2),($3,$2)", [orgA1, A, orgA2]);
    await tx.query("insert into users (id, email, name, kind, org_id, roles) values ($1,$2,'R1','requestor',$3,'{requestor}'),($4,$5,'R2','requestor',$6,'{requestor}')",
      [userA1, `r1-${A}@x.example`, orgA1, userA2, `r2-${A}@x.example`, orgA2]);
  });
  await seedRequest(A, orgA1, userA1, "A-1");
  await seedRequest(A, orgA2, userA2, "A-2");
  await seedRequest(B, orgA1, userA1, "B-1");
});

afterAll(async () => { await closePool(); });

describe("row-level security", () => {
  it("isolates tenants", async () => {
    const seenA = await withContext({ tenantId: A }, (tx) => many<{ ref: string }>(tx, "select ref from requests where ref like '_-_' order by ref"));
    expect(seenA.map((r) => r.ref)).toEqual(["A-1", "A-2"]);
    const seenB = await withContext({ tenantId: B }, (tx) => many<{ ref: string }>(tx, "select ref from requests where ref like '_-_'"));
    expect(seenB.map((r) => r.ref)).toEqual(["B-1"]);
  });

  it("sees nothing without a tenant in scope", async () => {
    const none = await withContext({}, (tx) => many(tx, "select 1 from requests"));
    expect(none).toEqual([]);
  });

  it("refuses writes into another tenant", async () => {
    await expect(withContext({ tenantId: A }, (tx) => tx.query(
      "insert into requests (tenant_id, ref, org_id, requestor_id, country, status, stage, state, versions) values ($1,'X',$2,$3,'US','draft','intake','{}','{}')",
      [B, orgA1, userA1]))).rejects.toThrow(/row-level security/);
  });

  it("limits a requestor to their own organization", async () => {
    const r = await withContext({ tenantId: A, orgId: orgA1 }, (tx) => many<{ ref: string }>(tx, "select ref from requests where ref like '_-_'"));
    expect(r.map((x) => x.ref)).toEqual(["A-1"]);
  });

  it("lets the operator see across tenants", async () => {
    const r = await withContext(op, (tx) => many<{ ref: string }>(tx, "select ref from requests where ref like '_-_' and tenant_id in ($1,$2) order by ref", [A, B]));
    expect(r.map((x) => x.ref)).toEqual(["A-1", "A-2", "B-1"]);
  });
});

describe("audit trail", () => {
  it("chains events, verifies, and rejects edits and deletes", async () => {
    await withContext({ tenantId: A }, async (tx) => {
      for (let i = 0; i < 4; i++) {
        await appendEvent(tx, { tenantId: A, actor: { type: "system", id: "test", name: "Test" }, entity: { type: "request", id: "A-1" }, action: `step.${i}`, data: { i } });
      }
    });
    const v = await withContext({ tenantId: A }, (tx) => verifyTenantChain(tx, A));
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(4);
    await expect(withContext({ tenantId: A }, (tx) => tx.query("update events set data = '{\"i\":9}' where tenant_id = $1 and seq = 2", [A]))).rejects.toThrow(/append-only/);
    await expect(withContext({ tenantId: A }, (tx) => tx.query("delete from events where tenant_id = $1", [A]))).rejects.toThrow(/append-only/);
  });

  it("keeps sequences gapless under concurrent appends", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => withContext({ tenantId: B }, (tx) =>
      appendEvent(tx, { tenantId: B, actor: { type: "system", id: "t", name: "T" }, entity: { type: "x", id: String(i) }, action: "concurrent" }))));
    const v = await withContext({ tenantId: B }, (tx) => verifyTenantChain(tx, B));
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(10);
  });
});

describe("configuration versions", () => {
  it("makes a published version immutable and allows only retirement", async () => {
    const id = randomUUID();
    await withContext({ tenantId: A }, (tx) => tx.query(
      "insert into config_versions (id, tenant_id, kind, version, status, body, signed_at) values ($1,$2,'rulebook',1,'published','{\"rules\":[]}', now())", [id, A]));
    await expect(withContext({ tenantId: A }, (tx) => tx.query("update config_versions set body = '{\"rules\":[1]}' where id = $1", [id]))).rejects.toThrow(/immutable/);
    await withContext({ tenantId: A }, (tx) => tx.query("update config_versions set status = 'retired' where id = $1", [id]));
    const row = await withContext({ tenantId: A }, (tx) => one<{ status: string }>(tx, "select status from config_versions where id = $1", [id]));
    expect(row?.status).toBe("retired");
    await expect(withContext({ tenantId: A }, (tx) => tx.query("delete from config_versions where id = $1", [id]))).rejects.toThrow(/drafts/);
  });
});

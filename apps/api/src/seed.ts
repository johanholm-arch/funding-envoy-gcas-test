// Loads the demo tenant (Halden Pharma) and the packs from content/ into a freshly migrated database.
// Idempotent for configuration: re-running replaces the demo tenant's data.
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Organization } from "@fe/core";
import { closePool, withContext, type Tx } from "@fe/db";
import { readDocument } from "@fe/agent";
import { putFile } from "./storage.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../content");

/** Stable UUID from a content id, so seeded ids are the same on every run. */
export function uuidFor(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase();
  const h = createHash("sha256").update(`fundingenvoy:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function json<T>(rel: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path.join(ROOT, rel), "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${rel}: ${(e as Error).message}`);
  }
}

async function text(rel: string): Promise<string | undefined> {
  try { return await readFile(path.join(ROOT, rel), "utf8"); } catch { return undefined; }
}

interface TenantFile {
  slug: string; name: string; region: string; residency: string; codeFamily?: string;
  brand: Record<string, unknown>; words: Record<string, unknown>; languages: string[];
  products?: { name: string }[] | string[]; legalEntities?: unknown; grantsOffice?: unknown;
  people: { id: string; name: string; fullName?: string; title?: string; email: string; roles: string[]; region?: string }[];
}

interface Requestor { id: string; name: string; title?: string; email: string; organizationId: string; roles: string[] }

async function publish(tx: Tx, tenantId: string, kind: string, version: number, body: unknown, signedName = "J. Whitfield (process owner)", signedAt = "2026-10-26T16:00:00Z") {
  await tx.query(
    `insert into config_versions (tenant_id, kind, version, status, body, signed_name, signed_at, note)
     values ($1,$2,$3,'published',$4,$5,$6,'Seeded demo configuration')`,
    [tenantId, kind, version, JSON.stringify(body), signedName, signedAt]);
}

export async function seed(): Promise<{ tenantId: string; counts: Record<string, number> }> {
  const tenant = await json<TenantFile>("halden/tenant.json");
  if (!tenant) throw new Error("content/halden/tenant.json is missing");
  const counts: Record<string, number> = {};
  const tenantId = uuidFor(`tenant:${tenant.slug}`);

  await withContext({ operator: true }, async (tx) => {
    // Clean any previous demo data for this tenant. Events are append-only by trigger, so the demo reset
    // drops the tenant's chain through the owner-only function created in migration 003.
    await tx.query("select fe_demo_reset_tenant($1)", [tenantId]);

    const productNames = (tenant.products ?? []).map((p) => (typeof p === "string" ? p : p.name));
    const triage = (await json<{ parameters?: { triage?: { ruleId: string; group: string }[] } }>("halden/rulebook.json"))?.parameters?.triage;
    await tx.query(
      `insert into tenants (id, slug, name, region, residency, settings) values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set name = excluded.name, settings = excluded.settings`,
      [tenantId, tenant.slug, tenant.name, tenant.region, tenant.residency, JSON.stringify({
        brand: tenant.brand, words: tenant.words, languages: tenant.languages, productNames, codeFamily: tenant.codeFamily,
        legalEntities: tenant.legalEntities, grantsOffice: tenant.grantsOffice, triage, demo: true,
      })]);

    // Packs (global)
    const packFiles = (await readdir(path.join(ROOT, "packs"))).filter((f) => f.endsWith(".json"));
    for (const f of packFiles) {
      const p = await json<{ id: string; version: number; verification: { status: string } }>(`packs/${f}`);
      if (!p) continue;
      await tx.query("insert into packs (id, version, body, verification) values ($1,$2,$3,$4) on conflict (id, version) do update set body = excluded.body, verification = excluded.verification",
        [p.id, p.version, JSON.stringify(p), p.verification.status]);
    }
    counts.packs = packFiles.length;

    // Configuration
    const cfgFiles: [string, string][] = [["catalogue", "halden/catalogue.json"], ["rulebook", "halden/rulebook.json"], ["workflow", "halden/workflow.json"], ["autonomy", "halden/autonomy.json"]];
    for (const [kind, rel] of cfgFiles) {
      const body = await json<{ version?: number }>(rel);
      if (!body) continue;
      await publish(tx, tenantId, kind, body.version ?? 1, body);
      counts[kind] = 1;
    }
    const cautious = await json<{ version?: number }>("halden/autonomy-cautious.json");
    if (cautious) await tx.query("insert into config_versions (tenant_id, kind, version, status, body, note) values ($1,'autonomy',$2,'draft',$3,'Cautious profile (recommend everywhere)')", [tenantId, 2, JSON.stringify({ ...cautious, version: 2 })]);
    const caseFiles = (await readdir(path.join(ROOT, "halden/testset")).catch(() => [] as string[])).filter((f) => /^tc-\d+\.json$/.test(f)).sort();
    const cases = [];
    for (const f of caseFiles) cases.push(await json(`halden/testset/${f}`));
    if (cases.length) await publish(tx, tenantId, "testset", 1, { cases });
    counts.testCases = cases.length;
    await publish(tx, tenantId, "brand", 1, tenant.brand);
    await publish(tx, tenantId, "words", 1, tenant.words);
    const policy = await text("halden/policy.md");
    if (policy) await publish(tx, tenantId, "policy", 6, { title: "Grants and Donations Policy v6", markdown: policy });
    const sop = await text("halden/sop.md");
    if (sop) await publish(tx, tenantId, "sop", 4, { title: "Management of Grants and Donations SOP v4", markdown: sop });

    // People
    for (const p of tenant.people) {
      const kind = p.roles.includes("operator") ? "operator" : "internal";
      await tx.query(
        `insert into users (id, email, name, title, kind, tenant_id, roles, attributes) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do update set email = excluded.email, name = excluded.name, title = excluded.title, roles = excluded.roles, attributes = excluded.attributes, tenant_id = excluded.tenant_id`,
        [uuidFor(p.id), p.email, p.fullName ?? p.name, p.title ?? null, kind, kind === "operator" ? null : tenantId, p.roles, JSON.stringify({ contentId: p.id, shortName: p.name, region: p.region, finalSignatory: /final (medical )?signatory/i.test(p.title ?? "") })]);
    }
    counts.people = tenant.people.length;

    // Organizations and their passports
    const orgs = (await json<Organization[]>("halden/organizations.json")) ?? [];
    for (const o of orgs) {
      const id = uuidFor(o.id);
      await tx.query(
        `insert into organizations (id, legal_name, type, country, identifiers, data) values ($1,$2,$3,$4,$5,$6)
         on conflict (id) do update set legal_name = excluded.legal_name, type = excluded.type, country = excluded.country, identifiers = excluded.identifiers, data = excluded.data, updated_at = now()`,
        [id, o.legalName, o.type, o.country, JSON.stringify(o.identifiers ?? {}), JSON.stringify({ ...o, id })]);
      await tx.query("insert into org_shares (org_id, tenant_id) values ($1,$2) on conflict do nothing", [id, tenantId]);
    }
    counts.organizations = orgs.length;

    const requestors = (await json<Requestor[]>("halden/requestors.json")) ?? [];
    for (const r of requestors) {
      await tx.query(
        `insert into users (id, email, name, title, kind, org_id, roles, attributes) values ($1,$2,$3,$4,'requestor',$5,$6,$7)
         on conflict (id) do update set email = excluded.email, name = excluded.name, title = excluded.title, org_id = excluded.org_id, roles = excluded.roles`,
        [uuidFor(r.id), r.email, r.name, r.title ?? null, uuidFor(r.organizationId), r.roles, JSON.stringify({ contentId: r.id })]);
    }
    counts.requestors = requestors.length;

    // Passport documents: files listed in documents/INDEX.json with "passport": true belong to the organization.
    const index = await json<Record<string, { requestKey?: string; type: string; pages?: number; passport?: boolean; organizationId?: string; dated?: string }>>("halden/documents/INDEX.json");
    let passportDocs = 0;
    for (const [file, meta] of Object.entries(index ?? {})) {
      if (!meta.passport || !meta.organizationId) continue;
      const full = path.join(ROOT, "halden/documents", file);
      if (!(await stat(full).catch(() => undefined))) continue;
      const buf = await readFile(full);
      const mime = file.endsWith(".csv") ? "text/csv" : file.endsWith(".pdf") ? "application/pdf" : "text/markdown";
      const r = await readDocument(buf, file, mime);
      const st = await putFile(buf);
      await tx.query(
        `insert into documents (tenant_id, org_id, request_id, type, name, mime, size, sha256, storage_key, page_count, pages_text, dated, classified_by)
         values (null,$1,null,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requestor')`,
        [uuidFor(meta.organizationId), meta.type, file, mime, buf.length, st.sha256, st.key, r.pages.length, JSON.stringify(r.pages), meta.dated ?? null]);
      passportDocs++;
    }
    counts.passportDocuments = passportDocs;
  });
  return { tenantId, counts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed().then(({ tenantId, counts }) => { console.log(`Seeded Halden Pharma (${tenantId})`, counts); return closePool(); })
    .catch((e) => { console.error(e); process.exit(1); });
}

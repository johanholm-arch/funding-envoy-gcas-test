// The managed-service operator's seat: every tenant at a glance, one queue across tenants, the rule library
// with adoption per tenant, and passports. Operators switch into a tenant explicitly; every switch is recorded
// in the trail of the tenant entered and the tenant left.
import { many, one, withContext } from "@fe/db";
import { HttpError, type SessionUser } from "../auth.ts";
import { configVersion } from "../config.ts";
import { record } from "./requests.ts";
import { nextOccurrence } from "./disclosure.ts";
import type { Pack, Rulebook, AutonomyPolicy } from "@fe/core";

function requireOperator(u: SessionUser) {
  if (u.kind !== "operator") throw new HttpError(403, "Operations is for the managed-service team.");
}

export async function fleet(u: SessionUser) {
  requireOperator(u);
  return withContext({ operator: true }, async (tx) => {
    const tenants = await many<{ id: string; slug: string; name: string; region: string; residency: string; settings: { brand?: { color?: string } } }>(tx, "select id, slug, name, region, residency, settings from tenants where exists (select 1 from config_versions c where c.tenant_id = tenants.id) order by name");
    const packs = await many<{ body: Pack }>(tx, "select distinct on (id) body from packs order by id, version desc");
    const out = [];
    for (const t of tenants) {
      const stats = await one<{ open: number; needs: number; late: number }>(tx, `
        select (select count(*)::int from requests where tenant_id = $1 and status not in ('draft','closed','declined','withdrawn')) as open,
               (select count(*)::int from tasks where tenant_id = $1 and status = 'open' and assignee_role <> 'requestor') as needs,
               (select count(*)::int from tasks where tenant_id = $1 and status = 'open' and due_at < now()) as late`, [t.id]);
      const rb = await configVersion<Rulebook>(tx, t.id, "rulebook");
      const au = await configVersion<AutonomyPolicy>(tx, t.id, "autonomy");
      const draft = await one<{ version: number }>(tx, "select version from config_versions where tenant_id = $1 and kind = 'rulebook' and status = 'draft'", [t.id]);
      const adopted = new Set((rb?.body.packs ?? []).map((p) => p.id));
      const tPacks = packs.map((p) => p.body).filter((p) => adopted.has(p.id));
      const next = tPacks.flatMap((p) => p.calendar.map((c) => ({ label: c.label, date: nextOccurrence(c.rule) }))).filter((c) => c.date).sort((a, b) => a.date!.localeCompare(b.date!))[0];
      out.push({
        id: t.id, slug: t.slug, name: t.name, color: t.settings.brand?.color, region: t.region, residency: t.residency,
        open: stats?.open ?? 0, needsPerson: stats?.needs ?? 0, pastSla: stats?.late ?? 0,
        assistantProfile: au?.body.profile ?? "standard", rulebook: { version: rb?.version, draft: draft?.version },
        packs: tPacks.map((p) => ({ id: p.id, version: p.version, verification: p.verification.status })),
        nextDeadline: next,
      });
    }
    return out;
  });
}

export async function crossQueue(u: SessionUser) {
  requireOperator(u);
  return withContext({ operator: true }, (tx) => many<{ tenant: string; slug: string; request_id: string | null; ref: string | null; title: string; kind: string; assignee_role: string | null; due_at: Date | null }>(tx, `
    select t.name as tenant, t.slug, k.request_id, r.ref, k.title, k.kind, k.assignee_role, k.due_at from tasks k join tenants t on t.id = k.tenant_id left join requests r on r.id = k.request_id
    where k.status = 'open' and coalesce(k.assignee_role, '') <> 'requestor' order by k.due_at nulls last, k.created_at limit 200`));
}

export async function ruleLibrary(u: SessionUser) {
  requireOperator(u);
  return withContext({ operator: true }, async (tx) => {
    const packs = await many<{ id: string; version: number; body: Pack; verification: string; loaded_at: Date }>(tx, "select id, version, body, verification, loaded_at from packs order by id, version desc");
    const tenants = await many<{ id: string; name: string }>(tx, "select id, name from tenants where exists (select 1 from config_versions c where c.tenant_id = tenants.id) order by name");
    const adoption: Record<string, { tenant: string; version: number }[]> = {};
    for (const t of tenants) {
      const rb = await configVersion<Rulebook>(tx, t.id, "rulebook");
      for (const p of rb?.body.packs ?? []) (adoption[p.id] ??= []).push({ tenant: t.name, version: p.version });
    }
    return packs.map((p) => ({
      id: p.id, version: p.version, name: p.body.name, jurisdiction: p.body.jurisdiction, effectiveFrom: p.body.effectiveFrom,
      verification: p.verification, verificationNotes: p.body.verification.notes, rules: p.body.rules.length, parameters: p.body.parameters.length,
      unverifiedParameters: p.body.parameters.filter((x) => !x.verified).map((x) => x.label), adoptedBy: adoption[p.id] ?? [], loadedAt: p.loaded_at,
    }));
  });
}

export async function passports(u: SessionUser) {
  requireOperator(u);
  return withContext({ operator: true }, async (tx) => {
    const r = await one<{ orgs: number; multi: number; docs: number; reused: number }>(tx, `
      select (select count(*)::int from organizations) as orgs,
             (select count(*)::int from (select org_id from org_shares group by org_id having count(*) > 1) x) as multi,
             (select count(*)::int from documents where tenant_id is null) as docs,
             (select count(*)::int from documents d where d.request_id is not null and exists (select 1 from documents p where p.tenant_id is null and p.org_id = d.org_id and p.sha256 = d.sha256)) as reused`);
    const top = await many<{ name: string; funders: number; country: string }>(tx, "select o.legal_name as name, o.country, count(s.tenant_id)::int as funders from organizations o join org_shares s on s.org_id = o.id group by o.id order by funders desc, name limit 20");
    return { organizations: r?.orgs ?? 0, sharedWithSeveralFunders: r?.multi ?? 0, passportDocuments: r?.docs ?? 0, documentsReused: r?.reused ?? 0, organizationsList: top };
  });
}

export async function switchTenant(u: SessionUser, tenantId: string | null) {
  requireOperator(u);
  await withContext({ operator: true }, async (tx) => {
    if (tenantId) {
      const t = await one<{ id: string }>(tx, "select id from tenants where id = $1", [tenantId]);
      if (!t) throw new HttpError(404, "No such tenant.");
    }
    const actor = { type: "person" as const, id: u.id, name: u.name, roles: u.roles };
    if (u.tenantId) await record(tx, { tenantId: u.tenantId, actor, entity: { type: "operator-session", id: u.sessionId }, action: "operator.switched-out", data: { to: tenantId } });
    if (tenantId) await record(tx, { tenantId, actor, entity: { type: "operator-session", id: u.sessionId }, action: "operator.switched-in", data: { from: u.tenantId ?? null } });
    await tx.query("update sessions set tenant_id = $2 where id = $1", [u.sessionId, tenantId]);
  });
}

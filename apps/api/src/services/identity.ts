// People, groups and sign-in for a tenant. Roles for people provisioned by the tenant's directory (SCIM or
// just-in-time at sign-in) come from their groups through the tenant's role mapping; the directory is the source
// of truth. People created by hand keep the roles an access administrator gives them. Every change is recorded.
import { many, one, withContext, type Tx } from "@fe/db";
import type { Actor, Role } from "@fe/core";
import { actorOf, createSession, HttpError, newToken, hashToken, type SessionUser } from "../auth.ts";
import { record } from "./requests.ts";
import type { IdClaims } from "../oidc.ts";

export const ASSIGNABLE_ROLES: Role[] = ["coordinator", "medical-reviewer", "compliance-reviewer", "legal", "committee-member", "committee-chair", "finance", "tax", "compliance-auditor", "process-owner", "access-admin", "sales"];

export interface IdpConfig {
  issuer: string; clientId: string; clientSecretRef?: string | null; emailDomains: string[]; groupsClaim: string;
  roleMapping: Record<string, Role[]>; jit: boolean; enforced: boolean;
}

interface IdpRow { tenant_id: string; issuer: string; client_id: string; client_secret_ref: string | null; email_domains: string[]; groups_claim: string; role_mapping: Record<string, Role[]>; jit: boolean; enforced: boolean; updated_at: Date }

const toConfig = (r: IdpRow): IdpConfig => ({ issuer: r.issuer, clientId: r.client_id, clientSecretRef: r.client_secret_ref, emailDomains: r.email_domains, groupsClaim: r.groups_claim, roleMapping: r.role_mapping, jit: r.jit, enforced: r.enforced });

export async function idpFor(tx: Tx, tenantId: string): Promise<IdpConfig | undefined> {
  const r = await one<IdpRow>(tx, "select * from identity_providers where tenant_id = $1", [tenantId]);
  return r ? toConfig(r) : undefined;
}

export function rolesFromGroups(groups: string[], mapping: Record<string, Role[]>): Role[] {
  const lower = new Map(Object.entries(mapping).map(([g, r]) => [g.toLowerCase(), r]));
  const roles = new Set<Role>();
  for (const g of groups) for (const r of lower.get(g.toLowerCase()) ?? []) if (ASSIGNABLE_ROLES.includes(r)) roles.add(r);
  return [...roles].sort();
}

const sameRoles = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Re-derive roles for directory-managed people from the groups they are in. */
export async function recomputeRoles(tx: Tx, tenantId: string, userIds: string[], actor: Actor): Promise<void> {
  if (!userIds.length) return;
  const idp = await idpFor(tx, tenantId);
  const mapping = idp?.roleMapping ?? {};
  const users = await many<{ id: string; name: string; roles: Role[]; source: string }>(tx, "select id, name, roles, source from users where tenant_id = $1 and id = any($2::uuid[])", [tenantId, userIds]);
  for (const u of users) {
    if (u.source !== "scim" && u.source !== "sso-jit") continue;
    const groups = (await many<{ display_name: string }>(tx, "select display_name from scim_groups where tenant_id = $1 and $2 = any(members)", [tenantId, u.id])).map((g) => g.display_name);
    const roles = rolesFromGroups(groups, mapping);
    if (sameRoles(roles, u.roles)) continue;
    await tx.query("update users set roles = $2 where id = $1", [u.id, roles]);
    await record(tx, { tenantId, actor, entity: { type: "person", id: u.id }, action: "access.roles-changed", data: { person: u.name, before: u.roles, after: roles, via: "directory groups", groups } });
  }
}

// ─── Single sign-on ──────────────────────────────────────────────────────────────────────────────────────────

/** Map a verified ID token onto a person of the tenant, creating them just in time when the tenant allows it. */
export async function signInFromClaims(tenantId: string, claims: IdClaims): Promise<{ sessionId: string; userId: string }> {
  const userId = await withContext({ tenantId }, async (tx) => {
    const idp = await idpFor(tx, tenantId);
    if (!idp) throw new HttpError(400, "Single sign-on is not set up for this organization.", "no-idp");
    const email = String(claims.email).toLowerCase();
    const domain = email.split("@")[1] ?? "";
    if (idp.emailDomains.length && !idp.emailDomains.includes(domain)) throw new HttpError(403, "This address does not belong to the organization's sign-in domains.", "domain");
    const groupsRaw = claims[idp.groupsClaim];
    const groups = Array.isArray(groupsRaw) ? groupsRaw.map(String) : undefined;
    const system: Actor = { type: "system", id: "sso", name: "Single sign-on" };

    let u = await one<{ id: string; name: string; roles: Role[]; source: string; active: boolean; tenant_id: string | null; external_id: string | null }>(tx,
      "select id, name, roles, source, active, tenant_id, external_id from users where kind = 'internal' and tenant_id = $1 and (external_id = $2 or lower(email) = $3) order by (external_id = $2) desc limit 1", [tenantId, claims.sub, email]);
    if (!u) {
      const elsewhere = await one<{ id: string }>(tx, "select id from auth_find_user($1)", [email]);
      if (elsewhere) throw new HttpError(403, "This address is already used by another account.", "email-in-use");
      if (!idp.jit) throw new HttpError(403, "You have not been given access to FundingEnvoy yet. Ask your access administrator.", "not-provisioned");
      const roles = rolesFromGroups(groups ?? [], idp.roleMapping);
      u = await one(tx, "insert into users (email, name, kind, tenant_id, roles, external_id, source) values ($1,$2,'internal',$3,$4,$5,'sso-jit') returning id, name, roles, source, active, tenant_id, external_id",
        [email, String(claims.name ?? email), tenantId, roles, claims.sub]);
      await record(tx, { tenantId, actor: system, entity: { type: "person", id: u!.id }, action: "access.person-created", data: { person: u!.name, email, via: "first sign-in", roles, groups } });
    } else {
      if (!u.active) throw new HttpError(403, "Your access to FundingEnvoy has been switched off.", "inactive");
      if (!u.external_id) await tx.query("update users set external_id = $2 where id = $1", [u.id, claims.sub]);
      if (groups && (u.source === "sso-jit" || u.source === "scim")) {
        const roles = rolesFromGroups(groups, idp.roleMapping);
        if (!sameRoles(roles, u.roles)) {
          await tx.query("update users set roles = $2 where id = $1", [u.id, roles]);
          await record(tx, { tenantId, actor: system, entity: { type: "person", id: u.id }, action: "access.roles-changed", data: { person: u.name, before: u.roles, after: roles, via: "groups at sign-in", groups } });
        }
      }
    }
    await tx.query("update users set last_sign_in_at = now() where id = $1", [u!.id]);
    return u!.id;
  });
  const sessionId = await createSession(userId, tenantId, { method: "oidc" });
  return { sessionId, userId };
}

// ─── Access administration ───────────────────────────────────────────────────────────────────────────────────

function requireAccessAdmin(u: SessionUser) {
  if (!u.roles.includes("access-admin") && u.kind !== "operator") throw new HttpError(403, "Managing access needs the access administrator role.", "forbidden");
  if (!u.tenantId) throw new HttpError(400, "Choose a tenant first.", "no-tenant");
}

export async function people(u: SessionUser) {
  requireAccessAdmin(u);
  return withContext({ tenantId: u.tenantId }, async (tx) => {
    const rows = await many<{ id: string; name: string; email: string; title: string | null; roles: Role[]; active: boolean; source: string; last_sign_in_at: Date | null; groups: string[] | null }>(tx, `
      select u.id, u.name, u.email, u.title, u.roles, u.active, u.source, u.last_sign_in_at,
             (select array_agg(g.display_name order by g.display_name) from scim_groups g where g.tenant_id = u.tenant_id and u.id = any(g.members)) as groups
      from users u where u.kind = 'internal' and u.tenant_id = $1 and not coalesce((u.attributes->>'scimDeleted')::boolean, false) order by u.active desc, u.name`, [u.tenantId]);
    return {
      roles: ASSIGNABLE_ROLES,
      people: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, title: r.title, roles: r.roles, active: r.active, groups: r.groups ?? [], lastSignIn: r.last_sign_in_at,
        managedBy: r.source === "scim" || r.source === "sso-jit" ? "directory" : "here" })),
    };
  });
}

export async function updatePerson(u: SessionUser, id: string, b: { roles?: Role[]; active?: boolean }) {
  requireAccessAdmin(u);
  return withContext({ tenantId: u.tenantId }, async (tx) => {
    const p = await one<{ id: string; name: string; roles: Role[]; active: boolean; source: string }>(tx, "select id, name, roles, active, source from users where id = $1 and kind = 'internal' and tenant_id = $2", [id, u.tenantId]);
    if (!p) throw new HttpError(404, "No such person.");
    if (b.roles) {
      if (p.id === u.id) throw new HttpError(403, "You cannot change your own roles. Another access administrator has to.", "self");
      if (p.source === "scim" || p.source === "sso-jit") throw new HttpError(409, "This person's roles come from your directory's groups. Change their groups there.", "directory-managed");
      const bad = b.roles.filter((r) => !ASSIGNABLE_ROLES.includes(r));
      if (bad.length) throw new HttpError(400, `These roles cannot be assigned here: ${bad.join(", ")}.`, "invalid-role");
      const roles = [...new Set(b.roles)].sort();
      if (!sameRoles(roles, p.roles)) {
        await tx.query("update users set roles = $2 where id = $1", [id, roles]);
        await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "person", id }, action: "access.roles-changed", data: { person: p.name, before: p.roles, after: roles, via: "access administration" } });
      }
    }
    if (b.active !== undefined && b.active !== p.active) {
      if (p.id === u.id) throw new HttpError(403, "You cannot switch off your own access.", "self");
      await tx.query("update users set active = $2 where id = $1", [id, b.active]);
      if (!b.active) await tx.query("delete from sessions where user_id = $1", [id]);
      await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "person", id }, action: b.active ? "access.person-reactivated" : "access.person-deactivated", data: { person: p.name } });
    }
    return { ok: true };
  });
}

export async function identitySettings(u: SessionUser) {
  requireAccessAdmin(u);
  return withContext({ tenantId: u.tenantId }, async (tx) => {
    const idp = await idpFor(tx, u.tenantId!);
    const tokens = await many<{ id: string; label: string; created_by: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }>(tx, "select id, label, created_by, created_at, last_used_at, revoked_at from scim_tokens where tenant_id = $1 order by created_at desc", [u.tenantId]);
    const groups = await many<{ id: string; display_name: string; n: number }>(tx, "select id, display_name, cardinality(members) as n from scim_groups where tenant_id = $1 order by display_name", [u.tenantId]);
    return {
      sso: idp ?? null, scimTokens: tokens, groups: groups.map((g) => ({ id: g.id, name: g.display_name, members: g.n, roles: idp?.roleMapping[g.display_name] ?? [] })),
      scimBaseUrl: "/scim/v2", redirectUri: "/api/auth/sso/callback",
    };
  });
}

export async function saveIdentitySettings(u: SessionUser, c: IdpConfig) {
  requireAccessAdmin(u);
  for (const roles of Object.values(c.roleMapping)) {
    const bad = roles.filter((r) => !ASSIGNABLE_ROLES.includes(r));
    if (bad.length) throw new HttpError(400, `These roles cannot be mapped: ${bad.join(", ")}.`, "invalid-role");
  }
  const domains = [...new Set(c.emailDomains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  return withContext({ tenantId: u.tenantId }, async (tx) => {
    for (const d of domains) {
      const other = await one<{ slug: string }>(tx, "select slug from auth_idp_for_domain($1) where tenant_id <> $2", [d, u.tenantId]);
      if (other) throw new HttpError(409, `The domain ${d} is already claimed by another organization.`, "domain-claimed");
    }
    const before = await idpFor(tx, u.tenantId!);
    await tx.query(`insert into identity_providers (tenant_id, issuer, client_id, client_secret_ref, email_domains, groups_claim, role_mapping, jit, enforced)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (tenant_id) do update set issuer = excluded.issuer, client_id = excluded.client_id, client_secret_ref = excluded.client_secret_ref, email_domains = excluded.email_domains,
        groups_claim = excluded.groups_claim, role_mapping = excluded.role_mapping, jit = excluded.jit, enforced = excluded.enforced, updated_at = now()`,
      [u.tenantId, c.issuer, c.clientId, c.clientSecretRef ?? null, domains, c.groupsClaim, JSON.stringify(c.roleMapping), c.jit, c.enforced]);
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "identity-provider", id: u.tenantId! }, action: "access.sso-configured", data: { before: before ?? null, after: { ...c, emailDomains: domains } } });
    // Mapping changes apply to everyone the directory manages.
    const managed = await many<{ id: string }>(tx, "select id from users where tenant_id = $1 and source in ('scim','sso-jit')", [u.tenantId]);
    await recomputeRoles(tx, u.tenantId!, managed.map((m) => m.id), actorOf(u));
    return { ok: true };
  });
}

export async function createScimToken(u: SessionUser, label: string) {
  requireAccessAdmin(u);
  const token = `fe_scim_${newToken()}`;
  const id = await withContext({ tenantId: u.tenantId }, async (tx) => {
    const r = await one<{ id: string }>(tx, "insert into scim_tokens (tenant_id, token_hash, label, created_by) values ($1,$2,$3,$4) returning id", [u.tenantId, hashToken(token), label, u.name]);
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "scim-token", id: r!.id }, action: "access.scim-token-created", data: { label } });
    return r!.id;
  });
  return { id, token, note: "Copy this token into your identity provider now. It is not shown again." };
}

export async function revokeScimToken(u: SessionUser, id: string) {
  requireAccessAdmin(u);
  return withContext({ tenantId: u.tenantId }, async (tx) => {
    const r = await one<{ label: string }>(tx, "update scim_tokens set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null returning label", [id, u.tenantId]);
    if (!r) throw new HttpError(404, "No such active token.");
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "scim-token", id }, action: "access.scim-token-revoked", data: { label: r.label } });
    return { ok: true };
  });
}

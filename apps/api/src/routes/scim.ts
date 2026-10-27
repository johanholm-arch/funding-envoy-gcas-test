// SCIM 2.0 (RFC 7643 / 7644) provisioning for a tenant's internal people and groups. The tenant's directory
// (Okta, Entra ID) calls these endpoints with a bearer token issued in access administration. Every change is
// recorded in the tenant's trail with the directory as a connector actor. Deleting a person deactivates them:
// their past actions stay attributable.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { many, one, withContext, type Tx } from "@fe/db";
import type { Actor } from "@fe/core";
import { hashToken } from "../auth.ts";
import { record } from "../services/requests.ts";
import { recomputeRoles } from "../services/identity.ts";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

class ScimError extends Error {
  constructor(public status: number, detail: string, public scimType?: string) { super(detail); }
}

interface Ctx { tenantId: string; actor: Actor; base: string }

declare module "fastify" {
  interface FastifyRequest { scim?: Ctx }
}

interface UserRow { id: string; email: string; name: string; title: string | null; active: boolean; external_id: string | null; attributes: Record<string, unknown>; created_at: Date; source: string }

const bool = (v: unknown) => (typeof v === "string" ? v.toLowerCase() === "true" : Boolean(v));

function userResource(r: UserRow, groups: { id: string; display_name: string }[], base: string) {
  const n = (r.attributes.scimName ?? {}) as { givenName?: string; familyName?: string };
  return {
    schemas: [USER], id: r.id, externalId: r.external_id ?? undefined, userName: r.email, displayName: r.name,
    name: { formatted: r.name, givenName: n.givenName, familyName: n.familyName }, title: r.title ?? undefined, active: r.active,
    emails: [{ value: r.email, type: "work", primary: true }],
    groups: groups.map((g) => ({ value: g.id, display: g.display_name, $ref: `${base}/Groups/${g.id}` })),
    meta: { resourceType: "User", created: r.created_at.toISOString(), lastModified: r.created_at.toISOString(), location: `${base}/Users/${r.id}` },
  };
}

function groupResource(g: { id: string; display_name: string; external_id: string | null; members: string[]; created_at: Date; updated_at: Date }, names: Map<string, string>, base: string) {
  return {
    schemas: [GROUP], id: g.id, displayName: g.display_name, externalId: g.external_id ?? undefined,
    members: g.members.map((m) => ({ value: m, display: names.get(m), $ref: `${base}/Users/${m}` })),
    meta: { resourceType: "Group", created: g.created_at.toISOString(), lastModified: g.updated_at.toISOString(), location: `${base}/Groups/${g.id}` },
  };
}

/** Supports the filters directories actually send: `attr eq "value"`. */
function parseFilter(f: string | undefined, allowed: Record<string, string>): { column: string; value: string } | undefined {
  if (!f) return undefined;
  const m = /^\s*([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(f);
  const col = m ? allowed[m[1]!.toLowerCase()] : undefined;
  if (!m || !col) throw new ScimError(400, `Unsupported filter: ${f}`, "invalidFilter");
  return { column: col, value: m[2]!.replace(/\\(.)/g, "$1") };
}

function page(q: { startIndex?: string; count?: string }) {
  const start = Math.max(1, Number(q.startIndex ?? 1) || 1);
  const count = Math.min(200, Math.max(0, Number(q.count ?? 100) || 0));
  return { start, count };
}

async function loadUser(tx: Tx, c: Ctx, id: string): Promise<UserRow> {
  const r = await one<UserRow>(tx, "select id, email, name, title, active, external_id, attributes, created_at, source from users where id::text = $1 and tenant_id = $2 and kind = 'internal' and not coalesce((attributes->>'scimDeleted')::boolean, false)", [id, c.tenantId]);
  if (!r) throw new ScimError(404, "User not found.");
  return r;
}

async function groupsOf(tx: Tx, c: Ctx, userId: string) {
  return many<{ id: string; display_name: string }>(tx, "select id, display_name from scim_groups where tenant_id = $1 and $2 = any(members) order by display_name", [c.tenantId, userId]);
}

interface UserModel { userName: string; formatted?: string; givenName?: string; familyName?: string; displayName?: string; title?: string | null; active: boolean; externalId?: string | null }

function fromBody(b: Record<string, unknown>): UserModel {
  const name = (b.name ?? {}) as Record<string, string>;
  const emails = (b.emails ?? []) as { value: string; primary?: boolean }[];
  const userName = String(b.userName ?? emails.find((e) => e.primary)?.value ?? emails[0]?.value ?? "");
  if (!userName) throw new ScimError(400, "userName is required.", "invalidValue");
  return { userName, formatted: name.formatted, givenName: name.givenName, familyName: name.familyName, displayName: b.displayName as string | undefined, title: (b.title as string) ?? null, active: b.active === undefined ? true : bool(b.active), externalId: (b.externalId as string) ?? null };
}

const fullName = (m: UserModel) => m.formatted || [m.givenName, m.familyName].filter(Boolean).join(" ") || m.displayName || m.userName.split("@")[0];
const emailOf = (m: UserModel) => {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.userName)) throw new ScimError(400, "userName must be the person's work email address.", "invalidValue");
  return m.userName.toLowerCase();
};

async function saveUser(tx: Tx, c: Ctx, id: string | undefined, m: UserModel, before?: UserRow) {
  const email = emailOf(m);
  const clash = await one<{ id: string }>(tx, "select id from auth_find_user($1)", [email]);
  if (clash && clash.id !== id) throw new ScimError(409, "A person with that userName already exists.", "uniqueness");
  const attrs = { ...(before?.attributes ?? {}), scimName: { givenName: m.givenName, familyName: m.familyName } };
  if (!id) {
    const r = await one<{ id: string }>(tx, "insert into users (email, name, title, kind, tenant_id, roles, active, external_id, source, attributes) values ($1,$2,$3,'internal',$4,'{}',$5,$6,'scim',$7) returning id",
      [email, fullName(m), m.title ?? null, c.tenantId, m.active, m.externalId ?? null, JSON.stringify(attrs)]);
    await record(tx, { tenantId: c.tenantId, actor: c.actor, entity: { type: "person", id: r!.id }, action: "access.person-created", data: { person: fullName(m), email, via: "directory provisioning" } });
    return r!.id;
  }
  await tx.query("update users set email = $2, name = $3, title = $4, active = $5, external_id = $6, attributes = $7 where id = $1", [id, email, fullName(m), m.title ?? null, m.active, m.externalId ?? null, JSON.stringify(attrs)]);
  if (before && before.active && !m.active) await tx.query("delete from sessions where user_id = $1", [id]);
  const changed = before ? Object.entries({ email: [before.email, email], name: [before.name, fullName(m)], title: [before.title, m.title ?? null], active: [before.active, m.active] }).filter(([, [a, b]]) => a !== b).map(([k, [a, b]]) => ({ field: k, before: a, after: b })) : [];
  if (changed.length) {
    const action = changed.some((x) => x.field === "active") ? (m.active ? "access.person-reactivated" : "access.person-deactivated") : "access.person-updated";
    await record(tx, { tenantId: c.tenantId, actor: c.actor, entity: { type: "person", id }, action, data: { person: fullName(m), changes: changed, via: "directory provisioning" } });
  }
  return id;
}

function applyUserPatch(m: UserModel, ops: { op: string; path?: string; value?: unknown }[]): UserModel {
  const set = (path: string, v: unknown, remove = false) => {
    const p = path.toLowerCase();
    if (p === "active") m.active = remove ? false : bool(v);
    else if (p === "username") m.userName = String(v);
    else if (p === "displayname") m.displayName = remove ? undefined : String(v);
    else if (p === "title") m.title = remove ? null : String(v);
    else if (p === "externalid") m.externalId = remove ? null : String(v);
    else if (p === "name.givenname") { m.givenName = remove ? undefined : String(v); m.formatted = undefined; }
    else if (p === "name.familyname") { m.familyName = remove ? undefined : String(v); m.formatted = undefined; }
    else if (p === "name.formatted") m.formatted = remove ? undefined : String(v);
    else if (p === "name" && v && typeof v === "object") { const n = v as Record<string, string>; m.givenName = n.givenName ?? m.givenName; m.familyName = n.familyName ?? m.familyName; m.formatted = n.formatted; }
    else if (p.startsWith("emails")) {
      const value = Array.isArray(v) ? (v[0] as { value?: string })?.value : typeof v === "object" && v ? (v as { value?: string }).value : v;
      if (value && !remove) m.userName = String(value);
    }
    // Attributes FundingEnvoy does not hold (phone numbers, addresses, enterprise extension) are accepted and ignored.
  };
  for (const o of ops) {
    const op = o.op.toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, `Unsupported operation ${o.op}.`, "invalidSyntax");
    if (o.path) set(o.path, o.value, op === "remove");
    else if (o.value && typeof o.value === "object") for (const [k, v] of Object.entries(o.value as Record<string, unknown>)) set(k, v);
  }
  return m;
}

const modelOf = (r: UserRow): UserModel => {
  const n = (r.attributes.scimName ?? {}) as { givenName?: string; familyName?: string };
  return { userName: r.email, formatted: n.givenName || n.familyName ? undefined : r.name, givenName: n.givenName, familyName: n.familyName, title: r.title, active: r.active, externalId: r.external_id };
};

async function memberIds(tx: Tx, c: Ctx, members: unknown): Promise<string[]> {
  const ids = ((members ?? []) as { value: string }[]).map((x) => String(x.value));
  if (!ids.length) return [];
  const ok = await many<{ id: string }>(tx, "select id::text from users where tenant_id = $1 and kind = 'internal' and id::text = any($2)", [c.tenantId, ids]);
  const known = new Set(ok.map((r) => r.id));
  const missing = ids.filter((i) => !known.has(i));
  if (missing.length) throw new ScimError(400, `Unknown members: ${missing.join(", ")}.`, "invalidValue");
  return [...new Set(ids)];
}

async function saveGroup(tx: Tx, c: Ctx, id: string | undefined, displayName: string, externalId: string | null, members: string[], before?: { display_name: string; members: string[] }) {
  const dupe = await one<{ id: string }>(tx, "select id from scim_groups where tenant_id = $1 and lower(display_name) = lower($2) and id::text <> coalesce($3, '')", [c.tenantId, displayName, id ?? null]);
  if (dupe) throw new ScimError(409, "A group with that name already exists.", "uniqueness");
  let gid = id;
  if (!gid) {
    gid = (await one<{ id: string }>(tx, "insert into scim_groups (tenant_id, display_name, external_id, members) values ($1,$2,$3,$4) returning id", [c.tenantId, displayName, externalId, members]))!.id;
    await record(tx, { tenantId: c.tenantId, actor: c.actor, entity: { type: "group", id: gid }, action: "access.group-created", data: { group: displayName, members: members.length } });
  } else {
    await tx.query("update scim_groups set display_name = $2, external_id = $3, members = $4, updated_at = now() where id = $1", [gid, displayName, externalId, members]);
    const added = members.filter((m) => !before!.members.includes(m)), removed = before!.members.filter((m) => !members.includes(m));
    if (added.length || removed.length || before!.display_name !== displayName) {
      await record(tx, { tenantId: c.tenantId, actor: c.actor, entity: { type: "group", id: gid }, action: "access.group-changed", data: { group: displayName, renamedFrom: before!.display_name !== displayName ? before!.display_name : undefined, added, removed } });
    }
  }
  await recomputeRoles(tx, c.tenantId, [...new Set([...members, ...(before?.members ?? [])])], c.actor);
  return gid;
}

async function loadGroup(tx: Tx, c: Ctx, id: string) {
  const g = await one<{ id: string; display_name: string; external_id: string | null; members: string[]; created_at: Date; updated_at: Date }>(tx, "select id, display_name, external_id, members::text[] as members, created_at, updated_at from scim_groups where id::text = $1 and tenant_id = $2", [id, c.tenantId]);
  if (!g) throw new ScimError(404, "Group not found.");
  return g;
}

async function names(tx: Tx, ids: string[]) {
  const rows = await many<{ id: string; name: string }>(tx, "select id::text, name from users where id::text = any($1)", [ids]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function scimRoutes(app: FastifyInstance) {
  app.addContentTypeParser(["application/scim+json"], { parseAs: "string" }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
  });

  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof ScimError ? err.status : (err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500 ? (err as { statusCode: number }).statusCode : 500;
    if (status === 500) app.log.error(err);
    return reply.status(status).type("application/scim+json").send({ schemas: [ERROR], status: String(status), detail: status === 500 ? "Internal error." : err.message, ...(err instanceof ScimError && err.scimType ? { scimType: err.scimType } : {}) });
  });

  app.addHook("onRequest", async (req: FastifyRequest) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!m) throw new ScimError(401, "A bearer token is required.");
    const t = await withContext({}, (tx) => one<{ tenant_id: string; token_id: string }>(tx, "select * from auth_scim_token($1)", [hashToken(m[1]!.trim())]));
    if (!t) throw new ScimError(401, "The token is not valid.");
    const label = await withContext({ tenantId: t.tenant_id }, (tx) => one<{ label: string }>(tx, "select label from scim_tokens where id = $1", [t.token_id]));
    req.scim = { tenantId: t.tenant_id, actor: { type: "connector", id: `scim:${t.token_id}`, name: `Directory provisioning (${label?.label ?? "SCIM"})` }, base: `${process.env.FE_PUBLIC_URL ?? `${req.protocol}://${req.headers.host}`}/scim/v2` };
  });

  const send = (reply: FastifyReply, status: number, body: unknown) => reply.status(status).type("application/scim+json").send(body);
  const run = <T>(req: FastifyRequest, fn: (tx: Tx, c: Ctx) => Promise<T>) => withContext({ tenantId: req.scim!.tenantId }, (tx) => fn(tx, req.scim!));

  // ─── Discovery ───────────────────────────────────────────────────────────────────────────────────────────
  app.get("/ServiceProviderConfig", async (_req, reply) => send(reply, 200, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "Issued in FundingEnvoy access administration." }],
  }));
  app.get("/ResourceTypes", async (_req, reply) => send(reply, 200, { schemas: [LIST], totalResults: 2, Resources: [
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER },
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP },
  ] }));
  app.get("/Schemas", async (_req, reply) => send(reply, 200, { schemas: [LIST], totalResults: 2, Resources: [{ id: USER, name: "User" }, { id: GROUP, name: "Group" }] }));

  // ─── Users ───────────────────────────────────────────────────────────────────────────────────────────────
  app.get("/Users", async (req, reply) => {
    const q = req.query as { filter?: string; startIndex?: string; count?: string };
    const f = parseFilter(q.filter, { username: "lower(email)", externalid: "external_id", "emails.value": "lower(email)", id: "id::text" });
    const { start, count } = page(q);
    const out = await run(req, async (tx, c) => {
      const where = `tenant_id = $1 and kind = 'internal' and not coalesce((attributes->>'scimDeleted')::boolean, false)${f ? ` and ${f.column} = $2` : ""}`;
      const params: unknown[] = [c.tenantId, ...(f ? [f.column.startsWith("lower") ? f.value.toLowerCase() : f.value] : [])];
      const total = (await one<{ n: number }>(tx, `select count(*)::int as n from users where ${where}`, params))!.n;
      const rows = await many<UserRow>(tx, `select id, email, name, title, active, external_id, attributes, created_at, source from users where ${where} order by created_at, id offset ${start - 1} limit ${count}`, params);
      const res = [];
      for (const r of rows) res.push(userResource(r, await groupsOf(tx, c, r.id), c.base));
      return { schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: res.length, Resources: res };
    });
    return send(reply, 200, out);
  });

  app.get("/Users/:id", async (req, reply) => send(reply, 200, await run(req, async (tx, c) => {
    const r = await loadUser(tx, c, (req.params as { id: string }).id);
    return userResource(r, await groupsOf(tx, c, r.id), c.base);
  })));

  app.post("/Users", async (req, reply) => send(reply, 201, await run(req, async (tx, c) => {
    const id = await saveUser(tx, c, undefined, fromBody(req.body as Record<string, unknown>));
    return userResource(await loadUser(tx, c, id), [], c.base);
  })));

  app.put("/Users/:id", async (req, reply) => send(reply, 200, await run(req, async (tx, c) => {
    const before = await loadUser(tx, c, (req.params as { id: string }).id);
    await saveUser(tx, c, before.id, fromBody(req.body as Record<string, unknown>), before);
    return userResource(await loadUser(tx, c, before.id), await groupsOf(tx, c, before.id), c.base);
  })));

  app.patch("/Users/:id", async (req, reply) => send(reply, 200, await run(req, async (tx, c) => {
    const b = req.body as { schemas?: string[]; Operations?: { op: string; path?: string; value?: unknown }[] };
    if (!b.schemas?.includes(PATCH) || !Array.isArray(b.Operations)) throw new ScimError(400, "Expected a PatchOp request.", "invalidSyntax");
    const before = await loadUser(tx, c, (req.params as { id: string }).id);
    await saveUser(tx, c, before.id, applyUserPatch(modelOf(before), b.Operations), before);
    return userResource(await loadUser(tx, c, before.id), await groupsOf(tx, c, before.id), c.base);
  })));

  app.delete("/Users/:id", async (req, reply) => {
    await run(req, async (tx, c) => {
      const r = await loadUser(tx, c, (req.params as { id: string }).id);
      await tx.query("update users set active = false, attributes = attributes || '{\"scimDeleted\": true}' where id = $1", [r.id]);
      await tx.query("delete from sessions where user_id = $1", [r.id]);
      const groups = await groupsOf(tx, c, r.id);
      await tx.query("update scim_groups set members = array_remove(members, $2::uuid), updated_at = now() where tenant_id = $1 and $2::uuid = any(members)", [c.tenantId, r.id]);
      await record(tx, { tenantId: c.tenantId, actor: c.actor, entity: { type: "person", id: r.id }, action: "access.person-deactivated", data: { person: r.name, via: "directory deprovisioning", removedFromGroups: groups.map((g) => g.display_name) } });
      await recomputeRoles(tx, c.tenantId, [r.id], c.actor);
    });
    return reply.status(204).send();
  });

  // ─── Groups ──────────────────────────────────────────────────────────────────────────────────────────────
  app.get("/Groups", async (req, reply) => {
    const q = req.query as { filter?: string; startIndex?: string; count?: string; excludedAttributes?: string };
    const f = parseFilter(q.filter, { displayname: "lower(display_name)", externalid: "external_id", id: "id::text" });
    const { start, count } = page(q);
    const out = await run(req, async (tx, c) => {
      const where = `tenant_id = $1${f ? ` and ${f.column} = $2` : ""}`;
      const params: unknown[] = [c.tenantId, ...(f ? [f.column.startsWith("lower") ? f.value.toLowerCase() : f.value] : [])];
      const total = (await one<{ n: number }>(tx, `select count(*)::int as n from scim_groups where ${where}`, params))!.n;
      const rows = await many<{ id: string; display_name: string; external_id: string | null; members: string[]; created_at: Date; updated_at: Date }>(tx, `select id, display_name, external_id, members::text[] as members, created_at, updated_at from scim_groups where ${where} order by display_name offset ${start - 1} limit ${count}`, params);
      const n = await names(tx, rows.flatMap((r) => r.members));
      const res = rows.map((g) => {
        const r = groupResource(g, n, c.base);
        return q.excludedAttributes?.includes("members") ? { ...r, members: undefined } : r;
      });
      return { schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: res.length, Resources: res };
    });
    return send(reply, 200, out);
  });

  app.get("/Groups/:id", async (req, reply) => send(reply, 200, await run(req, async (tx, c) => {
    const g = await loadGroup(tx, c, (req.params as { id: string }).id);
    return groupResource(g, await names(tx, g.members), c.base);
  })));

  app.post("/Groups", async (req, reply) => send(reply, 201, await run(req, async (tx, c) => {
    const b = req.body as { displayName?: string; externalId?: string; members?: unknown };
    if (!b.displayName) throw new ScimError(400, "displayName is required.", "invalidValue");
    const id = await saveGroup(tx, c, undefined, b.displayName, b.externalId ?? null, await memberIds(tx, c, b.members));
    const g = await loadGroup(tx, c, id);
    return groupResource(g, await names(tx, g.members), c.base);
  })));

  app.put("/Groups/:id", async (req, reply) => send(reply, 200, await run(req, async (tx, c) => {
    const before = await loadGroup(tx, c, (req.params as { id: string }).id);
    const b = req.body as { displayName?: string; externalId?: string; members?: unknown };
    await saveGroup(tx, c, before.id, b.displayName ?? before.display_name, b.externalId ?? before.external_id, await memberIds(tx, c, b.members), before);
    const g = await loadGroup(tx, c, before.id);
    return groupResource(g, await names(tx, g.members), c.base);
  })));

  app.patch("/Groups/:id", async (req, reply) => {
    await run(req, async (tx, c) => {
      const b = req.body as { schemas?: string[]; Operations?: { op: string; path?: string; value?: unknown }[] };
      if (!b.schemas?.includes(PATCH) || !Array.isArray(b.Operations)) throw new ScimError(400, "Expected a PatchOp request.", "invalidSyntax");
      const before = await loadGroup(tx, c, (req.params as { id: string }).id);
      let name = before.display_name, ext = before.external_id, members = [...before.members];
      for (const o of b.Operations) {
        const op = o.op.toLowerCase(), path = o.path ?? "";
        const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path);
        if (filtered && op === "remove") members = members.filter((m) => m !== filtered[1]!);
        else if (path.toLowerCase() === "members") {
          if (op === "add") members = [...new Set([...members, ...(await memberIds(tx, c, o.value))])];
          else if (op === "replace") members = await memberIds(tx, c, o.value);
          else if (op === "remove") { const drop = o.value ? new Set(((o.value as { value: string }[]) ?? []).map((v) => String(v.value))) : undefined; members = drop ? members.filter((m) => !drop.has(m)) : []; }
        } else if (path.toLowerCase() === "displayname" && op !== "remove") name = String(o.value);
        else if (path.toLowerCase() === "externalid") ext = op === "remove" ? null : String(o.value);
        else if (!path && o.value && typeof o.value === "object") {
          const v = o.value as Record<string, unknown>;
          if (v.displayName) name = String(v.displayName);
          if (v.externalId !== undefined) ext = v.externalId as string | null;
          if (v.members) members = op === "add" ? [...new Set([...members, ...(await memberIds(tx, c, v.members))])] : await memberIds(tx, c, v.members);
        } else throw new ScimError(400, `Unsupported operation on ${path || "group"}.`, "invalidPath");
      }
      await saveGroup(tx, c, before.id, name, ext, members, before);
    });
    return reply.status(204).send();
  });

  app.delete("/Groups/:id", async (req, reply) => {
    await run(req, async (tx, c) => {
      const g = await loadGroup(tx, c, (req.params as { id: string }).id);
      await tx.query("delete from scim_groups where id = $1", [g.id]);
      await record(tx, { tenantId: c.tenantId, actor: c.actor, entity: { type: "group", id: g.id }, action: "access.group-deleted", data: { group: g.display_name, members: g.members.length } });
      await recomputeRoles(tx, c.tenantId, g.members, c.actor);
    });
    return reply.status(204).send();
  });
}

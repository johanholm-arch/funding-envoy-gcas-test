// Sessions. The cookie carries a signed session id; the session row names the user and the tenant in scope.
import "@fastify/cookie";
// Internal users sign in through the tenant's identity provider in production (SAML/OIDC + SCIM); the demo
// environment offers a persona picker and passwordless email links for requestors.
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Actor, Role } from "@fe/core";
import { assertNotCommercial } from "@fe/core";
import { appendEvent, one, withContext, type DbContext, type Tx } from "@fe/db";

export const SESSION_COOKIE = "fe_session";
const SESSION_DAYS = 7;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  title?: string;
  kind: "internal" | "requestor" | "operator";
  tenantId?: string; // tenant in scope (internal: own tenant; requestor: portal tenant; operator: switched tenant)
  orgId?: string;
  roles: Role[];
  attributes: Record<string, unknown>;
  sessionId: string;
}

export function actorOf(u: SessionUser): Actor {
  return { type: "person", id: u.id, name: u.name, roles: u.roles };
}

export function dbContext(u: SessionUser): DbContext {
  return { tenantId: u.tenantId, orgId: u.kind === "requestor" ? u.orgId : undefined, operator: u.kind === "operator" };
}

export async function asUser<T>(u: SessionUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(dbContext(u), fn);
}

/** Opens a session and records the sign-in in the trail of the tenant it is for. */
export async function createSession(userId: string, tenantId: string | undefined, how: { method: string } = { method: "demo" }): Promise<string> {
  return withContext({ operator: true }, async (tx) => {
    const row = await one<{ id: string }>(tx, "insert into sessions (user_id, tenant_id, expires_at, data) values ($1, $2, now() + interval '7 days', $3) returning id", [userId, tenantId ?? null, JSON.stringify(how)]);
    if (tenantId) {
      const u = await one<{ name: string; roles: Role[] }>(tx, "select name, roles from auth_get_user($1)", [userId]);
      await appendEvent(tx, { tenantId, actor: { type: "person", id: userId, name: u?.name ?? "unknown", roles: u?.roles }, entity: { type: "session", id: row!.id }, action: "auth.signed-in", data: { method: how.method } });
      await tx.query("update users set last_sign_in_at = now() where id = $1", [userId]);
    }
    return row!.id;
  });
}

export async function loadSession(sessionId: string): Promise<SessionUser | undefined> {
  return withContext({ operator: true }, async (tx) => {
    const s = await one<{ user_id: string; tenant_id: string | null; expires_at: Date }>(tx, "select user_id, tenant_id, expires_at from sessions where id = $1", [sessionId]);
    if (!s || s.expires_at < new Date()) return undefined;
    const u = await one<{ id: string; email: string; name: string; title: string | null; kind: SessionUser["kind"]; tenant_id: string | null; org_id: string | null; roles: Role[]; attributes: Record<string, unknown>; active: boolean }>(tx, "select * from auth_get_user($1)", [s.user_id]);
    if (!u || !u.active) return undefined;
    return {
      id: u.id, email: u.email, name: u.name, title: u.title ?? undefined, kind: u.kind,
      tenantId: s.tenant_id ?? u.tenant_id ?? undefined, orgId: u.org_id ?? undefined,
      roles: u.roles, attributes: u.attributes ?? {}, sessionId,
    };
  });
}

export async function destroySession(u: SessionUser): Promise<void> {
  await withContext({ operator: true }, async (tx) => {
    await tx.query("delete from sessions where id = $1", [u.sessionId]);
    if (u.tenantId) await appendEvent(tx, { tenantId: u.tenantId, actor: actorOf(u), entity: { type: "session", id: u.sessionId }, action: "auth.signed-out" });
  });
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, { path: "/", httpOnly: true, sameSite: "lax", signed: true, maxAge: SESSION_DAYS * 86400, secure: process.env.NODE_ENV === "production" });
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "error") {
    super(message);
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function sessionHook(req: FastifyRequest): Promise<void> {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return;
  req.user = await loadSession(unsigned.value);
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, "Please sign in.", "unauthenticated");
  return req.user;
}

/** Internal user with at least one of the roles. Commercial roles are refused everywhere funding data lives (gate G2). */
export function requireRole(req: FastifyRequest, roles: Role[]): SessionUser {
  const u = requireUser(req);
  try {
    assertNotCommercial(actorOf(u));
  } catch (e) {
    throw new HttpError(403, (e as Error).message, "G2");
  }
  if (!u.roles.some((r) => roles.includes(r)) && u.kind !== "operator") {
    throw new HttpError(403, `This needs one of these roles: ${roles.join(", ")}.`, "forbidden");
  }
  if (!u.tenantId) throw new HttpError(400, "Choose a tenant first.", "no-tenant");
  return u;
}

export function requireTenantUser(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  try {
    assertNotCommercial(actorOf(u));
  } catch (e) {
    throw new HttpError(403, (e as Error).message, "G2");
  }
  if (!u.tenantId) throw new HttpError(400, "Choose a tenant first.", "no-tenant");
  return u;
}

export function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

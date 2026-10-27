import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { many, one, withContext } from "@fe/db";
import { createSession, destroySession, hashToken, HttpError, newToken, requireUser, setSessionCookie, SESSION_COOKIE } from "../auth.ts";
import { provider } from "../services/assistant.ts";

const DEMO = process.env.FE_DEMO !== "0";

export async function authRoutes(app: FastifyInstance) {
  // Demo personas: every seeded person and requestor, grouped by seat.
  app.get("/api/demo/personas", async () => {
    if (!DEMO) throw new HttpError(404, "Not found");
    return withContext({ operator: true }, async (tx) => {
      // Only tenants that are set up (a published catalogue); test fixtures in a shared database are left out.
      const tenants = await many<{ id: string; slug: string; name: string }>(tx, "select id, slug, name from tenants t where exists (select 1 from config_versions c where c.tenant_id = t.id and c.kind = 'catalogue' and c.status = 'published') order by name");
      const ids = tenants.map((t) => t.id);
      const people = await many<{ id: string; name: string; title: string | null; kind: string; roles: string[]; tenant_id: string | null; org_id: string | null; org_name: string | null }>(tx, `
        select u.id, u.name, u.title, u.kind, u.roles, u.tenant_id, u.org_id, o.legal_name as org_name
        from users u left join organizations o on o.id = u.org_id
        where u.active and u.email not like 'perf.%' and (u.kind = 'operator' or u.tenant_id = any($1) or (u.kind = 'requestor' and exists (select 1 from org_shares s where s.org_id = u.org_id and s.tenant_id = any($1))))
        order by u.kind, u.name`, [ids]);
      return { tenants, people };
    });
  });

  app.post("/api/auth/demo-login", async (req, reply) => {
    if (!DEMO) throw new HttpError(404, "Not found");
    const body = z.object({ userId: z.string().uuid(), tenantSlug: z.string().optional() }).parse(req.body);
    const ctx = await withContext({ operator: true }, async (tx) => {
      const u = await one<{ id: string; kind: string; tenant_id: string | null }>(tx, "select id, kind, tenant_id from users where id = $1 and active", [body.userId]);
      if (!u) throw new HttpError(404, "Unknown person.");
      let tenantId = u.tenant_id;
      if (u.kind === "internal") {
        const idp = await one<{ enforced: boolean }>(tx, "select enforced from identity_providers where tenant_id = $1", [u.tenant_id]);
        if (idp?.enforced) throw new HttpError(403, "This organization signs its people in through its own identity provider.", "sso-required");
      }
      if (u.kind !== "internal") {
        const slug = body.tenantSlug ?? process.env.FE_DEFAULT_TENANT ?? "halden";
        const t = await one<{ id: string }>(tx, "select id from tenants where slug = $1", [slug]);
        tenantId = t?.id ?? null;
      }
      return { userId: u.id, tenantId };
    });
    const sid = await createSession(ctx.userId, ctx.tenantId ?? undefined);
    setSessionCookie(reply, sid);
    return { ok: true };
  });

  // Passwordless sign-in for requestors. In the demo the link is shown on screen instead of emailed.
  app.post("/api/auth/magic-link", async (req) => {
    const body = z.object({ email: z.string().email(), tenantSlug: z.string() }).parse(req.body);
    const token = newToken();
    const found = await withContext({ operator: true }, async (tx) => {
      const t = await one<{ id: string }>(tx, "select id from tenants where slug = $1", [body.tenantSlug]);
      const u = await one<{ id: string }>(tx, "select id from users where lower(email) = lower($1) and active and kind = 'requestor'", [body.email]);
      if (!t || !u) return false;
      await tx.query("insert into magic_links (token_hash, email, tenant_id, expires_at) values ($1,$2,$3, now() + interval '15 minutes')", [hashToken(token), body.email, t.id]);
      await tx.query("insert into outbox (tenant_id, to_email, subject, body) values ($1,$2,'Your sign-in link',$3)", [t.id, body.email, `/api/auth/magic/${token}`]);
      return true;
    });
    // Same response whether or not the address exists, so the endpoint cannot be used to discover accounts.
    return { sent: true, ...(DEMO && found ? { demoLink: `/api/auth/magic/${token}` } : {}) };
  });

  app.get("/api/auth/magic/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const res = await withContext({ operator: true }, async (tx) => {
      const ml = await one<{ email: string; tenant_id: string; expires_at: Date; used_at: Date | null }>(tx, "select email, tenant_id, expires_at, used_at from magic_links where token_hash = $1", [hashToken(token)]);
      if (!ml || ml.used_at || ml.expires_at < new Date()) return undefined;
      await tx.query("update magic_links set used_at = now() where token_hash = $1", [hashToken(token)]);
      const u = await one<{ id: string }>(tx, "select id from users where lower(email) = lower($1)", [ml.email]);
      return u ? { userId: u.id, tenantId: ml.tenant_id } : undefined;
    });
    if (!res) return reply.redirect("/?signin=expired");
    setSessionCookie(reply, await createSession(res.userId, res.tenantId, { method: "email-link" }));
    return reply.redirect("/");
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.user) await destroySession(req.user);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const u = requireUser(req);
    const p = await provider();
    return withContext({ operator: true }, async (tx) => {
      const t = u.tenantId ? await one<{ id: string; slug: string; name: string; settings: Record<string, unknown> }>(tx, "select id, slug, name, settings from tenants where id = $1", [u.tenantId]) : undefined;
      const org = u.orgId ? await one<{ id: string; legal_name: string; country: string }>(tx, "select id, legal_name, country from organizations where id = $1", [u.orgId]) : undefined;
      return {
        user: { id: u.id, name: u.name, title: u.title, email: u.email, kind: u.kind, roles: u.roles },
        tenant: t ? { id: t.id, slug: t.slug, name: t.name, brand: t.settings.brand, words: t.settings.words, demo: Boolean(t.settings.demo) } : undefined,
        organization: org ? { id: org.id, name: org.legal_name, country: org.country } : undefined,
        assistant: { provider: p.name, model: p.model, label: p.name === "demo" ? "Demo assistant: reads labelled facts and keywords; no AI model is called" : `Claude (${p.model})` },
      };
    });
  });
}

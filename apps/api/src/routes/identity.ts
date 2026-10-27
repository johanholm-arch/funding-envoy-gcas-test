import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { many, one, withContext } from "@fe/db";
import { HttpError, requireTenantUser, setSessionCookie } from "../auth.ts";
import { authorizeUrl, DEMO_ISSUER, demoIdp, randomString, redeemCode } from "../oidc.ts";
import { ASSIGNABLE_ROLES, createScimToken, identitySettings, people, revokeScimToken, saveIdentitySettings, signInFromClaims, updatePerson } from "../services/identity.ts";

const DEMO = process.env.FE_DEMO !== "0";
const CALLBACK = "/api/auth/sso/callback";

const origin = (req: FastifyRequest) => process.env.FE_PUBLIC_URL ?? `${req.protocol}://${req.headers.host}`;
const safeReturn = (p?: string) => (p && p.startsWith("/") && !p.startsWith("//") ? p : "/");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const role = z.enum(ASSIGNABLE_ROLES as [string, ...string[]]);

export async function identityRoutes(app: FastifyInstance) {
  // Home-realm discovery: the email's domain decides which organization's identity provider signs the person in.
  app.get("/api/auth/sso/start", async (req, reply) => {
    const q = z.object({ email: z.string().email(), returnTo: z.string().optional() }).parse(req.query);
    const domain = (q.email.split("@")[1] ?? "").toLowerCase();
    const url = await withContext({ operator: true }, async (tx) => {
      const idp = await one<{ tenant_id: string; issuer: string; client_id: string }>(tx, "select tenant_id, issuer, client_id from auth_idp_for_domain($1)", [domain]);
      if (!idp) throw new HttpError(404, "Single sign-on is not set up for that address. Requestors sign in with an email link.", "no-idp");
      const state = randomString(), nonce = randomString(), verifier = randomString(48);
      await tx.query("insert into sso_states (state, tenant_id, nonce, code_verifier, return_to, expires_at) values ($1,$2,$3,$4,$5, now() + interval '10 minutes')", [state, idp.tenant_id, nonce, verifier, safeReturn(q.returnTo)]);
      return authorizeUrl(idp.issuer, { clientId: idp.client_id, redirectUri: origin(req) + CALLBACK, state, nonce, verifier, loginHint: q.email });
    });
    return reply.redirect(url);
  });

  app.get(CALLBACK, async (req, reply) => {
    const q = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() }).parse(req.query);
    const st = await withContext({ operator: true }, async (tx) => {
      const s = await one<{ tenant_id: string; nonce: string; code_verifier: string; return_to: string; expires_at: Date }>(tx, "delete from sso_states where state = $1 returning tenant_id, nonce, code_verifier, return_to, expires_at", [q.state]);
      if (!s || s.expires_at < new Date()) return undefined;
      const idp = await one<{ issuer: string; client_id: string; client_secret_ref: string | null }>(tx, "select issuer, client_id, client_secret_ref from identity_providers where tenant_id = $1", [s.tenant_id]);
      return idp ? { ...s, idp } : undefined;
    });
    if (!st) return reply.redirect("/?signin=expired");
    if (q.error || !q.code) return reply.redirect("/?signin=cancelled");
    const claims = await redeemCode(st.idp.issuer, {
      clientId: st.idp.client_id, clientSecret: st.idp.client_secret_ref ? process.env[st.idp.client_secret_ref] : undefined,
      redirectUri: origin(req) + CALLBACK, code: q.code, verifier: st.code_verifier, nonce: st.nonce,
    });
    const { sessionId } = await signInFromClaims(st.tenant_id, claims);
    setSessionCookie(reply, sessionId);
    return reply.redirect(st.return_to);
  });

  // The demo identity provider's sign-in page. It stands in for the organization's Okta or Entra ID.
  if (DEMO) {
    app.get("/demo-idp/authorize", async (req, reply) => {
      const q = z.object({ client_id: z.string(), redirect_uri: z.string().url(), state: z.string(), nonce: z.string(), code_challenge: z.string(), code_challenge_method: z.literal("S256"), login_hint: z.string().optional(), demo_groups: z.string().optional() }).parse(req.query);
      if (new URL(q.redirect_uri).pathname !== CALLBACK) throw new HttpError(400, "That redirect address is not registered.");
      const found = await withContext({ operator: true }, async (tx) => {
        const idp = await one<{ tenant_id: string; name: string }>(tx, "select i.tenant_id, t.name from identity_providers i join tenants t on t.id = i.tenant_id where i.client_id = $1 and i.issuer = $2", [q.client_id, DEMO_ISSUER]);
        if (!idp) return undefined;
        const directory = await many<{ email: string; name: string; external_id: string | null; groups: string[] | null }>(tx, `
          select u.email, u.name, u.external_id, (select array_agg(g.display_name) from scim_groups g where g.tenant_id = u.tenant_id and u.id = any(g.members)) as groups
          from users u where u.tenant_id = $1 and u.kind = 'internal' and u.active order by u.name`, [idp.tenant_id]);
        return { idp, directory };
      });
      if (!found) throw new HttpError(400, "Unknown client.");
      if (q.login_hint && (found.directory.some((d) => d.email.toLowerCase() === q.login_hint!.toLowerCase()) || q.demo_groups !== undefined)) {
        const d = found.directory.find((x) => x.email.toLowerCase() === q.login_hint!.toLowerCase());
        const who = d
          ? { email: d.email, name: d.name, groups: d.groups ?? [], sub: d.external_id ?? undefined }
          : { email: q.login_hint, name: (q.login_hint.split("@")[0] ?? "").replace(/[._]/g, " "), groups: q.demo_groups!.split(",").map((g) => g.trim()).filter(Boolean) };
        const code = demoIdp.issueCode({ clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, nonce: q.nonce, who });
        return reply.redirect(`${q.redirect_uri}?${new URLSearchParams({ code, state: q.state })}`);
      }
      const base = new URLSearchParams({ client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state, nonce: q.nonce, code_challenge: q.code_challenge, code_challenge_method: "S256" });
      const link = (email: string) => `/demo-idp/authorize?${base}&${new URLSearchParams({ login_hint: email })}`;
      reply.type("text/html");
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo identity provider</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1d1d1f;background:#fafaf8}h1{font-size:20px;margin:0 0 4px}p{color:#666;margin:0 0 24px}a{display:block;padding:10px 12px;border:1px solid #e3e3df;border-radius:8px;margin:6px 0;color:inherit;text-decoration:none;background:#fff}a:hover{border-color:#999}small{color:#888}</style></head>
<body><h1>Demo identity provider</h1><p>This page stands in for ${esc(found.idp.name)}'s company sign-in (Okta, Entra ID). Choose who you are.</p>
${found.directory.map((d) => `<a href="${esc(link(d.email))}">${esc(d.name)} <small>${esc(d.email)}${d.groups?.length ? ` · ${esc(d.groups.join(", "))}` : ""}</small></a>`).join("\n")}
</body></html>`;
    });
  }

  // ─── Access administration ─────────────────────────────────────────────────────────────────────────────────
  app.get("/api/admin/people", async (req) => people(requireTenantUser(req)));
  app.patch("/api/admin/people/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ roles: z.array(role).optional(), active: z.boolean().optional() }).parse(req.body);
    return updatePerson(requireTenantUser(req), id, b as Parameters<typeof updatePerson>[2]);
  });
  app.get("/api/admin/identity", async (req) => identitySettings(requireTenantUser(req)));
  app.put("/api/admin/identity", async (req) => {
    const b = z.object({
      issuer: z.string().url(), clientId: z.string().min(1), clientSecretRef: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().optional(),
      emailDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)), groupsClaim: z.string().default("groups"),
      roleMapping: z.record(z.string(), z.array(role)), jit: z.boolean(), enforced: z.boolean(),
    }).parse(req.body);
    return saveIdentitySettings(requireTenantUser(req), b as Parameters<typeof saveIdentitySettings>[1]);
  });
  app.post("/api/admin/scim-tokens", async (req) => {
    const { label } = z.object({ label: z.string().min(2).max(100) }).parse(req.body);
    return createScimToken(requireTenantUser(req), label);
  });
  app.delete("/api/admin/scim-tokens/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return revokeScimToken(requireTenantUser(req), id);
  });
}

// OpenID Connect sign-in for internal people. Authorization code flow with PKCE (S256), state and nonce.
// The ID token is verified here: RS256 signature against the provider's published keys, issuer, audience,
// expiry and nonce. Nothing in the token is trusted before that.
//
// The demo environment includes a stand-in identity provider (issuer DEMO_ISSUER) so the whole flow can be
// exercised without Okta or Entra. It runs in-process; the browser-facing authorize page is served at /demo-idp.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as rsaSign, verify as rsaVerify, type JsonWebKey } from "node:crypto";
import { HttpError } from "./auth.ts";

export const DEMO_ISSUER = "https://idp.demo.fundingenvoy.invalid";

export interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
export interface IdClaims { iss: string; sub: string; aud: string | string[]; exp: number; iat: number; nonce?: string; email?: string; email_verified?: boolean; name?: string; [k: string]: unknown }

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export const pkceChallenge = (verifier: string) => b64u(createHash("sha256").update(verifier).digest());
export const randomString = (n = 32) => randomBytes(n).toString("base64url");

// ─── Transport: real providers over HTTPS, the demo provider in-process ──────────────────────────────────────

interface Transport {
  discover(issuer: string): Promise<Discovery>;
  jwks(uri: string): Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;
  token(endpoint: string, form: Record<string, string>): Promise<{ id_token: string }>;
}

const httpTransport: Transport = {
  async discover(issuer) {
    const r = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!r.ok) throw new HttpError(502, "The identity provider could not be reached.", "idp-unreachable");
    return (await r.json()) as Discovery;
  },
  async jwks(uri) {
    const r = await fetch(uri);
    if (!r.ok) throw new HttpError(502, "The identity provider's keys could not be fetched.", "idp-unreachable");
    return (await r.json()) as { keys: JsonWebKey[] };
  },
  async token(endpoint, form) {
    const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
    if (!r.ok) throw new HttpError(401, "The identity provider did not accept the sign-in.", "idp-rejected");
    return (await r.json()) as { id_token: string };
  },
};

function transportFor(issuer: string): Transport {
  return issuer === DEMO_ISSUER ? demoIdp.transport : httpTransport;
}

// ─── Client ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function authorizeUrl(issuer: string, p: { clientId: string; redirectUri: string; state: string; nonce: string; verifier: string; loginHint?: string }): Promise<string> {
  const d = await transportFor(issuer).discover(issuer);
  const q = new URLSearchParams({
    response_type: "code", client_id: p.clientId, redirect_uri: p.redirectUri, scope: "openid email profile groups",
    state: p.state, nonce: p.nonce, code_challenge: pkceChallenge(p.verifier), code_challenge_method: "S256",
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  });
  return `${d.authorization_endpoint}?${q}`;
}

export async function redeemCode(issuer: string, p: { clientId: string; clientSecret?: string; redirectUri: string; code: string; verifier: string; nonce: string }): Promise<IdClaims> {
  const t = transportFor(issuer);
  const d = await t.discover(issuer);
  const res = await t.token(d.token_endpoint, {
    grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier,
    ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
  });
  return verifyIdToken(res.id_token, { issuer, clientId: p.clientId, nonce: p.nonce, jwks: await t.jwks(d.jwks_uri) });
}

export function verifyIdToken(token: string, o: { issuer: string; clientId: string; nonce: string; jwks: { keys: (JsonWebKey & { kid?: string })[] }; now?: number }): IdClaims {
  const fail = (why: string) => { throw new HttpError(401, `The sign-in token was not accepted (${why}).`, "id-token-invalid"); };
  const parts = token.split(".");
  if (parts.length !== 3) fail("malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string; kid?: string };
  if (header.alg !== "RS256") fail("algorithm");
  const jwk = o.jwks.keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) fail("unknown key");
  const ok = rsaVerify("sha256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk!, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) fail("signature");
  const c = JSON.parse(Buffer.from(p, "base64url").toString()) as IdClaims;
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (c.iss !== o.issuer) fail("issuer");
  if (!(Array.isArray(c.aud) ? c.aud.includes(o.clientId) : c.aud === o.clientId)) fail("audience");
  if (typeof c.exp !== "number" || c.exp < now - 60) fail("expired");
  if (c.nonce !== o.nonce) fail("nonce");
  if (!c.email || c.email_verified === false) fail("no verified email");
  return c;
}

// ─── Demo identity provider ──────────────────────────────────────────────────────────────────────────────────

export interface DemoIdentity { email: string; name: string; groups: string[]; sub?: string }

function createDemoIdp() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `demo-${randomString(4)}`;
  const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid, alg: "RS256", use: "sig" };
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; nonce: string; who: DemoIdentity; exp: number }>();

  const discovery: Discovery = { issuer: DEMO_ISSUER, authorization_endpoint: "/demo-idp/authorize", token_endpoint: `${DEMO_ISSUER}/token`, jwks_uri: `${DEMO_ISSUER}/jwks` };

  function issueCode(p: { clientId: string; redirectUri: string; challenge: string; nonce: string; who: DemoIdentity }): string {
    const code = randomString();
    codes.set(code, { ...p, exp: Date.now() + 60_000 });
    return code;
  }

  function signToken(claims: Record<string, unknown>): string {
    const h = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const p = b64u(JSON.stringify(claims));
    return `${h}.${p}.${b64u(rsaSign("sha256", Buffer.from(`${h}.${p}`), privateKey))}`;
  }

  const transport: Transport = {
    async discover() { return discovery; },
    async jwks() { return { keys: [jwk] }; },
    async token(_endpoint, form) {
      const code = form.code ?? "";
      const c = codes.get(code);
      codes.delete(code);
      if (!c || c.exp < Date.now() || c.clientId !== form.client_id || c.redirectUri !== form.redirect_uri || pkceChallenge(form.code_verifier ?? "") !== c.challenge) {
        throw new HttpError(401, "The identity provider did not accept the sign-in.", "idp-rejected");
      }
      const now = Math.floor(Date.now() / 1000);
      return { id_token: signToken({ iss: DEMO_ISSUER, aud: c.clientId, sub: c.who.sub ?? `demo|${c.who.email.toLowerCase()}`, iat: now, exp: now + 300, nonce: c.nonce, email: c.who.email, email_verified: true, name: c.who.name, groups: c.who.groups }) };
    },
  };

  return { transport, issueCode, signToken, kid };
}

export const demoIdp = createDemoIdp();

import { useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "../lib/api";
import { useMe, useToast } from "../lib/app";
import { fmtDate, fmtWhen, plural, roleWords } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";

interface Person { id: string; name: string; email: string; title?: string; roles: string[]; active: boolean; groups: string[]; lastSignIn: string | null; managedBy: "directory" | "here" }
interface PeopleRes { roles: string[]; people: Person[] }
interface Identity {
  sso: { issuer: string; clientId: string; clientSecretRef: string | null; emailDomains: string[]; groupsClaim: string; roleMapping: Record<string, string[]>; jit: boolean; enforced: boolean } | null;
  scimTokens: { id: string; label: string; created_by: string; created_at: string; last_used_at: string | null; revoked_at: string | null }[];
  groups: { id: string; name: string; members: number; roles: string[] }[];
  scimBaseUrl: string; redirectUri: string;
}

async function patch(url: string, body: unknown) {
  const r = await fetch(url, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That change was not saved.");
}
async function put(url: string, body: unknown) {
  const r = await fetch(url, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({})) as { error?: string; issues?: { path: string; message: string }[] };
  if (!r.ok) throw new Error(`${d.error ?? "Not saved."}${d.issues?.length ? ` ${d.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}` : ""}`);
}
async function del(url: string) {
  const r = await fetch(url, { method: "DELETE", credentials: "same-origin" });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Not revoked.");
}

/** People and roles. Sales roles exist only to be locked out; separation of duties is the platform's. */
export function People() {
  useDocumentTitle("People");
  const { me } = useMe();
  const toast = useToast();
  const res = useResource<PeopleRes>("/api/admin/people");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string>();
  const [roles, setRoles] = useState<string[]>([]);
  const [err, setErr] = useState<{ id: string; text: string }>();
  const [busy, setBusy] = useState(false);
  const people = (res.data?.people ?? []).filter((p) => !q || `${p.name} ${p.email} ${p.title ?? ""} ${p.roles.join(" ")}`.toLowerCase().includes(q.toLowerCase()));

  async function save(p: Person, body: { roles?: string[]; active?: boolean }, ok: string) {
    setBusy(true); setErr(undefined);
    try { await patch(`/api/admin/people/${p.id}`, body); toast(ok); setEditing(undefined); await res.refetch(); }
    catch (e) { setErr({ id: p.id, text: errorText(e) }); } finally { setBusy(false); }
  }

  return (
    <div className="page" style={{ maxWidth: 1160 }}>
      <div className="page-head">
        <span className="eyebrow">{me.tenant?.name} · access administration</span>
        <h1>People and roles</h1>
        <p className="lede">Roles decide what each person sees and does. People managed by the company directory change there; the rest change here. Every change is in the trail.</p>
      </div>
      <div><label className="label" htmlFor="pq">Find a person</label><input id="pq" className="input" style={{ maxWidth: 420 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or role" /></div>
      {res.error ? <p className="error-text">{res.error.message}</p> : null}
      <div style={{ borderTop: "1px solid var(--ink)" }}>
        {people.map((p) => {
          const self = p.id === me.user.id;
          const dir = p.managedBy === "directory";
          return (
            <div key={p.id} className="crow" style={{ gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1.4fr) auto", opacity: p.active ? 1 : 0.6 }}>
              <span>
                <strong style={{ fontWeight: 500 }}>{p.name}</strong>{self ? " (you)" : ""}<br />
                <span className="muted small">{p.title ?? p.email}</span><br />
                <span className="hash">{p.email} · {p.lastSignIn ? `last signed in ${fmtWhen(p.lastSignIn, { alwaysDate: true })}` : "never signed in"}{dir ? " · from the directory" : ""}</span>
              </span>
              <span>
                {editing === p.id ? (
                  <fieldset className="fieldset">
                    <legend className="sr-only">Roles for {p.name}</legend>
                    <div className="chips">
                      {(res.data?.roles ?? []).map((r) => (
                        <label key={r} className="check small" style={{ border: "1px solid var(--rule)", padding: "4px 8px" }}>
                          <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles((x) => (e.target.checked ? [...x, r] : x.filter((y) => y !== r)))} />
                          <span>{roleWords(r)}</span>
                        </label>
                      ))}
                    </div>
                    {roles.includes("sales") && roles.length > 1 ? <p className="error-text small">A sales role cannot be combined with funding roles; the platform keeps them apart (gate G2).</p> : null}
                  </fieldset>
                ) : (
                  <span className="chips">{p.roles.map((r) => <span key={r} className={`chip ${r === "sales" ? "warn" : ""}`}>{roleWords(r)}</span>)}{!p.active ? <span className="chip block">Deactivated</span> : null}</span>
                )}
                {err?.id === p.id ? <p className="error-text small" role="alert">{err.text}</p> : null}
              </span>
              <span className="row" style={{ justifyContent: "flex-end" }}>
                {self ? <span className="muted small">You can't change your own access.</span> : dir ? <span className="muted small">Change in the directory</span> : editing === p.id ? (
                  <>
                    <button type="button" className="btn small" disabled={busy} onClick={() => void save(p, { roles }, `Roles saved for ${p.name}`)}>Save</button>
                    <button type="button" className="btn small quiet" onClick={() => setEditing(undefined)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn small quiet" onClick={() => { setEditing(p.id); setRoles(p.roles); }}>Change roles</button>
                    <button type="button" className="btn small quiet" disabled={busy} onClick={() => void save(p, { active: !p.active }, p.active ? `${p.name} deactivated` : `${p.name} reactivated`)}>{p.active ? "Deactivate" : "Reactivate"}</button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Single sign-on, group-to-role mapping and SCIM provisioning. */
export function Identity() {
  useDocumentTitle("Single sign-on");
  const { me } = useMe();
  const toast = useToast();
  const res = useResource<Identity>("/api/admin/identity");
  const [form, setForm] = useState<NonNullable<Identity["sso"]>>();
  const [mapText, setMapText] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [newToken, setNewToken] = useState<{ token: string; note: string }>();

  useEffect(() => {
    const s = res.data?.sso ?? { issuer: "", clientId: "", clientSecretRef: null, emailDomains: [], groupsClaim: "groups", roleMapping: {}, jit: true, enforced: false };
    setForm(s);
    setMapText(Object.entries(s.roleMapping).map(([g, rs]) => `${g} = ${rs.join(", ")}`).join("\n"));
  }, [res.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const roleMapping: Record<string, string[]> = {};
    for (const line of mapText.split("\n")) {
      const m = /^\s*([^=]+?)\s*=\s*(.+)$/.exec(line);
      if (m) roleMapping[m[1]!] = m[2]!.split(",").map((x) => x.trim()).filter(Boolean);
    }
    setBusy(true); setErr(undefined);
    try { await put("/api/admin/identity", { ...form, clientSecretRef: form.clientSecretRef || null, roleMapping }); toast("Sign-on settings saved"); await res.refetch(); }
    catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }

  if (!form) return <div className="page narrow"><p className="muted small">{res.error ? res.error.message : "Loading…"}</p></div>;
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  return (
    <div className="page narrow">
      <div className="page-head">
        <span className="eyebrow">{me.tenant?.name} · access administration</span>
        <h1>Single sign-on and provisioning</h1>
        <p className="lede">Funder staff sign in through the company's identity provider. Groups in the directory map to roles here; SCIM keeps people in step.</p>
      </div>
      <form className="stack" style={{ gap: 14 }} onSubmit={save}>
        <h2>Identity provider (OpenID Connect)</h2>
        <div className="kv" style={{ alignItems: "center" }}>
          <label className="k" htmlFor="i-iss">Issuer</label><input id="i-iss" className="input" value={form.issuer} onChange={(e) => set("issuer", e.target.value)} placeholder="https://login.example.com" />
          <label className="k" htmlFor="i-cid">Client ID</label><input id="i-cid" className="input" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} />
          <label className="k" htmlFor="i-sec">Client secret reference</label><div className="stack" style={{ gap: 2 }}><input id="i-sec" className="input mono" value={form.clientSecretRef ?? ""} onChange={(e) => set("clientSecretRef", e.target.value || null)} placeholder="HALDEN_OIDC_SECRET" /><span className="help">The name of the secret in the vault, never the secret itself. Capitals, digits and underscores.</span></div>
          <label className="k" htmlFor="i-dom">Email domains</label><div className="stack" style={{ gap: 2 }}><input id="i-dom" className="input" value={form.emailDomains.join(", ")} onChange={(e) => set("emailDomains", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} /><span className="help">People with these addresses are sent to your provider.</span></div>
          <label className="k" htmlFor="i-gc">Groups claim</label><input id="i-gc" className="input" value={form.groupsClaim} onChange={(e) => set("groupsClaim", e.target.value)} />
          <span className="k">Redirect address</span><span className="mono small">{res.data?.redirectUri}</span>
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <label className="label" htmlFor="i-map">Groups to roles · one per line, "Group = role, role"</label>
          <textarea id="i-map" className="textarea mono" rows={8} style={{ fontSize: 12.5 }} value={mapText} onChange={(e) => setMapText(e.target.value)} />
          <span className="help">Roles: {["coordinator", "medical-reviewer", "compliance-reviewer", "legal", "committee-member", "committee-chair", "finance", "tax", "compliance-auditor", "process-owner", "access-admin", "sales"].join(", ")}.</span>
        </div>
        <label className="check"><input type="checkbox" checked={form.jit} onChange={(e) => set("jit", e.target.checked)} /><span>Create people on their first sign-in (just in time)</span></label>
        <label className="check"><input type="checkbox" checked={form.enforced} onChange={(e) => set("enforced", e.target.checked)} /><span>Require single sign-on for everyone at these domains (turns off other ways in)</span></label>
        {err ? <p className="error-text" role="alert">{err}</p> : null}
        <div><button type="submit" className="btn" disabled={busy}>Save sign-on settings</button></div>
      </form>

      <section className="stack" style={{ gap: 10 }} aria-labelledby="h-scim">
        <h2 id="h-scim">SCIM provisioning</h2>
        <p className="muted small">Base address <span className="mono">{res.data?.scimBaseUrl}</span>. {plural(res.data?.groups.length ?? 0, "group")} known from the directory.</p>
        <div style={{ borderTop: "1px solid var(--ink)" }}>
          {(res.data?.scimTokens ?? []).map((t) => (
            <div key={t.id} className="crow" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) auto" }}>
              <span>{t.label}</span>
              <span className="small muted">Created by {t.created_by}, {fmtDate(t.created_at)}{t.last_used_at ? ` · last used ${fmtWhen(t.last_used_at, { alwaysDate: true })}` : " · never used"}</span>
              <span>{t.revoked_at ? <span className="chip">Revoked {fmtDate(t.revoked_at)}</span> : <button type="button" className="btn small quiet danger" onClick={async () => { try { await del(`/api/admin/scim-tokens/${t.id}`); toast("Token revoked"); await res.refetch(); } catch (x) { setErr(errorText(x)); } }}>Revoke</button>}</span>
            </div>
          ))}
        </div>
        <form className="sign-row" onSubmit={async (e) => { e.preventDefault(); if (label.trim().length < 2) return; try { setNewToken(await api.post<{ token: string; note: string }>("/api/admin/scim-tokens", { label: label.trim() })); setLabel(""); await res.refetch(); } catch (x) { setErr(errorText(x)); } }}>
          <div className="stack" style={{ gap: 4, flex: "1 1 240px" }}><label className="label" htmlFor="t-label">New token for</label><input id="t-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Okta production" /></div>
          <button type="submit" className="btn quiet">Create token</button>
        </form>
        {newToken ? (
          <div className="panel" role="status">
            <p>{newToken.note}</p>
            <p className="mono small" style={{ overflowWrap: "anywhere", background: "var(--sunk)", padding: 10 }}>{newToken.token}</p>
            <div className="row"><button type="button" className="btn small quiet" onClick={() => void navigator.clipboard?.writeText(newToken.token).then(() => toast("Copied"))}>Copy</button><button type="button" className="btn small quiet" onClick={() => setNewToken(undefined)}>I've stored it</button></div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

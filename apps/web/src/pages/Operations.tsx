import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { useMe, useToast } from "../lib/app";
import { fmtDate, humanize, plural } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";

interface FleetRow { id: string; slug: string; name: string; color: string; region: string; residency: string; open: number; needsPerson: number; pastSla: number; assistantProfile: string; rulebook: { version: number }; packs: { id: string; version: number; verification: string }[]; nextDeadline?: { label: string; date: string } }
interface QueueRow { tenant: string; slug: string; request_id: string | null; ref: string | null; title: string; kind: string; assignee_role: string | null; due_at: string | null }
interface PackRow { id: string; version: number; name: string; jurisdiction: string; effectiveFrom: string; verification: string; rules: number; parameters: number; unverifiedParameters: string[]; adoptedBy: { tenant: string; version: number }[] }
interface Passports { organizations: number; sharedWithSeveralFunders: number; passportDocuments: number; documentsReused: number; organizationsList: { name: string; country: string; funders: number }[] }

/** The managed-service operator's view: every tenant in its own compartment, one queue across them. */
export function Operations() {
  useDocumentTitle("Operations");
  const { me, refresh } = useMe();
  const toast = useToast();
  const fleet = useResource<FleetRow[]>("/api/ops/fleet");
  const queue = useResource<QueueRow[]>("/api/ops/queue");
  const lib = useResource<PackRow[]>("/api/ops/library");
  const pass = useResource<Passports>("/api/ops/passports");
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const today = new Date();

  async function switchTo(t: FleetRow | null) {
    setBusy(t?.id ?? "none"); setErr(undefined);
    try {
      await api.post("/api/ops/switch", { tenantId: t?.id ?? null });
      await refresh();
      toast(t ? `Working in ${t.name}. The switch is in both trails.` : "Left the tenant");
    } catch (e) { setErr(errorText(e)); } finally { setBusy(undefined); }
  }

  const needs = (fleet.data ?? []).reduce((s, f) => s + f.needsPerson, 0);
  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="page-head">
        <span className="eyebrow">{fmtDate(today, { long: true })} · {plural(fleet.data?.length ?? 0, "tenant")}</span>
        <h1>One desk, separate books</h1>
        <p className="lede">Each tenant's data, rulebook, brand and models stay in its own compartment. You work across them from here; every switch into a tenant is logged on both sides.{me.tenant ? ` You are working in ${me.tenant.name}.` : ""}</p>
      </div>
      {err ? <p className="error-text" role="alert">{err}</p> : null}

      <section aria-labelledby="h-fleet" className="stack" style={{ gap: 6 }}>
        <h2 id="h-fleet">Fleet</h2>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th scope="col">Tenant</th><th scope="col" className="num">Open</th><th scope="col" className="num">Needs a person</th><th scope="col" className="num">Past SLA</th><th scope="col">Assistant</th><th scope="col">Region · residency</th><th scope="col">Next deadline</th><th scope="col">Rulebook</th><th scope="col"><span className="sr-only">Switch</span></th></tr></thead>
            <tbody>
              {(fleet.data ?? []).filter((t) => t.packs.length > 0).map((t) => (
                <tr key={t.id}>
                  <td><span className="row" style={{ flexWrap: "nowrap" }}><span className="dot" style={{ background: t.color }} aria-hidden="true" /><strong style={{ fontWeight: 500 }}>{t.name}</strong></span></td>
                  <td className="num">{t.open}</td><td className="num">{t.needsPerson}</td><td className="num">{t.pastSla ? <span className="chip block">{t.pastSla}</span> : 0}</td>
                  <td className="small">{humanize(t.assistantProfile)}</td>
                  <td className="small">{t.region} · {t.residency}</td>
                  <td className="small">{t.nextDeadline ? `${fmtDate(t.nextDeadline.date)} · ${t.nextDeadline.label}` : "None"}</td>
                  <td className="small mono">v{t.rulebook.version} · {plural(t.packs.length, "pack")}</td>
                  <td>{me.tenant?.id === t.id ? <span className="chip ok">You are here</span> : <button type="button" className="btn small quiet" disabled={Boolean(busy)} onClick={() => void switchTo(t)}>Work in {t.name}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(fleet.data ?? []).some((t) => !t.packs.length) ? <p className="muted small">{plural((fleet.data ?? []).filter((t) => !t.packs.length).length, "test tenant")} without a rulebook not shown.</p> : null}
        {me.tenant ? <div><button type="button" className="linkbtn small" onClick={() => void switchTo(null)} disabled={Boolean(busy)}>Leave {me.tenant.name}</button></div> : null}
      </section>

      <AddFunder templates={(fleet.data ?? []).filter((t) => t.packs.length > 0)} busy={Boolean(busy)} onCreated={() => void fleet.refetch()} onWorkIn={(t) => void switchTo(t)} />

      <section aria-labelledby="h-q" className="stack" style={{ gap: 6 }}>
        <h2 id="h-q">Needs a person today <span className="count">{queue.data?.length ?? needs}</span></h2>
        {queue.data && !queue.data.length ? <p className="muted small">Nothing across tenants needs a person right now.</p> : null}
        <div style={{ borderTop: queue.data?.length ? "1px solid var(--ink)" : undefined }}>
          {(queue.data ?? []).map((x, i) => (
            <div key={i} className="crow" style={{ gridTemplateColumns: "160px minmax(0,1fr) auto" }}>
              <span className="small">{x.tenant}</span>
              <span>{x.title}<span className="muted small">{x.assignee_role ? ` · ${humanize(x.assignee_role)}` : ""}</span></span>
              <span className="mono small">{x.due_at ? `due ${fmtDate(x.due_at)}` : x.ref ?? ""}</span>
            </div>
          ))}
        </div>
        <p className="muted small">Assignment follows each tenant's roster. Nobody sees two tenants on one screen except here.</p>
      </section>

      <section aria-labelledby="h-lib" className="stack" style={{ gap: 6 }}>
        <h2 id="h-lib">Rule library <span className="count">shared practice, tenant values</span></h2>
        <div style={{ borderTop: "1px solid var(--ink)" }}>
          {(lib.data ?? []).map((p) => (
            <div key={p.id} className="crow" style={{ gridTemplateColumns: "minmax(0,1.2fr) 130px minmax(0,1.4fr)" }}>
              <span>{p.name} <span className="note-basis">· {p.jurisdiction} · v{p.version} · from {fmtDate(p.effectiveFrom)}</span><br /><span className="muted small">{plural(p.rules, "rule")} · {plural(p.parameters, "parameter")}{p.unverifiedParameters.length ? ` · ${p.unverifiedParameters.length} not yet verified against the primary text` : ""}</span></span>
              <span><span className={`chip ${p.verification === "verified" ? "ok" : "warn"}`}>{p.verification === "verified" ? "Verified" : p.verification === "partial" ? "Partly verified" : "Unverified"}</span></span>
              <span className="small">{p.adoptedBy.length ? `Adopted by ${p.adoptedBy.map((a) => `${a.tenant} (v${a.version})`).join(", ")}` : "Not adopted yet"}</span>
            </div>
          ))}
        </div>
      </section>

      {pass.data ? (
        <section aria-labelledby="h-pass" className="stack" style={{ gap: 6 }}>
          <h2 id="h-pass">Organization passports</h2>
          <p className="small">{plural(pass.data.organizations, "organization")} registered; {pass.data.sharedWithSeveralFunders} share their passport with more than one funder · {plural(pass.data.passportDocuments, "passport document")} · {plural(pass.data.documentsReused, "reuse")}.</p>
          <div style={{ borderTop: "1px solid var(--ink)" }}>
            {pass.data.organizationsList.slice(0, 10).map((o) => <div key={o.name} className="crow" style={{ gridTemplateColumns: "minmax(0,1fr) 60px 120px" }}><span>{o.name}</span><span className="small">{o.country}</span><span className="small">{plural(o.funders, "funder")}</span></div>)}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const COUNTRIES = [{ id: "US", label: "United States" }, { id: "GB", label: "United Kingdom" }, { id: "FR", label: "France" }] as const;
interface Created { id: string; slug: string; name: string; countries: string[]; packs: string[]; people: { name: string; title: string; roles: string[] }[]; organizationsShared: number }

/** A new funder: its own name, colour, countries and people, starting from another funder's signed setup. */
function AddFunder({ templates, busy, onCreated, onWorkIn }: { templates: FleetRow[]; busy: boolean; onCreated: () => void; onWorkIn: (t: FleetRow) => void }) {
  const toast = useToast();
  const { signOut } = useMe();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#1F6F8B");
  const [countries, setCountries] = useState<string[]>(["US"]);
  const [owner, setOwner] = useState("");
  const [template, setTemplate] = useState("");
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<Created>();
  const from = templates.find((t) => t.id === template) ?? templates.find((t) => t.slug === "halden") ?? templates[0];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) { setErr("Give the funder a name."); return; }
    if (!countries.length) { setErr("Choose at least one country."); return; }
    setWorking(true); setErr(undefined);
    try {
      const r = await api.post<Created>("/api/ops/funders", { name: name.trim(), color, countries, processOwnerName: owner.trim() || undefined, templateTenantId: from?.id });
      setDone(r); setName(""); setOwner(""); onCreated(); toast(`${r.name} is ready`);
    } catch (x) { setErr(errorText(x)); } finally { setWorking(false); }
  }

  return (
    <section aria-labelledby="h-add" className="stack" style={{ gap: 10 }}>
      <h2 id="h-add">Add a funder</h2>
      <p className="muted small">A new funder starts from another funder's signed setup: its request types, rules, workflow, policy and test set. It gets its own name, colour, countries and people, and from then on it changes only through its own Studio.</p>
      <form className="panel calm stack" style={{ gap: 14, maxWidth: 720 }} onSubmit={submit}>
        <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
          <div className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
            <label className="label" htmlFor="nf-name">Funder name</label>
            <input id="nf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Biosciences" maxLength={60} />
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <label className="label" htmlFor="nf-color">Brand colour</label>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input id="nf-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 44, height: 44, padding: 0, border: "1px solid var(--ink)", borderRadius: 2 }} />
              <input className="input mono" style={{ width: 110 }} value={color} onChange={(e) => setColor(e.target.value)} aria-label="Colour as hex" />
            </div>
          </div>
        </div>
        <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Countries it funds in</legend>
          <div className="row" style={{ gap: 18 }}>
            {COUNTRIES.map((c) => (
              <label key={c.id} className="row small" style={{ gap: 6, flexWrap: "nowrap" }}>
                <input type="checkbox" checked={countries.includes(c.id)} onChange={(e) => setCountries((xs) => e.target.checked ? [...xs, c.id] : xs.filter((x) => x !== c.id))} />{c.label}
              </label>
            ))}
          </div>
          <p className="help">Each country brings its own set of rules. Requesting organizations in these countries can apply to the new funder.</p>
        </fieldset>
        <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
          <div className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
            <label className="label" htmlFor="nf-owner">Process owner's name</label>
            <input id="nf-owner" className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Alex Morgan" maxLength={80} />
            <p className="help">The person who signs changes in Studio. A demo team is added for every other seat.</p>
          </div>
          {templates.length > 1 ? (
            <div className="stack" style={{ gap: 4, flex: "1 1 220px" }}>
              <label className="label" htmlFor="nf-from">Start from the setup of</label>
              <select id="nf-from" className="select" value={from?.id ?? ""} onChange={(e) => setTemplate(e.target.value)}>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          ) : null}
        </div>
        {err ? <p className="error-text" role="alert">{err}</p> : null}
        <div><button type="submit" className="btn" disabled={working || busy}>{working ? "Setting it up…" : "Add funder"}</button></div>
      </form>
      {done ? (
        <div className="panel stack" style={{ gap: 8, maxWidth: 720 }} aria-live="polite">
          <h3 style={{ fontSize: 18, margin: 0 }}>{done.name} is ready</h3>
          <p className="small">Its {plural(done.people.length, "person", "people")} are in the sign-in list under {done.name}. {plural(done.organizationsShared, "requesting organization")} can apply to it. Rules for: {done.countries.join(", ")}.</p>
          <p className="small">Next: sign in as <strong style={{ fontWeight: 500 }}>{done.people[0]?.name}</strong> (process owner) and open Studio to add the logo and adjust the setup.</p>
          <div className="row">
            <button type="button" className="btn small" onClick={() => void signOut().then(() => navigate(`/sign-in?funder=${encodeURIComponent(done.slug)}`, { replace: true }))}>Go to {done.name}'s sign-in list</button>
            {(() => { const t = templates.find((x) => x.id === done.id); return t ? <button type="button" className="btn small quiet" onClick={() => onWorkIn(t)}>Work in {done.name} as operator</button> : null; })()}
          </div>
        </div>
      ) : null}
    </section>
  );
}

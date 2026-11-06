// Studio · Connect to Salesforce. The process owner connects the funder's Salesforce org, lets FundingEnvoy read how
// its grants app is built, confirms how fields, values, documents and statuses match, tries it with a sample
// request, and saves a draft that is published with the rest of the setup. No code for a new company.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { hasRole, useMe, useToast } from "../lib/app";
import { fmtDate, plural } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";

interface SfField { name: string; label: string; type: string; required?: boolean; picklist?: string[]; readOnly?: boolean; externalId?: boolean; length?: number }
interface SfObject { name: string; label: string; fields: SfField[] }
interface FeField { key: string; label: string; kind: string; required: boolean; options?: { value: string; label: string }[] }
interface Config {
  system: "salesforce"; mode: "simulated" | "live"; enabled: boolean;
  connection: { myDomain: string; siteUrl: string; apiVersion: string }; snapshotHash?: string;
  objects: { organization: string; request: string; document: string; comment: string };
  systemFields: Record<string, string>;
  statusValues: { draft: string; submitted: string; infoRequested: string; approved: string; declined: string; closed: string };
  fields: { fe: string; sf: string }[];
  values: Record<string, Record<string, string>>;
  documents: Record<string, string>;
  matching: { identifiers: boolean; byName: boolean };
  checkpoints: { organization: boolean; draft: boolean; documents: boolean; submit: boolean };
  events: { status: boolean; comments: boolean };
}
interface View {
  funder: string; defaults: { myDomain: string; apiVersion: string }; connected: boolean;
  limits?: { DailyApiRequests: { Max: number; Remaining: number } };
  snapshot?: { hash: string; readBy: string; readAt: string; org: { name: string; edition: string; apiVersion: string; myDomain: string }; objects: SfObject[]; validationRules: { object: string; name: string; description: string; errorMessage: string }[]; duplicateRules: { object: string; name: string; description: string }[]; flows: { name: string; description: string }[] };
  config?: Config; configSource: "draft" | "published" | "suggested" | "none";
  draft?: { version: number }; published?: { version: number; signedName: string; signedAt: string; enabled: boolean };
  suggestion?: { fields: { fe: string; sf: string }[]; reasons: Record<string, string>; valueReasons: Record<string, Record<string, string>> };
  feFields: FeField[]; feDocTypes: { type: string; label: string }[];
  health: { cursor: number; cursorAt?: string; links: Record<string, number> };
  issues: { severity: "error" | "warning"; where?: string; message: string }[];
  live: Live;
}
interface Live {
  configured: boolean; myDomain?: string; clientIdHint?: string; savedBy?: string; savedAt?: string;
  lastTest?: { ok: boolean; at: string; error?: string; message?: string; org?: { name: string; edition: string; sandbox: boolean; instance?: string; apiVersion: string }; user?: { username?: string; name?: string }; limits?: { DailyApiRequests: { Max: number; Remaining: number } } };
  snapshot?: { readBy: string; readAt: string; org: { name: string }; objects: { name: string; label: string; fields: number; custom: boolean }[]; validationRules: { object: string; name: string; description: string; errorMessage: string }[]; found?: { totalObjects: number; customObjects: number }; note?: string };
}
interface TestResult { org: { name: string; edition: string; apiVersion: string; myDomain: string }; limits: { DailyApiRequests: { Max: number; Remaining: number } }; identity: { integrationUser: string; profile: string; permissionSet: string } }
interface Trial { ok: boolean; sample: string; payload: Record<string, unknown>; result: { id?: string; success: boolean; note?: string; errors?: { errorCode: string; message: string; fields: string[] }[] } }

const STATUS_LABEL: Record<keyof Config["statusValues"], string> = { draft: "Saved as a draft", submitted: "Submitted by the requestor", infoRequested: "Grants team asks for information", approved: "Approved", declined: "Declined", closed: "Closed" };

export function StudioConnect() {
  useDocumentTitle("Connect to Salesforce");
  const { me } = useMe();
  const toast = useToast();
  const v = useResource<View>("/api/connect/salesforce");
  const canEdit = hasRole(me, "process-owner", "operator");
  const [cfg, setCfg] = useState<Config>();
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<"simulated" | "live">("simulated");
  const [domain, setDomain] = useState("");
  const [test, setTest] = useState<TestResult>();
  const [trial, setTrial] = useState<Trial>();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<{ where: string; text: string }>();
  const [showAll, setShowAll] = useState(false);

  useEffect(() => { if (v.data) { setCfg(v.data.config); setDirty(false); setDomain((d) => d || v.data!.config?.connection.myDomain || v.data!.defaults.myDomain); } }, [v.data]);
  const liveSaved = Boolean(v.data?.live.configured);
  useEffect(() => { if (liveSaved) setMode("live"); }, [liveSaved]);
  const snap = v.data?.snapshot;
  const reqObj = snap?.objects.find((o) => o.name === (cfg?.objects.request ?? "gx__Request__c"));
  const docObj = snap?.objects.find((o) => o.name === (cfg?.objects.document ?? "ContentVersion"));
  const sys = useMemo(() => new Set(Object.values(cfg?.systemFields ?? {})), [cfg]);

  async function run<T>(key: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    setBusy(key); setErr(undefined);
    try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { setErr({ where: key, text: errorText(e) }); return undefined; } finally { setBusy(undefined); }
  }
  const change = (fn: (c: Config) => Config) => { setCfg((c) => (c ? fn(c) : c)); setDirty(true); setTrial(undefined); };

  if (v.error) return <div className="page narrow"><p className="error-text">{v.error.message}</p></div>;
  if (!v.data) return <div className="page narrow"><p className="muted">Loading…</p></div>;
  const d = v.data;
  const fail = (k: string) => (err?.where === k ? <p className="error-text" role="alert">{err.text}</p> : null);

  const mapOf = new Map(cfg?.fields.map((m) => [m.fe, m.sf]) ?? []);
  const fieldsSorted = [...d.feFields].sort((a, b) => Number(mapOf.has(b.key)) - Number(mapOf.has(a.key)));
  const unmatched = d.feFields.filter((f) => !mapOf.has(f.key));
  const requiredSf = reqObj?.fields.filter((f) => f.required && !f.readOnly && !sys.has(f.name)) ?? [];
  const pickMapped = cfg?.fields.map((m) => ({ m, fe: d.feFields.find((x) => x.key === m.fe), sf: reqObj?.fields.find((x) => x.name === m.sf) })).filter((x) => x.fe?.options && x.sf?.type === "picklist") ?? [];

  return (
    <div className="page" style={{ maxWidth: 1040 }}>
      <div className="page-head">
        <span className="eyebrow"><Link to="/studio">Studio</Link> · Connections</span>
        <h1>Connect to Salesforce</h1>
        <p className="lede">For funders whose grants already run on Salesforce. {d.funder}'s requests are prepared and checked here, then written into Salesforce in the requestor's own name. Salesforce keeps the record and every decision; its news comes back here.</p>
        <p className="status-line">
          {d.published ? <>Connection v{d.published.version} is in use, signed by {d.published.signedName} on {fmtDate(d.published.signedAt)}.{" "}</> : "Not in use yet. "}
          {d.draft ? <>Draft v{d.draft.version} is waiting to be published. </> : null}
          {d.published?.enabled ? <Link to="/salesforce">Open the simulated Salesforce</Link> : null}
        </p>
      </div>

      <Step n={1} title="Connection" done={mode === "live" ? Boolean(d.live.lastTest?.ok) : d.connected} lead="Which Salesforce org, and how FundingEnvoy signs in to it.">
        <div className="connect-modes" role="radiogroup" aria-label="Which org">
          <button type="button" role="radio" aria-checked={mode === "simulated"} className="setup-card connect-mode" onClick={() => setMode("simulated")}>
            <span style={{ fontWeight: 600 }}>Simulated org</span>
            <span className="small muted">A Salesforce org FundingEnvoy runs itself, with a packaged grants app, its rules and its events. For demos and testing; it behaves like the real thing.</span>
          </button>
          <button type="button" role="radio" aria-checked={mode === "live"} className="setup-card connect-mode" onClick={() => setMode("live")}>
            <span style={{ fontWeight: 600 }}>Your company's org</span>
            <span className="small muted">Your Salesforce org, or a test copy of it. Needs an External Client App created by your Salesforce admin. Read-only for now: test the connection and read the org.</span>
          </button>
        </div>
        {mode === "live" ? <LiveConnect live={d.live} canEdit={canEdit} onChanged={() => void v.refetch()} /> : (<>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="stack" style={{ gap: 4, flex: "1 1 320px" }}>
            <label className="label" htmlFor="sf-domain">My Domain</label>
            <input id="sf-domain" className="input" value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} disabled={!canEdit} />
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <span className="label">API version</span>
            <span className="input" style={{ display: "flex", alignItems: "center", background: "var(--sunk)" }}>{d.defaults.apiVersion}</span>
          </div>
          {canEdit ? <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void run("test", () => api.post<TestResult>("/api/connect/salesforce/test", { mode, myDomain: domain }), "Connected").then((r) => { if (r) { setTest(r); void v.refetch(); } })}>{busy === "test" ? "Connecting…" : "Test connection"}</button> : null}
        </div>
        {fail("test")}
        {test ? (
          <dl className="connect-facts">
            <div><dt>Org</dt><dd>{test.org.name} · {test.org.edition}</dd></div>
            <div><dt>API version</dt><dd>{test.org.apiVersion}</dd></div>
            <div><dt>API calls left today</dt><dd>{test.limits.DailyApiRequests.Remaining.toLocaleString("en-US")} of {test.limits.DailyApiRequests.Max.toLocaleString("en-US")}</dd></div>
            <div><dt>Signs in as</dt><dd>{test.identity.integrationUser} · {test.identity.profile} · permission set “{test.identity.permissionSet}”, for background work. Requests are written as the requestor.</dd></div>
          </dl>
        ) : d.connected && d.limits ? <p className="small" style={{ color: "var(--accent)" }}>Connected. {d.limits.DailyApiRequests.Remaining.toLocaleString("en-US")} of {d.limits.DailyApiRequests.Max.toLocaleString("en-US")} API calls left today.</p> : null}
        </>)}
      </Step>

      {mode === "live" ? <LiveRead live={d.live} canEdit={canEdit} onChanged={() => void v.refetch()} /> : (<>
      <Step n={2} title="Read the org" done={Boolean(snap)} lead="FundingEnvoy reads the grants app's objects, fields, lists of values and the checks Salesforce runs on save. Nothing is hard-coded.">
        {canEdit ? <div><button type="button" className={`btn ${snap ? "quiet" : ""}`} disabled={!d.connected || Boolean(busy)} onClick={() => void run("read", () => api.post<{ changes: string[] }>("/api/connect/salesforce/read", { myDomain: domain }), "Org read").then((r) => { if (r) void v.refetch(); })}>{busy === "read" ? "Reading…" : snap ? "Read the org again" : "Read the org"}</button></div> : null}
        {!d.connected ? <p className="help">Test the connection first.</p> : null}
        {fail("read")}
        {snap ? (
          <>
            <p className="small">Read {fmtDate(snap.readAt)} by {snap.readBy}: {snap.org.name}, {plural(snap.objects.length, "object")}, {plural(snap.objects.reduce((n, o) => n + o.fields.length, 0), "field")}.</p>
            <table className="connect-table">
              <thead><tr><th>Object</th><th>API name</th><th>Fields</th></tr></thead>
              <tbody>{snap.objects.map((o) => <tr key={o.name}><td>{o.label}</td><td className="mono small">{o.name}</td><td>{o.fields.length}</td></tr>)}</tbody>
            </table>
            <details>
              <summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>What Salesforce checks on every save ({snap.validationRules.length + snap.duplicateRules.length})</summary>
              <ul className="setup-checks">
                {snap.validationRules.map((r) => <li key={r.name}><span>{r.description}</span><span className="help">Validation rule <span className="mono">{r.name}</span> on {r.object}: “{r.errorMessage}”</span></li>)}
                {snap.duplicateRules.map((r) => <li key={r.name}><span>{r.description}</span><span className="help">Duplicate rule <span className="mono">{r.name}</span> on {r.object}</span></li>)}
                {snap.flows.map((r) => <li key={r.name}><span>{r.description}</span><span className="help">Flow <span className="mono">{r.name}</span></span></li>)}
              </ul>
            </details>
          </>
        ) : null}
      </Step>

      {cfg && snap && reqObj ? (
        <>
          <Step n={3} title="Match the fields" done={!d.issues.some((i) => i.severity === "error")} lead={`Which ${reqObj.label} field each FundingEnvoy answer goes to. FundingEnvoy suggested every match below; change any you disagree with.`}>
            <div className="chips" aria-label="Fields Salesforce requires">
              <span className="small muted" style={{ alignSelf: "center" }}>Salesforce requires:</span>
              {requiredSf.map((f) => <span key={f.name} className={`chip ${cfg.fields.some((m) => m.sf === f.name) ? "ok" : "block"}`}>{f.label}</span>)}
              <span className="chip sys" title="Set by FundingEnvoy itself">Organization, Status: set by FundingEnvoy</span>
            </div>
            <table className="connect-table">
              <thead><tr><th>FundingEnvoy</th><th>Salesforce field</th><th>Why</th></tr></thead>
              <tbody>
                {fieldsSorted.filter((f) => showAll || mapOf.has(f.key)).map((f) => {
                  const cur = mapOf.get(f.key) ?? "";
                  return (
                    <tr key={f.key}>
                      <td><span>{f.label}</span>{f.required ? <span className="help"> · required</span> : null}<br /><span className="mono help">{f.key}</span></td>
                      <td>
                        <select className="select small" aria-label={`Salesforce field for ${f.label}`} value={cur} disabled={!canEdit} onChange={(e) => change((c) => ({ ...c, fields: e.target.value ? [...c.fields.filter((m) => m.fe !== f.key), { fe: f.key, sf: e.target.value }] : c.fields.filter((m) => m.fe !== f.key) }))}>
                          <option value="">Not sent</option>
                          {reqObj.fields.filter((x) => !x.readOnly && !sys.has(x.name)).map((x) => <option key={x.name} value={x.name}>{x.label} ({x.type})</option>)}
                        </select>
                      </td>
                      <td className="small muted">{cur ? (d.suggestion?.reasons[f.key] && d.suggestion.fields.find((m) => m.fe === f.key)?.sf === cur ? d.suggestion.reasons[f.key] : "Your choice") : "Only in the review summary"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div><button type="button" className="btn small quiet" onClick={() => setShowAll((s) => !s)}>{showAll ? "Show matched fields only" : `Show the ${unmatched.length} fields not sent`}</button></div>

            <h3 className="connect-h3">Values in lists</h3>
            <p className="small muted">Where Salesforce has a fixed list, each FundingEnvoy answer becomes one of its values.</p>
            {pickMapped.map(({ m, fe, sf }) => {
              const map = cfg.values[m.sf] ?? {};
              const done = fe!.options!.filter((o) => map[o.value]).length;
              return (
                <details key={m.sf} className="connect-values" open={done < fe!.options!.length}>
                  <summary><span style={{ fontWeight: 500 }}>{fe!.label} → {sf!.label}</span> <span className={`chip ${done === fe!.options!.length ? "ok" : "warn"}`}>{done} of {fe!.options!.length} matched</span></summary>
                  <table className="connect-table">
                    <tbody>{fe!.options!.map((o) => (
                      <tr key={o.value}>
                        <td>{o.label}</td>
                        <td><select className="select small" aria-label={`Salesforce value for ${o.label}`} value={map[o.value] ?? ""} disabled={!canEdit} onChange={(e) => change((c) => ({ ...c, values: { ...c.values, [m.sf]: { ...(c.values[m.sf] ?? {}), [o.value]: e.target.value } } }))}>
                          <option value="">Choose…</option>{sf!.picklist!.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </details>
              );
            })}

            <h3 className="connect-h3">Documents</h3>
            <table className="connect-table">
              <tbody>{d.feDocTypes.map((t) => (
                <tr key={t.type}><td>{t.label}</td><td><select className="select small" aria-label={`Salesforce category for ${t.label}`} value={cfg.documents[t.type] ?? "Other"} disabled={!canEdit} onChange={(e) => change((c) => ({ ...c, documents: { ...c.documents, [t.type]: e.target.value } }))}>
                  {(docObj?.fields.find((x) => x.name === cfg.systemFields.documentCategory)?.picklist ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
                </select></td></tr>
              ))}</tbody>
            </table>

            <h3 className="connect-h3">Statuses</h3>
            <table className="connect-table">
              <tbody>{(Object.keys(STATUS_LABEL) as (keyof Config["statusValues"])[]).map((k) => (
                <tr key={k}><td>{STATUS_LABEL[k]}</td><td><select className="select small" aria-label={`Salesforce status for ${STATUS_LABEL[k]}`} value={cfg.statusValues[k]} disabled={!canEdit} onChange={(e) => change((c) => ({ ...c, statusValues: { ...c.statusValues, [k]: e.target.value } }))}>
                  {(reqObj.fields.find((x) => x.name === cfg.systemFields.requestStatus)?.picklist ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
                </select></td></tr>
              ))}</tbody>
            </table>
          </Step>

          <Step n={4} title="Organizations and checkpoints" lead="How FundingEnvoy finds the organization before creating anything, and when it writes to Salesforce.">
            <label className="row small"><input type="checkbox" checked={cfg.matching.identifiers} disabled={!canEdit} onChange={(e) => change((c) => ({ ...c, matching: { ...c.matching, identifiers: e.target.checked } }))} /> Match organizations by tax ID or registration number</label>
            <label className="row small"><input type="checkbox" checked={cfg.matching.byName} disabled={!canEdit} onChange={(e) => change((c) => ({ ...c, matching: { ...c.matching, byName: e.target.checked } }))} /> Then by name</label>
            <p className="help">FundingEnvoy never collects bank details; the payee record stays with Salesforce's own flow.</p>
            <ol className="connect-checkpoints">
              <li><strong>Organization</strong> found or created</li>
              <li><strong>Request</strong> saved as a draft, in one call that succeeds or fails whole</li>
              <li><strong>Documents</strong> attached as Salesforce Files, with their category</li>
              <li><strong>Submitted</strong> in the requestor's name, with their typed attestation and the review summary. Always on.</li>
            </ol>
            <p className="small muted">In the simulation all four run the moment the requestor submits. If Salesforce refuses any of them, nothing is submitted and the requestor sees why in plain words.</p>
            <label className="row small"><input type="checkbox" checked={cfg.events.status} disabled={!canEdit} onChange={(e) => change((c) => ({ ...c, events: { ...c.events, status: e.target.checked } }))} /> Hear about status changes (information requested, approved, declined, closed)</label>
            <label className="row small"><input type="checkbox" checked={cfg.events.comments} disabled={!canEdit} onChange={(e) => change((c) => ({ ...c, events: { ...c.events, comments: e.target.checked } }))} /> Hear about coordinators' comments to the requestor</label>
          </Step>

          <Step n={5} title="Try it" done={trial?.ok} lead="Sends a sample request through this mapping to Salesforce, shows exactly what was sent and Salesforce's answer, then removes it again.">
            {canEdit ? <div><button type="button" className="btn quiet" disabled={Boolean(busy)} onClick={() => void run("trial", () => api.post<Trial>("/api/connect/salesforce/trial", { config: cfg })).then((r) => r && setTrial(r))}>{busy === "trial" ? "Trying…" : "Run a trial"}</button></div> : null}
            {fail("trial")}
            {trial ? (
              <div className={`connect-result ${trial.ok ? "ok" : "bad"}`} aria-live="polite">
                <p className="small"><strong>{trial.ok ? "Salesforce accepted it." : "Salesforce refused it."}</strong> Sample: {trial.sample}. {trial.ok ? trial.result.note : null}</p>
                {trial.result.errors?.map((e, i) => <p key={i} className="error-text">{e.message} <span className="mono help">{e.errorCode}{e.fields.length ? ` · ${e.fields.join(", ")}` : ""}</span></p>)}
                <details><summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>What was sent ({plural(Object.keys(trial.payload).length, "field")})</summary><pre className="connect-json">{JSON.stringify(trial.payload, null, 2)}</pre></details>
              </div>
            ) : null}
          </Step>

          <section className="panel" aria-labelledby="h-save">
            <h2 id="h-save" style={{ fontSize: 20 }}>Save and publish</h2>
            {d.issues.length && !dirty ? (
              <div className="stack" style={{ gap: 4 }}>
                {d.issues.map((i, n) => <p key={n} className={i.severity === "error" ? "error-text" : "small"} style={{ color: i.severity === "warning" ? "var(--warn)" : undefined }}>{i.message}</p>)}
              </div>
            ) : !dirty ? <p className="small" style={{ color: "var(--accent)" }}>No problems found.</p> : <p className="small muted">You have changes that aren't saved yet.</p>}
            <div className="row">
              {canEdit ? <button type="button" className="btn" disabled={Boolean(busy) || (!dirty && d.configSource !== "suggested")} onClick={() => void run("save", () => api.post<{ version: number }>("/api/connect/salesforce/config", { config: cfg }), "Saved as a draft").then((r) => { if (r) void v.refetch(); })}>{busy === "save" ? "Saving…" : d.configSource === "suggested" && !dirty ? "Save the suggested mapping as a draft" : "Save as a draft"}</button> : null}
              {d.draft ? <Link className="btn quiet" to="/studio?step=6">Check and publish</Link> : null}
            </div>
            {fail("save")}
            <p className="help">Publishing is your signature, with the rest of the setup in Studio. From then on, every submitted request goes to Salesforce; requests already submitted stay where they are.</p>
          </section>

          {d.published ? (
            <section className="stack" style={{ gap: 6 }} aria-labelledby="h-health">
              <h2 id="h-health" style={{ fontSize: 20 }}>Running</h2>
              <p className="small">{plural(d.health.links.request ?? 0, "request")} and {plural(d.health.links.organization ?? 0, "organization")} linked to Salesforce records. Events processed up to replay ID {d.health.cursor}{d.health.cursorAt ? `, last at ${fmtDate(d.health.cursorAt)}` : ""}.</p>
            </section>
          ) : null}
        </>
      ) : null}
      </>)}
    </div>
  );
}

function Step({ n, title, lead, done, children }: { n: number; title: string; lead: string; done?: boolean; children: ReactNode }) {
  return (
    <section className="stack connect-step" style={{ gap: 12 }} aria-labelledby={`h-step-${n}`}>
      <div className="row" style={{ gap: 10 }}>
        <span className="connect-n" aria-hidden>{done ? "✓" : n}</span>
        <h2 id={`h-step-${n}`} style={{ fontSize: 22 }}>{title}</h2>
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>{lead}</p>
      {children}
    </section>
  );
}

// ─── The company's own org ──────────────────────────────────────────────────

function LiveConnect({ live, canEdit, onChanged }: { live: Live; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [domain, setDomain] = useState(live.myDomain ?? "");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [editing, setEditing] = useState(!live.configured);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  async function run(k: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(k); setErr(undefined);
    try { await fn(); toast(ok); onChanged(); return true; } catch (e) { setErr(errorText(e)); onChanged(); return false; } finally { setBusy(undefined); }
  }
  async function saveAndTest() {
    if (!(await run("save", () => api.post("/api/connect/salesforce/live/credentials", { myDomain: domain, clientId: key || undefined, clientSecret: secret || undefined }), "Saved"))) return;
    setEditing(false); setKey(""); setSecret("");
    await run("test", () => api.post("/api/connect/salesforce/live/test"), "Connected to Salesforce");
  }
  const t = live.lastTest;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="small">Read-only: FundingEnvoy signs in, reads who it is and what the org looks like, and writes nothing. <a href="https://github.com/johanholm-arch/funding-envoy-gcas-test/blob/main/docs/SALESFORCE-TEST-CONNECTION.md" target="_blank" rel="noreferrer">How to set up the Salesforce side</a></p>
      {live.configured && !editing ? (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small">Saved: <span className="mono">{live.myDomain}</span> · consumer key <span className="mono">{live.clientIdHint}</span> · secret stored encrypted · by {live.savedBy} on {fmtDate(live.savedAt)}</span>
          {canEdit ? (
            <span className="row">
              <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void run("test", () => api.post("/api/connect/salesforce/live/test"), "Connected to Salesforce")}>{busy === "test" ? "Testing…" : "Test connection"}</button>
              <button type="button" className="btn small quiet" onClick={() => { setEditing(true); setDomain(live.myDomain ?? ""); }}>Change</button>
              <button type="button" className="btn small quiet danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm("Remove the saved Salesforce key and secret?")) void run("remove", () => api.post("/api/connect/salesforce/live/remove"), "Removed").then(() => setEditing(true)); }}>Remove</button>
            </span>
          ) : null}
        </div>
      ) : canEdit ? (
        <form className="stack" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); void saveAndTest(); }}>
          <div className="stack" style={{ gap: 4 }}>
            <label className="label" htmlFor="live-domain">My Domain address</label>
            <input id="live-domain" className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany--test.sandbox.my.salesforce.com" autoComplete="off" spellCheck={false} />
            <span className="help">In Salesforce: Setup, then My Domain. It ends in .my.salesforce.com.</span>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <label className="label" htmlFor="live-key">Consumer key</label>
            <input id="live-key" className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder={live.clientIdHint ? `Saved (${live.clientIdHint}); paste to replace` : "From the External Client App"} autoComplete="off" spellCheck={false} />
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <label className="label" htmlFor="live-secret">Consumer secret</label>
            <input id="live-secret" className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={live.configured ? "Saved; paste to replace" : "From the External Client App"} autoComplete="new-password" />
            <span className="help">Stored encrypted. It is never shown again, here or anywhere else.</span>
          </div>
          <div className="row">
            <button type="submit" className="btn" disabled={Boolean(busy) || !domain.trim() || (!live.configured && (!key.trim() || !secret.trim()))}>{busy ? "Connecting…" : "Save and test connection"}</button>
            {live.configured ? <button type="button" className="btn quiet" onClick={() => setEditing(false)}>Cancel</button> : null}
          </div>
        </form>
      ) : <p className="muted small">Only the process owner can connect the company's org.</p>}
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      {t ? (t.ok && t.org ? (
        <dl className="connect-facts">
          <div><dt>Org</dt><dd>{t.org.name} · {t.org.edition}{t.org.sandbox ? " · sandbox" : ""}</dd></div>
          <div><dt>Signed in as</dt><dd>{t.user?.username ?? t.user?.name}</dd></div>
          <div><dt>API calls left today</dt><dd>{t.limits?.DailyApiRequests.Remaining.toLocaleString("en-US")} of {t.limits?.DailyApiRequests.Max.toLocaleString("en-US")}</dd></div>
          <div><dt>Last tested</dt><dd>{fmtDate(t.at)} · worked</dd></div>
        </dl>
      ) : !err ? <p className="error-text">Last test on {fmtDate(t.at)} didn't work: {t.message}</p> : null) : null}
    </div>
  );
}

function LiveRead({ live, canEdit, onChanged }: { live: Live; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const s = live.snapshot;
  async function read() {
    setBusy(true); setErr(undefined);
    try { await api.post("/api/connect/salesforce/live/read"); toast("Org read"); onChanged(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <Step n={2} title="Read the org" done={Boolean(s)} lead="FundingEnvoy reads the objects a grants app is built on: organizations, files, Salesforce's Grants Management objects if you have them, and custom objects whose names suggest grants. Plus the checks Salesforce runs on save.">
        {canEdit ? <div><button type="button" className={`btn ${s ? "quiet" : ""}`} disabled={busy || !live.lastTest?.ok} onClick={() => void read()}>{busy ? "Reading…" : s ? "Read the org again" : "Read the org"}</button></div> : null}
        {!live.lastTest?.ok ? <p className="help">Test the connection first.</p> : null}
        {err ? <p className="error-text" role="alert">{err}</p> : null}
        {s ? (
          <>
            <p className="small">Read {fmtDate(s.readAt)} by {s.readBy}: {s.org.name}. {s.found ? `The org has ${s.found.totalObjects.toLocaleString("en-US")} objects, ${s.found.customObjects} of them custom; FundingEnvoy read the ${s.objects.length} below.` : ""}</p>
            <table className="connect-table">
              <thead><tr><th>Object</th><th>API name</th><th>Fields</th></tr></thead>
              <tbody>{s.objects.map((o) => <tr key={o.name}><td>{o.label}{o.custom ? <span className="chip sys" style={{ marginLeft: 6 }}>Custom</span> : null}</td><td className="mono small">{o.name}</td><td>{o.fields}</td></tr>)}</tbody>
            </table>
            {s.validationRules.length ? (
              <details>
                <summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>What Salesforce checks on save ({s.validationRules.length} validation rules)</summary>
                <ul className="setup-checks">{s.validationRules.map((r) => <li key={`${r.object}.${r.name}`}><span>{r.description || r.name}</span><span className="help">Validation rule <span className="mono">{r.name}</span> on {r.object}: “{r.errorMessage}”</span></li>)}</ul>
              </details>
            ) : null}
            {s.note ? <p className="small" style={{ color: "var(--warn)" }}>{s.note}</p> : null}
          </>
        ) : null}
      </Step>
      <section className="setup-note">
        Next, once you know which object holds your grant requests: match FundingEnvoy's fields to it and let it write, as the simulated org shows today. Choose “Simulated org” above to see the whole flow.
      </section>
    </>
  );
}

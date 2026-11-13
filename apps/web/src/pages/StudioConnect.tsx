// Studio · Connect to Salesforce: three questions, one at a time. Connect. Where are grant requests kept? Match the
// details, showing only what needs a person. The same steps serve the company's own org and the practice org.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { hasRole, useMe, useToast } from "../lib/app";
import { fmtDate, plural } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";

type Mode = "company" | "practice";
interface Wizard {
  funder: string;
  practice: { connected: boolean; draft?: { version: number }; published?: { version: number; signedName: string; signedAt: string } };
  company?: {
    myDomain: string; clientIdHint: string; savedBy: string; savedAt: string;
    lastTest?: { ok?: boolean; at?: string; message?: string; org?: { name: string; edition: string; sandbox: boolean }; user?: { username?: string } };
    requestObject?: { name: string; label: string };
    mappingSaved?: { by: string; at: string };
  };
}
interface Candidate { name: string; label: string; signals: string[]; fields: number; records?: number }
interface Need { id: string; kind: "choose-field" | "statuses" | "required" | "values" | "note"; title: string; detail?: string; key?: string; sf?: string; options?: { value: string; label: string }[]; rows?: { key: string; label: string; current: string }[] }
interface Config { objects: { request: string }; systemFields: Record<string, string>; statusValues: Record<string, string>; fields: { fe: string; sf: string }[]; values: Record<string, Record<string, string>>; [k: string]: unknown }
interface Mapping {
  mode: "simulated" | "live"; org: { name: string }; saved?: { by?: string; at?: string };
  requestObject: { name: string; label: string; fields: { name: string; label: string; type: string; required?: boolean; picklist?: string[] }[] };
  config: Config; needs: Need[];
  matched: { fe: string; feLabel: string; sf: string; sfLabel: string; why: string }[];
  setByFundingEnvoy: string[]; notSent: { key: string; label: string; kind: string }[];
}

const STEPS = ["Connect", "Find your grant requests", "Match the details", "Done"];

export function StudioConnect() {
  useDocumentTitle("Connect to Salesforce");
  const { me } = useMe();
  const w = useResource<Wizard>("/api/connect/salesforce/wizard");
  const [params, setParams] = useSearchParams();
  const canEdit = hasRole(me, "process-owner", "operator");
  const data = w.data;

  // Which Salesforce, and how far along: chosen in the address, otherwise worked out from what is already done.
  const mode = (params.get("with") as Mode | null) ?? (data?.company ? "company" : data?.practice.connected ? "practice" : undefined);
  const connected = mode === "company" ? Boolean(data?.company?.lastTest?.ok) : Boolean(data?.practice.connected);
  const found = mode === "company" ? Boolean(data?.company?.requestObject) : connected;
  const furthest = !connected ? 1 : !found ? 2 : 3;
  const step = Math.min(Number(params.get("step")) || furthest, mode === "company" ? 4 : 4);
  const go = (s: number, m: Mode | undefined = mode) => { setParams(m ? { with: m, step: String(s) } : {}); window.scrollTo({ top: 0 }); };

  if (w.error) return <div className="page narrow"><p className="error-text">{w.error.message}</p></div>;
  if (!data) return <div className="page narrow"><p className="muted">Loading…</p></div>;

  return (
    <div className="wiz">
      <header className="stack" style={{ gap: 6 }}>
        <span className="eyebrow"><Link to="/studio">Studio</Link> · Connections</span>
        <h1 style={{ fontSize: 32 }}>Connect to Salesforce</h1>
        <p className="muted">Three questions, one at a time. Nothing is written to Salesforce while you do this.</p>
      </header>

      {!mode ? (
        <Choose onPick={(m) => go(1, m)} />
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <ol className="wiz-steps" aria-label="Steps">
              {STEPS.map((label, i) => {
                const n = i + 1, reachable = n <= Math.max(furthest, step) || (n === 4 && furthest >= 3);
                return (
                  <li key={label}>
                    <button type="button" aria-current={n === step ? "step" : undefined} disabled={!reachable} onClick={() => go(n)}>
                      <span className="n">{n < step || (n < furthest && n !== step) ? "✓" : n}</span><span>{label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <button type="button" className="linkbtn small" onClick={() => setParams({})}>{mode === "company" ? "Use the practice Salesforce instead" : "Use your company's Salesforce instead"}</button>
          </div>

          {step === 1 ? (mode === "company"
            ? <ConnectCompany data={data} canEdit={canEdit} onDone={async () => { await w.refetch(); }} next={() => go(2)} />
            : <ConnectPractice data={data} canEdit={canEdit} onDone={async () => { await w.refetch(); }} next={() => go(3)} />) : null}
          {step === 2 ? (mode === "company"
            ? <FindRequests data={data} canEdit={canEdit} onChosen={async () => { await w.refetch(); }} next={() => go(3)} />
            : <Card title="Where are grant requests kept?"><p>In the practice Salesforce they're kept in <strong>Grant Request</strong>. Nothing to choose.</p><Nav next={() => go(3)} nextLabel="Next: match the details" /></Card>) : null}
          {step === 3 ? <Match mode={mode} canEdit={canEdit} back={() => go(mode === "company" ? 2 : 1)} next={() => go(4)} /> : null}
          {step === 4 ? <Done mode={mode} data={data} back={() => go(3)} /> : null}
        </>
      )}
    </div>
  );
}

function Card({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section className="wiz-card">
      <h2 style={{ fontSize: 24 }}>{title}</h2>
      {lead ? <p className="muted">{lead}</p> : null}
      {children}
    </section>
  );
}

function Nav({ back, next, nextLabel, busy }: { back?: () => void; next?: () => void; nextLabel: string; busy?: boolean }) {
  return (
    <div className="setup-nav">
      {back ? <button type="button" className="btn quiet" onClick={back}>Back</button> : <span />}
      {next ? <button type="button" className="btn" onClick={next} disabled={busy}>{nextLabel}</button> : null}
    </div>
  );
}

function Choose({ onPick }: { onPick: (m: Mode) => void }) {
  return (
    <Card title="Which Salesforce?">
      <div className="connect-modes">
        <button type="button" className="setup-card connect-mode" onClick={() => onPick("company")}>
          <span style={{ fontWeight: 600, fontSize: 17 }}>Your company's Salesforce</span>
          <span className="small muted">Your org, or a test copy of it. You'll need the key your Salesforce admin created for FundingEnvoy.</span>
        </button>
        <button type="button" className="setup-card connect-mode" onClick={() => onPick("practice")}>
          <span style={{ fontWeight: 600, fontSize: 17 }}>Practice Salesforce</span>
          <span className="small muted">A pretend org for demos, with a grants app already in it. Set up in one click.</span>
        </button>
      </div>
    </Card>
  );
}

// ─── 1. Connect ─────────────────────────────────────────────────────────────

function ConnectCompany({ data, canEdit, onDone, next }: { data: Wizard; canEdit: boolean; onDone: () => Promise<void>; next: () => void }) {
  const c = data.company, t = c?.lastTest;
  const toast = useToast();
  const [editing, setEditing] = useState(!c);
  const [domain, setDomain] = useState(c?.myDomain ?? "");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  async function connect(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setErr(undefined);
    try {
      if (editing) await api.post("/api/connect/salesforce/live/credentials", { myDomain: domain, clientId: key || undefined, clientSecret: secret || undefined });
      await api.post("/api/connect/salesforce/live/test");
      setEditing(false); setKey(""); setSecret(""); toast("Connected");
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); await onDone(); }
  }
  async function disconnect() {
    if (!window.confirm("Disconnect and delete the saved key and secret?")) return;
    await api.post("/api/connect/salesforce/live/remove"); setEditing(true); await onDone();
  }
  if (!editing && c && t?.ok && t.org) return (
    <Card title="Connected">
      <p className="wiz-ok">Connected to <strong>{t.org.name}</strong> ({t.org.edition}{t.org.sandbox ? ", sandbox" : ""}) as {t.user?.username}.</p>
      {canEdit ? <p className="small"><button type="button" className="linkbtn" disabled={busy} onClick={() => void connect()}>Test again</button> · <button type="button" className="linkbtn" onClick={() => setEditing(true)}>Change the key</button> · <button type="button" className="linkbtn" onClick={() => void disconnect()}>Disconnect</button></p> : null}
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <Nav next={next} nextLabel="Next: find your grant requests" />
    </Card>
  );
  return (
    <Card title="Connect your Salesforce" lead="Paste the three things from Salesforce. FundingEnvoy only reads; it changes nothing there.">
      {!canEdit ? <p className="muted">Only the process owner can connect Salesforce.</p> : (
        <form className="stack" style={{ gap: 14 }} onSubmit={connect}>
          <Field id="d" label="Address (My Domain)" help="Salesforce Setup → My Domain. It ends in .my.salesforce.com.">
            <input id="d" className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.my.salesforce.com" autoComplete="off" spellCheck={false} />
          </Field>
          <Field id="k" label="Consumer key" help={c ? `Saved (${c.clientIdHint}). Paste only to replace it.` : "From the FundingEnvoy app in Salesforce: Settings → OAuth Settings → Consumer Key and Secret."}>
            <input id="k" className="input mono" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Field id="s" label="Consumer secret" help={c ? "Saved and encrypted. Paste only to replace it." : "Stored encrypted. It's never shown again."}>
            <input id="s" className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
          </Field>
          {err ? <p className="error-text" role="alert">{err}</p> : t && !t.ok && !err ? <p className="error-text">Last try didn't work: {t.message}</p> : null}
          <div className="row">
            <button type="submit" className="btn" disabled={busy || !domain.trim() || (!c && (!key.trim() || !secret.trim()))}>{busy ? "Connecting…" : "Connect"}</button>
            {c && t?.ok ? <button type="button" className="btn quiet" onClick={() => setEditing(false)}>Cancel</button> : null}
          </div>
          <p className="help">Don't have these yet? Follow the <a href="https://github.com/johanholm-arch/funding-envoy-gcas-test/blob/main/docs/SALESFORCE-TEST-CONNECTION.md" target="_blank" rel="noreferrer">step-by-step guide</a>.</p>
        </form>
      )}
    </Card>
  );
}

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return <div className="stack" style={{ gap: 4 }}><label className="label" htmlFor={id}>{label}</label>{children}{help ? <span className="help">{help}</span> : null}</div>;
}

function ConnectPractice({ data, canEdit, onDone, next }: { data: Wizard; canEdit: boolean; onDone: () => Promise<void>; next: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  async function connect() {
    setBusy(true); setErr(undefined);
    try { await api.post("/api/connect/salesforce/practice/connect"); await onDone(); next(); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return (
    <Card title={data.practice.connected ? "Connected" : "Connect the practice Salesforce"} lead={data.practice.connected ? undefined : "A pretend Salesforce org with a grants app in it, so you can see the whole flow without a real one."}>
      {data.practice.connected ? <p className="wiz-ok">Connected to the practice Salesforce.</p> : null}
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      {data.practice.connected ? <Nav next={next} nextLabel="Next: match the details" /> : canEdit ? <div><button type="button" className="btn" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button></div> : null}
    </Card>
  );
}

// ─── 2. Where are grant requests kept? ──────────────────────────────────────

function FindRequests({ data, canEdit, onChosen, next }: { data: Wizard; canEdit: boolean; onChosen: () => Promise<void>; next: () => void }) {
  const [picking, setPicking] = useState(!data.company?.requestObject);
  if (!picking && data.company?.requestObject) return <RequestFamily canEdit={canEdit} onChange={() => setPicking(true)} next={next} />;
  return <PickRequestObject data={data} canEdit={canEdit} onChosen={async () => { await onChosen(); setPicking(false); }} onKeep={() => setPicking(false)} />;
}

interface MapNode { name: string; label: string; via: string; records?: number; byType?: Record<string, number>; children: MapNode[] }
interface RequestMap { root: { name: string; label: string; records?: number; types: { name: string; developerName: string; records?: number }[] }; children: MapNode[]; links: { field: string; label: string; object: string; objectLabel: string }[]; documents: boolean }

/** The family of records a request is made of, as a picture: the person ticks the parts that belong to a grant request. */
function RequestFamily({ canEdit, onChange, next }: { canEdit: boolean; onChange: () => void; next: () => void }) {
  const r = useResource<{ map: RequestMap; parts: string[] }>("/api/connect/salesforce/live/request-map");
  const [parts, setParts] = useState<string[]>();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (r.data) setParts(r.data.parts); }, [r.data]);
  if (r.error) return <Card title="How a request is built"><p className="error-text">{r.error.message}</p></Card>;
  if (!r.data || !parts) return <Card title="How a request is built"><p className="muted">Reading how a request is built in your Salesforce…</p></Card>;
  const { map } = r.data;
  const typeName = (dn: string) => map.root.types.find((t) => t.developerName === dn)?.name ?? dn;
  async function toggle(name: string, on: boolean) {
    const nextParts = on ? [...parts!, name] : parts!.filter((p) => p !== name);
    setParts(nextParts); setSaving(true); setErr(undefined);
    try { await api.post("/api/connect/salesforce/live/request-parts", { parts: nextParts }); } catch (x) { setErr(errorText(x)); } finally { setSaving(false); }
  }
  const usedBy = (n: MapNode) => n.byType && Object.keys(n.byType).length ? ` · used by ${Object.entries(n.byType).filter(([dn]) => dn !== "(none)").map(([dn, k]) => `${typeName(dn)} (${k})`).join(", ")}` : "";
  const line = (n: MapNode, depth: number) => (
    <li key={`${n.name}.${n.via}`} className={`fam-node d${depth}`}>
      <label className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <input type="checkbox" checked={parts.includes(n.name)} disabled={!canEdit || saving} onChange={(e) => void toggle(n.name, e.target.checked)} style={{ marginTop: 4 }} />
        <span className="stack" style={{ gap: 1 }}>
          <span style={{ fontWeight: 600 }}>{n.label}</span>
          <span className="small muted">{n.records === undefined ? "Records can't be counted" : n.records ? plural(n.records, "record") : "No records yet"}{usedBy(n)}</span>
        </span>
      </label>
      {n.children.length ? <ul className="fam-tree">{n.children.map((g) => line(g, depth + 1))}</ul> : null}
    </li>
  );
  return (
    <Card title="This is how a request is built" lead={<>In your Salesforce, a request is a <strong>{map.root.label}</strong> with other records attached to it. Tick the parts that belong to a grant request.</>}>
      <div className="fam">
        <div className="fam-root">
          <span style={{ fontWeight: 600, fontSize: 17 }}>{map.root.label}</span>
          <span className="small muted">{map.root.records !== undefined ? plural(map.root.records, "record") : ""}</span>
          {map.root.types.length ? <p className="small">Request types: {map.root.types.map((t) => `${t.name}${t.records !== undefined ? ` (${t.records})` : ""}`).join(" · ")}</p> : <p className="small muted">One kind of request (no request types).</p>}
          {map.links.length ? <p className="small muted">Linked to: {map.links.map((l) => l.objectLabel).filter((v, i, a) => a.indexOf(v) === i).join(", ")}</p> : null}
        </div>
        {map.children.length ? <ul className="fam-tree">{map.children.map((n) => line(n, 1))}</ul> : <p className="small muted">Nothing else is attached to a {map.root.label}.</p>}
        {map.documents ? <p className="small muted fam-files">Files can be attached to a {map.root.label}.</p> : null}
      </div>
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <p className="help">{saving ? "Saving…" : "Each tick is saved as you make it. Counts only: FundingEnvoy didn't read what's in the records."}</p>
      <div className="setup-nav">
        <button type="button" className="btn quiet" onClick={onChange}>Choose a different object</button>
        <button type="button" className="btn" onClick={next}>Next: match the details</button>
      </div>
    </Card>
  );
}

function PickRequestObject({ data, canEdit, onChosen, onKeep }: { data: Wizard; canEdit: boolean; onChosen: () => Promise<void>; onKeep: () => void }) {
  const [cands, setCands] = useState<Candidate[]>();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ name: string; label: string }[]>();
  const chosen = data.company?.requestObject?.name;
  useEffect(() => {
    if (!canEdit) return;
    setBusy("find");
    api.post<{ candidates: Candidate[] }>("/api/connect/salesforce/live/find").then((r) => setCands(r.candidates)).catch((x) => setErr(errorText(x))).finally(() => setBusy(undefined));
  }, [canEdit]);
  async function choose(name: string) {
    setBusy(name); setErr(undefined);
    try { await api.post("/api/connect/salesforce/live/choose", { name }); await onChosen(); } catch (x) { setErr(errorText(x)); } finally { setBusy(undefined); }
  }
  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy("search");
    try { setResults((await api.get<{ results: { name: string; label: string }[] }>(`/api/connect/salesforce/live/search?q=${encodeURIComponent(q)}`)).results); } catch (x) { setErr(errorText(x)); } finally { setBusy(undefined); }
  }
  return (
    <Card title="Where are grant requests kept?" lead="Pick the one where a new grant request is created. These look the most likely.">
      {busy === "find" ? <p className="muted">Looking through your Salesforce…</p> : null}
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <div className="stack" style={{ gap: 10 }}>
        {cands?.filter((c, i) => i === 0 || c.signals.length >= 2).map((c, i) => (
          <div key={c.name} className={`wiz-choice ${chosen === c.name ? "on" : ""}`}>
            <div className="stack" style={{ gap: 2 }}>
              <span style={{ fontWeight: 600, fontSize: 17 }}>{c.label}{i === 0 && c.signals.length >= 3 ? <span className="chip ok" style={{ marginLeft: 8 }}>Most likely</span> : null}</span>
              <span className="small">{c.signals.length ? `Has ${joinWords(c.signals)}` : "Doesn't look like requests"}{c.records !== undefined ? ` · ${plural(c.records, "record")}` : ""}</span>
              <span className="mono help">{c.name}</span>
            </div>
            {chosen === c.name ? <span className="row"><span className="chip ok">Chosen</span><button type="button" className="btn small" onClick={onKeep}>Keep it</button></span> : canEdit ? <button type="button" className={`btn small ${i === 0 ? "" : "quiet"}`} disabled={Boolean(busy)} onClick={() => void choose(c.name)}>{busy === c.name ? "Reading…" : "This one"}</button> : null}
          </div>
        ))}
      </div>
      {canEdit ? (
        <details className="wiz-more">
          <summary>Not in the list? Search by name</summary>
          <form className="row" onSubmit={search} style={{ marginTop: 8 }}>
            <label className="sr-only" htmlFor="q">Search Salesforce objects</label>
            <input id="q" className="input" style={{ maxWidth: 280 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="for example Request or Grant" />
            <button type="submit" className="btn quiet" disabled={q.trim().length < 2 || Boolean(busy)}>Search</button>
          </form>
          {results ? (results.length ? (
            <ul className="wiz-list">{results.map((r) => <li key={r.name}><span>{r.label} <span className="mono help">{r.name}</span></span>{chosen === r.name ? <span className="chip ok">Chosen</span> : <button type="button" className="btn small quiet" disabled={Boolean(busy)} onClick={() => void choose(r.name)}>This one</button>}</li>)}</ul>
          ) : <p className="small muted">Nothing by that name.</p>) : null}
          <p className="help">Tip: in Salesforce, open the tab where grant requests are listed. The address in your browser ends in /o/<em>name</em>/list.</p>
        </details>
      ) : null}
    </Card>
  );
}

function joinWords(xs: string[]) {
  return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

// ─── 3. Match the details ───────────────────────────────────────────────────

function Match({ mode, canEdit, back, next }: { mode: Mode; canEdit: boolean; back: () => void; next: () => void }) {
  const apiMode = mode === "company" ? "live" : "simulated";
  const m = useResource<Mapping>(`/api/connect/salesforce/mapping?mode=${apiMode}`);
  const [data, setData] = useState<Mapping>();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (m.data) setData(m.data); }, [m.data]);
  if (m.error) return <Card title="Match the details"><p className="error-text">{m.error.message}</p><Nav back={back} nextLabel="" /></Card>;
  if (!data) return <Card title="Match the details"><p className="muted">Loading…</p></Card>;
  const c = data.config, obj = data.requestObject;

  async function save(cfg: Config) {
    setSaving(true); setErr(undefined);
    try { setData(await api.post<Mapping>("/api/connect/salesforce/mapping", { mode: apiMode, config: cfg })); } catch (x) { setErr(errorText(x)); } finally { setSaving(false); }
  }
  const setField = (fe: string, sf: string) => save({ ...c, fields: sf ? [...c.fields.filter((x) => x.fe !== fe && x.sf !== sf), { fe, sf }] : c.fields.filter((x) => x.fe !== fe) });
  const setValue = (sf: string, key: string, v: string) => save({ ...c, values: { ...c.values, [sf]: { ...(c.values[sf] ?? {}), [key]: v } } });
  const setSystem = (key: string, v: string) => save({ ...c, systemFields: { ...c.systemFields, [key]: v } });
  const setStatus = (key: string, v: string) => save({ ...c, statusValues: { ...c.statusValues, [key]: v } });
  const sfOptions = (types?: string[]) => obj.fields.filter((f) => !types || types.includes(f.type));
  const open = data.needs.filter((n) => n.kind !== "note"), notes = data.needs.filter((n) => n.kind === "note");

  return (
    <Card title="Match the details" lead={<>FundingEnvoy matched <strong>{plural(data.matched.length, "of its questions", "of its questions")}</strong> to fields on <strong>{obj.label}</strong> by itself. {open.length ? <>{plural(open.length, "thing needs", "things need")} you.</> : "Nothing needs you."}</>}>
      {mode === "company" ? <p className="wiz-note small">This step matches the <strong>{obj.label}</strong> itself. The other parts you ticked come next, once you've confirmed this.</p> : null}
      {open.map((n) => (
        <div key={n.id} className="wiz-need">
          <p style={{ fontWeight: 600 }}>{n.title}</p>
          {n.detail ? <p className="small muted">{n.detail}</p> : null}
          {n.kind === "choose-field" ? (
            <select className="select" disabled={!canEdit || saving} value={c.systemFields[n.key!] ?? ""} onChange={(e) => void setSystem(n.key!, e.target.value)} aria-label={n.title}>
              <option value="">Choose…</option>{n.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : null}
          {n.kind === "required" ? (
            <select className="select" disabled={!canEdit || saving} value="" onChange={(e) => void setField(e.target.value, n.sf!)} aria-label={n.title}>
              <option value="">Choose a FundingEnvoy question…</option>{n.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : null}
          {n.kind === "values" || n.kind === "statuses" ? (
            <>
              <table className="wiz-rows"><tbody>{n.rows?.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td><select className="select small" disabled={!canEdit || saving} value={r.current} aria-label={r.label}
                    onChange={(e) => void (n.kind === "statuses" ? setStatus(r.key, e.target.value) : setValue(n.sf!, r.key, e.target.value))}>
                    <option value="">Choose…</option>{n.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select></td>
                </tr>
              ))}</tbody></table>
              {canEdit && n.kind === "values" && n.rows?.every((r) => r.current) ? <div><button type="button" className="btn small" disabled={saving} onClick={() => void save({ ...c, confirmed: [...new Set([...((c.confirmed as string[] | undefined) ?? []), n.id])] })}>These are right</button></div> : null}
            </>
          ) : null}
        </div>
      ))}
      {notes.map((n) => <div key={n.id} className="wiz-note"><p style={{ fontWeight: 600 }} className="small">{n.title}</p><p className="small">{n.detail}</p></div>)}
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      {saving ? <p className="help">Saving…</p> : data.saved ? <p className="help">Every choice is saved as you make it.</p> : null}

      <details className="wiz-more">
        <summary>What FundingEnvoy matched by itself ({data.matched.length})</summary>
        <table className="wiz-rows"><tbody>{data.matched.map((x) => (
          <tr key={x.fe}>
            <td>{x.feLabel}</td>
            <td><select className="select small" disabled={!canEdit || saving} value={x.sf} onChange={(e) => void setField(x.fe, e.target.value)} aria-label={`Salesforce field for ${x.feLabel}`}>
              <option value="">Don't send</option>{sfOptions().map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
            </select></td>
          </tr>
        ))}</tbody></table>
        {data.setByFundingEnvoy.length ? <p className="help">Filled by FundingEnvoy itself: {data.setByFundingEnvoy.join(", ")}.</p> : null}
      </details>
      <details className="wiz-more">
        <summary>FundingEnvoy questions not sent to Salesforce ({data.notSent.length})</summary>
        <p className="help">The grants team still sees these in FundingEnvoy's review summary. Choose a field to send one.</p>
        <table className="wiz-rows"><tbody>{data.notSent.map((x) => (
          <tr key={x.key}><td>{x.label}</td><td><select className="select small" disabled={!canEdit || saving} value="" onChange={(e) => void setField(x.key, e.target.value)} aria-label={`Salesforce field for ${x.label}`}>
            <option value="">Don't send</option>{sfOptions().map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
          </select></td></tr>
        ))}</tbody></table>
      </details>
      <Nav back={back} next={next} nextLabel={open.length ? `Finish later (${open.length} left)` : "Done"} busy={saving} />
    </Card>
  );
}

// ─── Done ───────────────────────────────────────────────────────────────────

function Done({ mode, data, back }: { mode: Mode; data: Wizard; back: () => void }) {
  const m = useResource<Mapping>(`/api/connect/salesforce/mapping?mode=${mode === "company" ? "live" : "simulated"}`);
  const toast = useToast();
  const [trial, setTrial] = useState<{ ok: boolean; result: { errors?: { message: string }[] } }>();
  const [busy, setBusy] = useState(false);
  const x = m.data;
  const open = x?.needs.filter((n) => n.kind !== "note") ?? [];
  const sent = x?.matched.slice(0, 8).map((f) => f.sfLabel) ?? [];
  const what = x ? (
    <p>When a requestor submits, FundingEnvoy creates a <strong>{x.requestObject.label}</strong> in {mode === "company" ? "your" : "the practice"} Salesforce, in the requestor's own name. It fills {joinWords([...sent, ...(x.matched.length > 8 ? [`${x.matched.length - 8} more`] : [])])}, links the organization, sets the status to <strong>{x.config.statusValues.submitted || "…"}</strong> and attaches the documents.</p>
  ) : null;
  return (
    <Card title={open.length ? "Almost done" : "Done"}>
      {x ? what : <p className="muted">Loading…</p>}
      {open.length ? <p className="error-text">{plural(open.length, "thing still needs", "things still need")} you in step 3.</p> : null}
      {mode === "company" ? (
        <div className="wiz-note">
          <p className="small" style={{ fontWeight: 600 }}>Before it's switched on</p>
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {x?.needs.some((n) => n.id === "external-id") ? <li>Your Salesforce admin adds one field, “FundingEnvoy Request ID”, to {x.requestObject.label}.</li> : null}
            <li>Requestors sign in to FundingEnvoy with the same login as your portal (we'll set that up next).</li>
            <li>Claude Code switches on writing to your org, using these matches. Nothing is written until then.</li>
          </ol>
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <button type="button" className="btn quiet" disabled={busy} onClick={() => { setBusy(true); void api.post<typeof trial>("/api/connect/salesforce/trial").then((r) => { setTrial(r); toast(r?.ok ? "Salesforce accepted the sample" : "Salesforce refused the sample"); }).catch(() => undefined).finally(() => setBusy(false)); }}>{busy ? "Trying…" : "Try it with a sample request"}</button>
            {data.practice.draft ? <Link className="btn" to="/studio?step=6">Publish</Link> : null}
            {data.practice.published ? <Link className="btn quiet" to="/salesforce">Open the practice Salesforce</Link> : null}
          </div>
          {trial ? <p className={trial.ok ? "wiz-ok" : "error-text"}>{trial.ok ? "Salesforce accepted the sample, and it was removed again." : `Salesforce refused it: ${trial.result.errors?.[0]?.message ?? ""}`}</p> : null}
          {data.practice.published && !data.practice.draft ? <p className="help">In use since {fmtDate(data.practice.published.signedAt)}, signed by {data.practice.published.signedName}.</p> : null}
        </div>
      )}
      <Nav back={back} nextLabel="" />
    </Card>
  );
}

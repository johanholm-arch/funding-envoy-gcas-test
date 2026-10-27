// Studio's front door: a funder's setup in the order a grants team thinks about it. Upload the policy and the SOP;
// FundingEnvoy reads them and suggests the words, what requestors must provide and the time allowed at each stage,
// each suggestion with the sentence it came from. Confirm step by step, then publish everything with one signature.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { assistantName, hasRole, useMe, useToast } from "../lib/app";
import { fmtDate, plural, roleWords } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";

interface Source { ref: string; quote: string }
interface Sourced<T> extends Source { value: T }
interface DocInfo { title: string; words: number; clauses: number; status: "draft" | "published"; copiedFrom?: string; signedName?: string; signedAt?: string }
interface SetupView {
  funder: string;
  copiedFrom?: string;
  documents: { policy?: DocInfo; sop?: DocInfo };
  proposal?: { provider: string; by: string; at: string; fresh: boolean };
  words: { key: string; label: string; value: string; proposed?: Sourced<string> }[];
  limits: { key: string; label: string; unit: string; kind: "days" | "percent" | "money"; value?: number; proposed?: Sourced<number> }[];
  requestorDocuments: { type: string; label: string; help?: string; usedIn: string[]; status: "always" | "sometimes" | "optional"; inDocuments?: Source & { type: string } }[];
  checks: { id: string; statement: string; severity: string; basis: string; enabled: boolean; locked: boolean; basisMissing: boolean }[];
  packs: { id: string; name: string; rules: number; verification: string }[];
  workflow: { id: string; order: number; name: string; ownerRoles: string[]; slaBusinessDays: number | null; sopRefs: string[]; proposed?: Source & { days: number; unit: "business" | "calendar" } }[];
  drafts: { kind: string; label: string; version: number }[];
}
interface CheckResult { drafts: { kind: string; label: string; version: number; issues: { severity: "error" | "warning"; where?: string; message: string }[] }[]; tests: { passed: number; total: number; failing: { id: string; title: string; mismatches: string[] }[] } }

const STEPS = [
  { n: 1, title: "Your documents", what: "Upload your policy and SOP. Everything else starts from them." },
  { n: 2, title: "Your words", what: "What your organization calls things." },
  { n: 3, title: "What requestors provide", what: "Limits, required documents and the checks FundingEnvoy runs." },
  { n: 4, title: "Workflow", what: "Who handles each stage, and how long they have." },
  { n: 5, title: "Look and assistant", what: "Logo, colour and how much the assistant does." },
  { n: 6, title: "Check and publish", what: "One signature puts every change into use." },
] as const;

const businessDays = (p: { days: number; unit: "business" | "calendar" }) => (p.unit === "business" ? p.days : Math.max(1, Math.round((p.days * 5) / 7)));
function showLimit(kind: string, v: number | undefined): string {
  if (v === undefined || v === null) return "not set";
  if (kind === "percent") return `${+(v * 100).toFixed(2)}%`;
  if (kind === "money") return `US$${v.toLocaleString("en-US")}`;
  return plural(v, "day");
}

export function StudioSetup() {
  useDocumentTitle("Studio");
  const { me } = useMe();
  const v = useResource<SetupView>("/api/studio/setup");
  const [params, setParams] = useSearchParams();
  const step = Math.min(6, Math.max(1, Number(params.get("step")) || 1));
  const go = (n: number) => { setParams(n === 1 ? {} : { step: String(n) }); window.scrollTo({ top: 0 }); };
  const canEdit = hasRole(me, "process-owner", "operator");
  const data = v.data;

  const open = data ? {
    1: (data.documents.policy?.copiedFrom ? 1 : 0) + (data.documents.sop?.copiedFrom ? 1 : 0),
    2: data.words.filter((w) => w.proposed && w.proposed.value !== w.value).length,
    3: data.limits.filter((l) => l.proposed && l.proposed.value !== l.value).length + data.requestorDocuments.filter((d) => d.inDocuments && d.status === "optional").length,
    4: data.workflow.filter((s) => s.proposed && businessDays(s.proposed) !== s.slaBusinessDays).length,
    5: 0, 6: data.drafts.length,
  } as Record<number, number> : undefined;

  return (
    <div className="setup">
      <nav className="setup-rail" aria-label="Setup steps">
        <span className="eyebrow">Studio · {data?.funder ?? me.tenant?.name}</span>
        <ol>
          {STEPS.map((s) => (
            <li key={s.n}>
              <button type="button" className="setup-step" aria-current={s.n === step ? "step" : undefined} onClick={() => go(s.n)}>
                <span className="n">{s.n}</span>
                <span className="t">{s.title}</span>
                {open && open[s.n] ? <span className="chip warn" title={s.n === 1 ? "Still the copied documents" : s.n === 6 ? "Changes waiting to be published" : "Suggestions to review"}>{s.n === 1 ? "Copied" : open[s.n]}</span> : null}
              </button>
            </li>
          ))}
        </ol>
        <p className="help">Every step saves a draft. Nothing changes for requests until you publish in step 6. Requests already started keep the setup they started with.</p>
        <Link className="small" to="/studio/advanced">Advanced: every section in detail</Link>
      </nav>

      <main className="setup-main">
        <header className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Step {step} of 6</span>
          <h1 style={{ fontSize: 32 }}>{STEPS[step - 1]!.title}</h1>
          <p className="muted">{STEPS[step - 1]!.what}</p>
        </header>
        {data?.drafts.length && step !== 6 ? (
          <div className="setup-bar" role="status">
            <span><strong>{plural(data.drafts.length, "change")} saved, not yet in use:</strong> {data.drafts.map((d) => d.label).join(", ")}</span>
            <button type="button" className="btn small" onClick={() => go(6)}>Check and publish</button>
          </div>
        ) : null}
        {v.error ? <p className="error-text" role="alert">{v.error.message}</p> : null}
        {!data ? <p className="muted">Loading…</p> : (
          <>
            {step === 1 ? <DocumentsStep data={data} canEdit={canEdit} onChanged={() => void v.refetch()} next={() => go(2)} /> : null}
            {step === 2 ? <WordsStep key={JSON.stringify(data.words)} data={data} canEdit={canEdit} onSaved={async () => { await v.refetch(); go(3); }} back={() => go(1)} /> : null}
            {step === 3 ? <RequirementsStep key={JSON.stringify([data.limits, data.requestorDocuments, data.checks])} data={data} canEdit={canEdit} onSaved={async () => { await v.refetch(); go(4); }} back={() => go(2)} /> : null}
            {step === 4 ? <WorkflowStep key={JSON.stringify(data.workflow)} data={data} canEdit={canEdit} onSaved={async () => { await v.refetch(); go(5); }} back={() => go(3)} /> : null}
            {step === 5 ? <LookStep next={() => go(6)} back={() => go(4)} /> : null}
            {step === 6 ? <PublishStep data={data} onChanged={() => void v.refetch()} back={() => go(5)} /> : null}
          </>
        )}
      </main>

    </div>
  );
}

function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  async function run<T>(key: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    setBusy(key); setErr(undefined);
    try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { setErr(errorText(e)); return undefined; } finally { setBusy(undefined); }
  }
  return { busy, err, run, setErr };
}

function Suggestion({ src, says, inUse, onUse, disabled }: { src: Source; says: ReactNode; inUse: boolean; onUse?: () => void; disabled?: boolean }) {
  // Already in line with the documents: one quiet line, the sentence one click away.
  if (inUse) return (
    <details className="agree">
      <summary>✓ Matches your documents · {src.ref}</summary>
      <blockquote>“{src.quote}”</blockquote>
    </details>
  );
  return (
    <div className="suggestion">
      <span className="eyebrow">From your documents · {src.ref}</span>
      <blockquote>“{src.quote}”</blockquote>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small">Suggests <strong style={{ fontWeight: 600 }}>{says}</strong></span>
        {onUse ? <button type="button" className="btn small quiet" onClick={onUse} disabled={disabled}>Use this</button> : null}
      </div>
    </div>
  );
}

function StepNav({ back, next, nextLabel, busy, form }: { back?: () => void; next?: () => void; nextLabel: string; busy?: boolean; form?: boolean }) {
  return (
    <div className="setup-nav">
      {back ? <button type="button" className="btn quiet" onClick={back}>Back</button> : <span />}
      {form ? <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : nextLabel}</button> : <button type="button" className="btn" onClick={next}>{nextLabel}</button>}
    </div>
  );
}

// ─── Step 1 ─────────────────────────────────────────────────────────────────

function DocumentsStep({ data, canEdit, onChanged, next }: { data: SetupView; canEdit: boolean; onChanged: () => void; next: () => void }) {
  const { busy, err, run } = useRun();
  const hasOwn = Boolean((data.documents.policy && !data.documents.policy.copiedFrom) || (data.documents.sop && !data.documents.sop.copiedFrom));
  async function read() {
    const r = await run("read", () => api.post("/api/studio/setup/propose"), "Your documents have been read");
    if (r) { onChanged(); next(); }
  }
  return (
    <div className="stack" style={{ gap: 20 }}>
      {data.documents.policy?.copiedFrom || data.documents.sop?.copiedFrom ? (
        <p className="setup-note">{data.funder} started as a copy of {data.documents.policy?.copiedFrom ?? data.documents.sop?.copiedFrom}'s setup. Upload your own policy and SOP and FundingEnvoy will suggest what to change, with the sentence each suggestion comes from.</p>
      ) : null}
      <div className="setup-docs">
        <DocCard kind="policy" name="Policy" why="The rules: who can be funded, limits, what a request must include. The assistant quotes it when requestors ask questions." info={data.documents.policy} canEdit={canEdit} onDone={onChanged} />
        <DocCard kind="sop" name="SOP" why="How your team works: the stages, who does what and how long each step takes. The workflow is drafted from it." info={data.documents.sop} canEdit={canEdit} onDone={onChanged} />
      </div>
      {canEdit ? (
        <section className="panel" aria-labelledby="h-read">
          <h2 id="h-read" style={{ fontSize: 20 }}>Let FundingEnvoy read them</h2>
          <p className="muted small">It suggests your words, limits, required documents and the time allowed at each stage. Each suggestion shows the sentence it came from; you accept or change it in the next steps.</p>
          {data.proposal ? <p className="small">Last read {fmtDate(data.proposal.at)} by {data.proposal.by} ({data.proposal.provider === "demo" ? "demo assistant, no AI model" : "Claude"}).{!data.proposal.fresh ? " Your documents have changed since then; read them again." : ""}</p> : null}
          {err ? <p className="error-text" role="alert">{err}</p> : null}
          <div className="row">
            <button type="button" className="btn" onClick={() => void read()} disabled={Boolean(busy)}>{busy ? "Reading…" : data.proposal ? "Read my documents again" : "Read my documents"}</button>
            {data.proposal ? <button type="button" className="btn quiet" onClick={next}>Continue to your words</button> : null}
          </div>
          {!hasOwn ? <p className="help">You can read the copied documents too, but the suggestions will be the original funder's.</p> : null}
        </section>
      ) : <StepNav next={next} nextLabel="Next: your words" />}
    </div>
  );
}

function DocCard({ kind, name, why, info, canEdit, onDone }: { kind: "policy" | "sop"; name: string; why: string; info?: DocInfo; canEdit: boolean; onDone: () => void }) {
  const { busy, err, run } = useRun();
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<string>();
  async function done(r: { title: string; clauses: number; comparison?: { clauses: { changed: string[]; added: string[]; removed: string[] }; drafts: { workflow?: number } } } | undefined) {
    if (!r) return;
    setPaste(false); setText("");
    setResult(`Read “${r.title}”: ${plural(r.clauses, "numbered clause")}.${r.comparison ? ` Compared with the SOP before: ${r.comparison.clauses.changed.length} changed, ${r.comparison.clauses.added.length} new, ${r.comparison.clauses.removed.length} removed. The workflow has been re-drafted from it.` : ""}`);
    onDone();
  }
  async function upload(f: File) { await done(await run("up", () => api.upload<{ title: string; clauses: number }>(`/api/studio/setup/documents/${kind}`, [f]), `${name} uploaded`)); }
  async function submit(e: FormEvent) { e.preventDefault(); await done(await run("up", () => api.post<{ title: string; clauses: number }>(`/api/studio/setup/documents/${kind}`, { text }), `${name} saved`)); }
  return (
    <section className="setup-card" aria-labelledby={`h-${kind}`}>
      <div className="section-head">
        <h2 id={`h-${kind}`} style={{ fontSize: 20 }}>{name}</h2>
        {!info ? <span className="chip block">Missing</span> : info.copiedFrom ? <span className="chip warn">Copied from {info.copiedFrom}</span> : info.status === "draft" ? <span className="chip warn">New · not yet published</span> : <span className="chip ok">Yours</span>}
      </div>
      <p className="muted small">{why}</p>
      {info ? <p className="small"><strong style={{ fontWeight: 500 }}>{info.title}</strong> · {plural(info.clauses, "numbered clause")} · {info.words.toLocaleString("en-US")} words{info.status === "published" && info.signedName ? ` · signed by ${info.signedName} on ${fmtDate(info.signedAt)}` : ""}</p> : null}
      {result ? <p className="small" style={{ color: "var(--accent)" }} aria-live="polite">{result}</p> : null}
      {canEdit ? (
        <>
          <div className="row">
            <label className={`btn small${info && !info.copiedFrom ? " quiet" : ""}`} aria-disabled={Boolean(busy)}>
              {busy ? "Reading…" : info && !info.copiedFrom ? `Upload a new version` : `Upload your ${name}`}
              <input type="file" accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" hidden disabled={Boolean(busy)} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
            </label>
            <button type="button" className="btn small quiet" onClick={() => setPaste((p) => !p)}>{paste ? "Cancel" : "Paste the text instead"}</button>
          </div>
          <p className="help">PDF, Word (.docx) or text. Numbered clauses (like 4.1) let every suggestion and check point to its source.</p>
          {paste ? (
            <form className="stack" style={{ gap: 8 }} onSubmit={submit}>
              <label className="label" htmlFor={`paste-${kind}`}>{name} text</label>
              <textarea id={`paste-${kind}`} className="textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Paste your whole ${name} here`} />
              <div><button type="submit" className="btn small" disabled={Boolean(busy) || text.trim().length < 50}>Save {name}</button></div>
            </form>
          ) : null}
          {err ? <p className="error-text" role="alert">{err}</p> : null}
        </>
      ) : null}
    </section>
  );
}

// ─── Step 2 ─────────────────────────────────────────────────────────────────

function WordsStep({ data, canEdit, onSaved, back }: { data: SetupView; canEdit: boolean; onSaved: () => Promise<void>; back: () => void }) {
  const { busy, err, run } = useRun();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(data.words.map((w) => [w.key, w.value])));
  const pending = data.words.filter((w) => w.proposed && w.proposed.value !== vals[w.key]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    const changed = Object.fromEntries(Object.entries(vals).filter(([k, x]) => x !== data.words.find((w) => w.key === k)?.value));
    if (Object.keys(changed).length && !(await run("save", () => api.post("/api/studio/setup/words", { words: changed }), "Words saved as a draft"))) return;
    await onSaved();
  }
  return (
    <form className="stack" style={{ gap: 20 }} onSubmit={save}>
      <NoProposal data={data} />
      {pending.length > 1 && canEdit ? <div><button type="button" className="btn small quiet" onClick={() => setVals((v) => ({ ...v, ...Object.fromEntries(pending.map((w) => [w.key, w.proposed!.value])) }))}>Use all {pending.length} suggestions</button></div> : null}
      {data.words.map((w) => (
        <div key={w.key} className="setup-field">
          <label className="label" htmlFor={`w-${w.key}`}>{w.label}</label>
          <input id={`w-${w.key}`} className="input" value={vals[w.key] ?? ""} onChange={(e) => setVals({ ...vals, [w.key]: e.target.value })} disabled={!canEdit} maxLength={60} />
          {w.proposed ? <Suggestion src={w.proposed} says={`“${w.proposed.value}”`} inUse={vals[w.key] === w.proposed.value} onUse={canEdit ? () => setVals({ ...vals, [w.key]: w.proposed!.value }) : undefined} /> : null}
        </div>
      ))}
      <p className="help">Your words appear on every screen and in the assistant's messages, for requestors and your team.</p>
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <StepNav back={back} nextLabel={canEdit ? "Save and continue" : "Next"} busy={Boolean(busy)} form />
    </form>
  );
}

function NoProposal({ data }: { data: SetupView }) {
  if (data.proposal) return data.proposal.fresh ? null : <p className="setup-note">Your documents changed after FundingEnvoy read them. <Link to="/studio">Read them again</Link> to refresh the suggestions.</p>;
  return <p className="setup-note">No suggestions yet. <Link to="/studio">Upload your documents and let FundingEnvoy read them</Link>, or set things here yourself.</p>;
}

// ─── Step 3 ─────────────────────────────────────────────────────────────────

function RequirementsStep({ data, canEdit, onSaved, back }: { data: SetupView; canEdit: boolean; onSaved: () => Promise<void>; back: () => void }) {
  const { busy, err, run, setErr } = useRun();
  const toInput = (kind: string, n?: number) => (n === undefined || n === null ? "" : kind === "percent" ? String(+(n * 100).toFixed(2)) : String(n));
  const [limits, setLimits] = useState<Record<string, string>>(() => Object.fromEntries(data.limits.map((l) => [l.key, toInput(l.kind, l.value)])));
  const [docs, setDocs] = useState<Record<string, string>>(() => Object.fromEntries(data.requestorDocuments.map((d) => [d.type, d.status])));
  const [checks, setChecks] = useState<Record<string, boolean>>(() => Object.fromEntries(data.checks.map((c) => [c.id, c.enabled])));
  const [showChecks, setShowChecks] = useState(false);
  const fromInput = (kind: string, s: string) => (s.trim() === "" ? null : kind === "percent" ? Number(s) / 100 : Number(s));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canEdit) { await onSaved(); return; }
    const l: Record<string, number | null> = {};
    for (const x of data.limits) {
      const n = fromInput(x.kind, limits[x.key] ?? "");
      if (n !== null && !Number.isFinite(n)) { setErr(`${x.label} must be a number.`); return; }
      if (n !== (x.value ?? null)) l[x.key] = n;
    }
    const d = Object.fromEntries(data.requestorDocuments.filter((x) => docs[x.type] !== x.status && docs[x.type] !== "sometimes").map((x) => [x.type, docs[x.type]]));
    const c = Object.fromEntries(data.checks.filter((x) => checks[x.id] !== x.enabled).map((x) => [x.id, checks[x.id]]));
    if (Object.keys(l).length + Object.keys(d).length + Object.keys(c).length) {
      if (!(await run("save", () => api.post("/api/studio/setup/requirements", { limits: l, documents: d, checks: c }), "Requirements saved as a draft"))) return;
    }
    await onSaved();
  }
  const off = data.checks.filter((c) => !checks[c.id]).length;
  return (
    <form className="stack" style={{ gap: 28 }} onSubmit={save}>
      <NoProposal data={data} />
      <section className="stack" style={{ gap: 14 }} aria-labelledby="h-limits">
        <h2 id="h-limits" style={{ fontSize: 22 }}>Limits</h2>
        {data.limits.map((l) => (
          <div key={l.key} className="setup-field">
            <label className="label" htmlFor={`l-${l.key}`}>{l.label}</label>
            <div className="row">
              <input id={`l-${l.key}`} className="input" inputMode="decimal" style={{ maxWidth: 160 }} value={limits[l.key] ?? ""} onChange={(e) => setLimits({ ...limits, [l.key]: e.target.value })} disabled={!canEdit} />
              <span className="muted small">{l.kind === "percent" ? "%" : l.kind === "money" ? "US$" : "days"}</span>
            </div>
            <p className="help">{l.unit}</p>
            {l.proposed ? <Suggestion src={l.proposed} says={showLimit(l.kind, l.proposed.value)} inUse={limits[l.key] === toInput(l.kind, l.proposed.value)} onUse={canEdit ? () => setLimits({ ...limits, [l.key]: toInput(l.kind, l.proposed!.value) }) : undefined} /> : null}
          </div>
        ))}
      </section>

      <section className="stack" style={{ gap: 10 }} aria-labelledby="h-docs">
        <h2 id="h-docs" style={{ fontSize: 22 }}>Documents requestors upload</h2>
        <p className="muted small">“Always” means a request can't be submitted without it. “Depends” documents are needed only in some cases, such as accredited education; change those under Advanced.</p>
        {data.requestorDocuments.map((d) => (
          <div key={d.type} className="setup-doc-row">
            <div className="stack" style={{ gap: 2, flex: "1 1 260px" }}>
              <span style={{ fontWeight: 500 }}>{d.label}</span>
              <span className="help">For {d.usedIn.length > 3 ? `${d.usedIn.length} request types` : d.usedIn.join(", ")}</span>
            </div>
            {d.status === "sometimes" ? <span className="chip sys">Depends on the request</span> : (
              <div className="seg" role="radiogroup" aria-label={`${d.label}: required?`}>
                {(["always", "optional"] as const).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={docs[d.type] === s} disabled={!canEdit} onClick={() => setDocs({ ...docs, [d.type]: s })}>{s === "always" ? "Always" : "Optional"}</button>
                ))}
              </div>
            )}
            {d.inDocuments ? <div style={{ flexBasis: "100%" }}><Suggestion src={d.inDocuments} says="required" inUse={docs[d.type] !== "optional"} onUse={canEdit ? () => setDocs({ ...docs, [d.type]: "always" }) : undefined} /></div>
              : data.proposal && docs[d.type] === "always" ? <p className="help" style={{ flexBasis: "100%" }}>Your documents don't mention this one. Keep it if you still need it.</p> : null}
          </div>
        ))}
      </section>

      <section className="stack" style={{ gap: 10 }} aria-labelledby="h-checks">
        <div className="section-head">
          <h2 id="h-checks" style={{ fontSize: 22 }}>Checks FundingEnvoy runs</h2>
          <button type="button" className="btn small quiet" onClick={() => setShowChecks((s) => !s)} aria-expanded={showChecks}>{showChecks ? "Hide" : `Show all ${data.checks.length}`}</button>
        </div>
        <p className="muted small">{plural(data.checks.length, "check")} on every request{off ? `, ${off} switched off` : ""}. The limits above feed them. Each one points to the clause it enforces. {data.packs.length ? `Regulatory packs: ${data.packs.map((p) => `${p.name} (${plural(p.rules, "check")})`).join(", ")}.` : ""}</p>
        {data.checks.some((c) => c.basisMissing) ? <p className="small" style={{ color: "var(--warn)" }}>{plural(data.checks.filter((c) => c.basisMissing).length, "check")} point to clauses that aren't in your documents. Switch them off, or keep them if they still apply.</p> : null}
        {showChecks ? (
          <ul className="setup-checks">
            {data.checks.map((c) => (
              <li key={c.id}>
                <label className="row" style={{ alignItems: "flex-start", gap: 10 }}>
                  <input type="checkbox" checked={checks[c.id] ?? true} disabled={!canEdit || c.locked} onChange={(e) => setChecks({ ...checks, [c.id]: e.target.checked })} style={{ marginTop: 4 }} />
                  <span className="stack" style={{ gap: 2 }}>
                    <span>{c.statement}</span>
                    <span className="help"><span className="mono">{c.id}</span> · {c.basis}{c.locked ? " · platform safeguard, always on" : ""}{c.basisMissing ? " · clause not found in your documents" : ""}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <StepNav back={back} nextLabel={canEdit ? "Save and continue" : "Next"} busy={Boolean(busy)} form />
    </form>
  );
}

// ─── Step 4 ─────────────────────────────────────────────────────────────────

function WorkflowStep({ data, canEdit, onSaved, back }: { data: SetupView; canEdit: boolean; onSaved: () => Promise<void>; back: () => void }) {
  const { busy, err, run } = useRun();
  const [days, setDays] = useState<Record<string, string>>(() => Object.fromEntries(data.workflow.map((s) => [s.id, s.slaBusinessDays === null ? "" : String(s.slaBusinessDays)])));
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canEdit) { await onSaved(); return; }
    const stages = data.workflow.filter((s) => (days[s.id] ?? "") !== (s.slaBusinessDays === null ? "" : String(s.slaBusinessDays)))
      .map((s) => ({ id: s.id, slaBusinessDays: days[s.id]?.trim() ? Math.round(Number(days[s.id])) : null }));
    if (stages.length && !(await run("save", () => api.post("/api/studio/setup/workflow", { stages }), "Workflow saved as a draft"))) return;
    await onSaved();
  }
  return (
    <form className="stack" style={{ gap: 20 }} onSubmit={save}>
      <NoProposal data={data} />
      <p className="muted small">The stages come from your SOP. Uploading a new SOP in step 1 re-drafts them. To change who owns a stage or add one, use <Link to="/studio/workflow">Advanced</Link>.</p>
      <ol className="setup-stages">
        {data.workflow.map((s) => (
          <li key={s.id} className="setup-field">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div className="stack" style={{ gap: 2 }}>
                <span style={{ fontWeight: 500 }}>{s.order}. {s.name}</span>
                <span className="help">{s.ownerRoles.map(roleWords).join(", ")}{s.sopRefs.length ? ` · ${s.sopRefs.map((r) => (/^SOP/.test(r) ? r : `SOP ${r}`)).join(", ")}` : ""}</span>
              </div>
              <div className="row">
                <label className="sr-only" htmlFor={`d-${s.id}`}>Business days allowed for {s.name}</label>
                <input id={`d-${s.id}`} className="input small" inputMode="numeric" style={{ width: 72 }} value={days[s.id] ?? ""} placeholder="–" onChange={(e) => setDays({ ...days, [s.id]: e.target.value.replace(/[^0-9]/g, "") })} disabled={!canEdit} />
                <span className="muted small">business days</span>
              </div>
            </div>
            {s.proposed ? <Suggestion src={s.proposed} says={s.proposed.unit === "business" ? plural(s.proposed.days, "business day") : `${plural(s.proposed.days, "calendar day")} (about ${plural(businessDays(s.proposed), "business day")})`} inUse={days[s.id] === String(businessDays(s.proposed))} onUse={canEdit ? () => setDays({ ...days, [s.id]: String(businessDays(s.proposed!)) }) : undefined} /> : null}
          </li>
        ))}
      </ol>
      <p className="help">Leave a stage blank if it has no time limit. The desk shows how much time is left on each request.</p>
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <StepNav back={back} nextLabel={canEdit ? "Save and continue" : "Next"} busy={Boolean(busy)} form />
    </form>
  );
}

// ─── Step 5 ─────────────────────────────────────────────────────────────────

function LookStep({ next, back }: { next: () => void; back: () => void }) {
  const { me } = useMe();
  const b = me.tenant?.brand as { logoText?: string; color?: string; logoUrl?: string } | undefined;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="setup-card" aria-labelledby="h-look">
        <div className="section-head"><h2 id="h-look" style={{ fontSize: 20 }}>Logo and colour</h2><Link className="btn small quiet" to="/studio/brand">Change</Link></div>
        <div className="row" style={{ gap: 16 }}>
          {b?.logoUrl ? <img src={b.logoUrl} alt={`${b.logoText ?? ""} logo`} style={{ height: 48, maxWidth: 240, objectFit: "contain" }} /> : <span className="chip warn">No logo yet</span>}
          <span className="row small"><span aria-hidden style={{ width: 20, height: 20, background: b?.color, display: "inline-block", borderRadius: 4 }} />{b?.logoText} · {b?.color}</span>
        </div>
        <p className="help">Shown to requestors and your team. The layout stays the same for every funder.</p>
      </section>
      <section className="setup-card" aria-labelledby="h-assist">
        <div className="section-head"><h2 id="h-assist" style={{ fontSize: 20 }}>The assistant</h2><Link className="btn small quiet" to="/studio/autonomy">Change</Link></div>
        <p className="small">Called “{assistantName(me)}” (change the name in step 2). You choose how much it does at each stage, from suggesting to acting with a person checking. Decisions, payments and five other outcomes are always a person's.</p>
      </section>
      <p className="help">Changes you save there join the others and are published together in the next step.</p>
      <StepNav back={back} next={next} nextLabel="Next: check and publish" />
    </div>
  );
}

// ─── Step 6 ─────────────────────────────────────────────────────────────────

function PublishStep({ data, onChanged, back }: { data: SetupView; onChanged: () => void; back: () => void }) {
  const { me, refresh } = useMe();
  const { busy, err, run, setErr } = useRun();
  const [check, setCheck] = useState<CheckResult>();
  const [name, setName] = useState("");
  const [accept, setAccept] = useState("");
  const [done, setDone] = useState<{ label: string; version: number }[]>();
  const owner = hasRole(me, "process-owner") && me.user.kind !== "operator";
  const draftsKey = data.drafts.map((d) => `${d.kind}${d.version}`).join();
  useEffect(() => { if (data.drafts.length) void run("check", () => api.get<CheckResult>("/api/studio/setup/check")).then((r) => r && setCheck(r)); else setCheck(undefined); }, [draftsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const disagree = Boolean(check && check.tests.passed < check.tests.total);
  const blocking = (check?.drafts ?? []).flatMap((d) => d.issues.filter((i) => i.severity === "error" && !(i.message.includes("test cases disagree") && accept.trim())));

  async function publish(e: FormEvent) {
    e.preventDefault();
    if (name.trim().toLowerCase() !== me.user.name.trim().toLowerCase()) { setErr(`Type your full name exactly as "${me.user.name}" to sign.`); return; }
    const r = await run("publish", () => api.post<{ published: { label: string; version: number }[] }>("/api/studio/setup/publish", { typedName: name.trim(), acceptDifferences: accept.trim() || undefined }), "Published");
    if (r) { setDone(r.published); setName(""); setAccept(""); await refresh(); onChanged(); }
  }
  async function discard() {
    if (!window.confirm(`Throw away ${plural(data.drafts.length, "unpublished change")}? What is published stays as it is.`)) return;
    if (await run("discard", () => api.post("/api/studio/setup/discard"), "Changes discarded")) onChanged();
  }

  if (done) return (
    <section className="panel" aria-live="polite">
      <h2 style={{ fontSize: 22 }}>Published</h2>
      <p>{done.map((d) => `${d.label} v${d.version}`).join(", ")}, signed by {me.user.name}. New requests use them from now on; requests already started keep the setup they started with. The signature is in the audit trail.</p>
      <div className="row"><Link className="btn quiet" to="/studio">Back to step 1</Link><Link className="btn quiet" to="/audit">Open the audit trail</Link></div>
    </section>
  );
  if (!data.drafts.length) return (
    <div className="stack" style={{ gap: 16 }}>
      <p>There is nothing waiting to be published. Everything in steps 1 to 5 is in use.</p>
      <div><button type="button" className="btn quiet" onClick={back}>Back</button></div>
    </div>
  );
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="stack" style={{ gap: 8 }} aria-labelledby="h-changes">
        <h2 id="h-changes" style={{ fontSize: 22 }}>{plural(data.drafts.length, "change")} ready</h2>
        <ul className="setup-checks">
          {data.drafts.map((d) => {
            const c = check?.drafts.find((x) => x.kind === d.kind);
            const errors = c?.issues.filter((i) => i.severity === "error" && !i.message.includes("test cases disagree")) ?? [];
            const warnings = c?.issues.filter((i) => i.severity === "warning") ?? [];
            return (
              <li key={d.kind}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 500 }}>{d.label} <span className="muted mono small">v{d.version}</span></span>
                  {!c ? <span className="muted small">Checking…</span> : errors.length ? <span className="chip block">Needs fixing</span> : <span className="chip ok">Ready</span>}
                </div>
                {[...errors, ...warnings].map((i, n) => <p key={n} className={i.severity === "error" ? "error-text" : "small"} style={{ color: i.severity === "warning" ? "var(--warn)" : undefined }}>{i.where ? `${i.where}: ` : ""}{i.message}</p>)}
              </li>
            );
          })}
        </ul>
      </section>
      {check ? (
        <section className="stack" style={{ gap: 6 }} aria-labelledby="h-tests">
          <h2 id="h-tests" style={{ fontSize: 22 }}>Past requests</h2>
          <p className="small" style={{ color: disagree ? "var(--warn)" : "var(--accent)" }}>
            {check.tests.passed} of {check.tests.total} past requests in your test set get the same outcome with these changes.
            {disagree ? " The rest get a different outcome. That is expected when you change a limit; say why below, or change the setup." : ""}
          </p>
          {check.tests.failing.slice(0, 8).map((f) => <p key={f.id} className="small"><span className="mono">{f.id}</span> {f.title}: {f.mismatches.join("; ")}</p>)}
          {check.tests.failing.length > 8 ? <p className="help">and {check.tests.failing.length - 8} more.</p> : null}
        </section>
      ) : null}
      {owner ? (
        <form className="panel" onSubmit={publish}>
          <span className="eyebrow">Your signature · applies to new requests</span>
          {disagree ? (
            <div className="stack" style={{ gap: 4 }}>
              <label className="label" htmlFor="accept">Why the different outcomes are right</label>
              <textarea id="accept" className="textarea" rows={2} style={{ minHeight: 60 }} value={accept} onChange={(e) => setAccept(e.target.value)} placeholder="For example: our lead time is 45 days, so these requests are no longer late." />
            </div>
          ) : null}
          <div className="sign-row">
            <div className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
              <label className="label" htmlFor="pub-name">Type your full name to publish</label>
              <input id="pub-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={me.user.name} autoComplete="off" />
            </div>
            <button type="submit" className="btn" disabled={Boolean(busy) || !check || blocking.length > 0}>{busy === "publish" ? "Publishing…" : `Publish ${plural(data.drafts.length, "change")}`}</button>
          </div>
          {blocking.length && check ? <p className="help">{disagree && !accept.trim() ? "Say why the different outcomes are right, and fix anything marked “Needs fixing”." : "Fix anything marked “Needs fixing” first."}</p> : null}
        </form>
      ) : <p className="muted small">Only the process owner can publish.</p>}
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <div className="setup-nav">
        <button type="button" className="btn quiet" onClick={back}>Back</button>
        {hasRole(me, "process-owner", "operator") ? <button type="button" className="btn quiet danger" onClick={() => void discard()} disabled={Boolean(busy)}>Discard all changes</button> : null}
      </div>
    </div>
  );
}

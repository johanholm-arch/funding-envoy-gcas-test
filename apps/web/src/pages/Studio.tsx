import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { assistantName, hasRole, useMe, useToast } from "../lib/app";
import { contrastWithGround } from "../lib/brand";
import { prepareLogo } from "../lib/logo";
import { fmtDate, plural, roleWords } from "../lib/format";
import { useDocumentTitle, useMediaQuery, useResource } from "../lib/hooks";

type Kind = "brand" | "words" | "catalogue" | "rulebook" | "workflow" | "autonomy" | "policy" | "sop" | "testset";
interface OverviewRow { kind: Kind; published?: { version: number; signedName: string; signedAt: string }; draft?: { version: number; createdAt: string; note?: string }; versions: number }
interface VersionBody<T = unknown> { version: number; body: T; status?: string; signedName?: string; signedAt?: string }
interface Issue { severity: "error" | "warning"; where?: string; message: string }
interface TestReport { results: { id: string; title: string; ok: boolean; mismatches: string[] }[]; passed: number; total: number; rulebookVersion?: number; catalogueVersion?: number }
interface AutonomyStage { id: string; name: string; does: string; level: number; label: string; max: number; locked: string[]; sopRefs: string[]; preview: { level: number; label: string; total: number; applied: number; heldForPerson: number; appliedPct: number }[] }

const KINDS: { kind: Kind; label: string; what: string }[] = [
  { kind: "brand", label: "Brand", what: "Colour and name on every page the requestor sees. The layout never changes." },
  { kind: "words", label: "Words", what: "Your terms, applied everywhere, including the assistant's messages." },
  { kind: "catalogue", label: "Catalogue and fields", what: "Request types, their fields, documents, statements and conflict questions." },
  { kind: "rulebook", label: "Rulebook", what: "Checks with their basis and the message each one shows." },
  { kind: "workflow", label: "Workflow", what: "Stages, owners and time allowed, drafted from the SOP." },
  { kind: "autonomy", label: "FundingEnvoy", what: "How much the assistant does at each stage. Five outcomes are always a person's." },
  { kind: "policy", label: "Policy", what: "The policy the assistant quotes when it answers." },
  { kind: "sop", label: "SOP", what: "The source the workflow is drafted from." },
  { kind: "testset", label: "Test set", what: "Past requests with known outcomes, run before every publication." },
];

export function Studio() {
  useDocumentTitle("Studio");
  const { kind } = useParams();
  const navigate = useNavigate();
  const phone = useMediaQuery("(max-width: 899px)");
  const ov = useResource<OverviewRow[]>("/api/studio");
  useEffect(() => { if (!kind && !phone) navigate("/studio/workflow", { replace: true }); }, [kind, phone, navigate]);
  const current = KINDS.find((k) => k.kind === kind);
  const row = ov.data?.find((r) => r.kind === kind);

  return (
    <div className="desk" data-view={kind ? "brief" : "queue"}>
      <nav className="queue" aria-label="Studio sections">
        <div className="queue-scroll">
          <section className="queue-group">
            <h2>Studio</h2>
            <p className="queue-empty" style={{ paddingTop: 0 }}>Each section is a signed version. Requests keep the version they started on.</p>
            {ov.error ? <p className="queue-empty error-text">{ov.error.message}</p> : null}
            {KINDS.map((k) => {
              const r = ov.data?.find((x) => x.kind === k.kind);
              return (
                <Link key={k.kind} to={`/studio/${k.kind}`} className="qrow" aria-current={k.kind === kind ? "true" : undefined}>
                  <span className="top"><span className="t">{k.label}</span>{r?.published ? <span className="mono small">v{r.published.version}</span> : null}</span>
                  <span className="m">{k.what}</span>
                  {r?.draft ? <span className="chips"><span className="chip warn">Draft v{r.draft.version}</span></span> : null}
                </Link>
              );
            })}
          </section>
        </div>
      </nav>
      <div className="brief">
        {current ? (
          <div className="brief-inner">
            {phone ? <p><Link to="/studio">All sections</Link></p> : null}
            <KindPanel key={current.kind} meta={current} row={row} onChanged={() => void ov.refetch()} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function KindPanel({ meta, row, onChanged }: { meta: (typeof KINDS)[number]; row?: OverviewRow; onChanged: () => void }) {
  const { me, refresh } = useMe();
  const toast = useToast();
  const owner = hasRole(me, "process-owner");
  const canEdit = me.user.roles.some((r) => r === "process-owner" || r === "operator") || me.user.kind === "operator";
  const pub = useResource<VersionBody>(row?.published || meta.kind ? `/api/studio/${meta.kind}/published` : undefined);
  const draft = useResource<VersionBody>(row?.draft ? `/api/studio/${meta.kind}/${row.draft.version}` : undefined);
  const [issues, setIssues] = useState<{ issues: Issue[]; tests?: TestReport }>();
  const [diff, setDiff] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [name, setName] = useState("");
  const [accept, setAccept] = useState("");

  async function run<T>(key: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    setBusy(key); setErr(undefined);
    try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { setErr(errorText(e)); return undefined; } finally { setBusy(undefined); }
  }

  async function saveDraft(body: unknown, note: string) {
    const ok = await run("save", async () => {
      if (row?.draft) await fetchPut(`/api/studio/${meta.kind}/${row.draft.version}`, { body });
      else await api.post(`/api/studio/${meta.kind}/drafts`, { note, body });
      return true;
    }, row?.draft ? `Draft v${row.draft.version} saved` : "Draft saved");
    if (ok) { onChanged(); await draft.refetch(); setIssues(undefined); setDiff(undefined); }
  }

  const testsDisagree = Boolean(issues?.tests && issues.tests.passed < issues.tests.total);
  const blocking = (issues?.issues ?? []).filter((i) => i.severity === "error" && !(i.message.includes("test cases disagree") && accept.trim()));

  async function publish(e: FormEvent) {
    e.preventDefault();
    if (!row?.draft) return;
    if (name.trim().toLowerCase() !== me.user.name.trim().toLowerCase()) { setErr(`Type your full name exactly as "${me.user.name}" to sign this version.`); return; }
    const r = await run("publish", () => api.post<{ version: number; diff: { summary: string } }>(`/api/studio/${meta.kind}/${row.draft!.version}/publish`, { typedName: name.trim(), acceptDifferences: accept.trim() || undefined }), `Published v${row.draft.version}`);
    if (r) { setName(""); setAccept(""); setIssues(undefined); onChanged(); await pub.refetch(); if (meta.kind === "brand" || meta.kind === "words") await refresh(); }
  }

  const editorBody = (draft.data?.body ?? pub.data?.body) as Record<string, unknown> | undefined;
  return (
    <div className="stack" style={{ gap: 28 }}>
      <header className="stack" style={{ gap: 8 }}>
        <span className="eyebrow">Studio · {meta.label}</span>
        <h1 style={{ fontSize: 34 }}>{meta.label}</h1>
        <p className="muted">{meta.what}</p>
        <p className="status-line">
          {row?.published ? `Published v${row.published.version}, signed by ${row.published.signedName} on ${fmtDate(row.published.signedAt)}.` : "Nothing published yet."}
          {row?.draft ? ` Draft v${row.draft.version} in progress${row.draft.note ? `: ${row.draft.note}` : ""}.` : ""}
        </p>
      </header>

      {meta.kind === "brand" ? <BrandEditor body={editorBody} draftVersion={row?.draft?.version} canEdit={canEdit} busy={busy} onSave={(b) => void saveDraft(b, "Brand change")} /> : null}
      {meta.kind === "words" ? <WordsEditor body={editorBody} canEdit={canEdit} busy={busy} onSave={(b) => void saveDraft(b, "Words change")} /> : null}
      {meta.kind === "autonomy" ? <AutonomyEditor body={editorBody} canEdit={canEdit} busy={busy} onSave={(b) => void saveDraft(b, "Autonomy change")} /> : null}
      {meta.kind === "workflow" ? <WorkflowView body={(draft.data ?? pub.data)?.body} /> : null}
      {meta.kind === "rulebook" ? <RulebookView body={(draft.data ?? pub.data)?.body} /> : null}
      {meta.kind === "catalogue" ? <CatalogueView body={(draft.data ?? pub.data)?.body} /> : null}
      {meta.kind === "policy" || meta.kind === "sop" ? <DocumentView body={(draft.data ?? pub.data)?.body} /> : null}
      {meta.kind === "sop" && canEdit ? <SopUpload onDone={onChanged} /> : null}
      {meta.kind === "testset" || meta.kind === "rulebook" || meta.kind === "catalogue" ? <Tests /> : null}

      {row?.draft ? (
        <section className="panel" aria-labelledby="h-draft">
          <div className="section-head"><h2 id="h-draft" style={{ fontSize: 20 }}>Draft v{row.draft.version}</h2><span className="chip warn">Not in use</span></div>
          <p className="muted small">Started {fmtDate(row.draft.createdAt)}{row.draft.note ? ` · ${row.draft.note}` : ""}. Nothing changes for requests until it is published.</p>
          <div className="row">
            <button type="button" className="btn small quiet" disabled={Boolean(busy)} onClick={() => void run("validate", () => api.get<{ issues: Issue[]; tests?: TestReport }>(`/api/studio/${meta.kind}/${row.draft!.version}/validate`)).then((r) => r && setIssues(r))}>Check this version</button>
            {row.published ? <button type="button" className="btn small quiet" disabled={Boolean(busy)} onClick={() => void run("diff", () => api.get<{ summary: string }>(`/api/studio/${meta.kind}/diff/${row.published!.version}/${row.draft!.version}`)).then((r) => r && setDiff(r.summary))}>Compare with v{row.published.version}</button> : null}
            {canEdit ? <button type="button" className="btn small quiet danger" disabled={Boolean(busy)} onClick={() => void run("discard", () => fetchDelete(`/api/studio/${meta.kind}/${row.draft!.version}`), "Draft discarded").then(() => onChanged())}>Discard draft</button> : null}
          </div>
          {diff ? <p className="small">Compared with v{row.published?.version}: {diff}</p> : null}
          {issues ? (
            <div className="stack" style={{ gap: 6 }}>
              {issues.issues.length ? issues.issues.map((i, n) => <p key={n} className={i.severity === "error" ? "error-text" : "small"} style={{ color: i.severity === "warning" ? "var(--warn)" : undefined }}>{i.where ? `${i.where}: ` : ""}{i.message}</p>) : <p className="small" style={{ color: "var(--accent)" }}>No problems found.</p>}
              {issues.tests ? <p className="small">Test set: {issues.tests.passed} of {issues.tests.total} cases agree with this version.</p> : null}
            </div>
          ) : null}
          {owner ? (
            <form className="stack" style={{ gap: 10, borderTop: "1px solid var(--rule)", paddingTop: 14 }} onSubmit={publish}>
              <span className="eyebrow">Publishing is your signature · applies to new requests</span>
              {testsDisagree ? (
                <div className="stack" style={{ gap: 4 }}>
                  <label className="label" htmlFor="accept">Why the differences from the test set are acceptable</label>
                  <textarea id="accept" className="textarea" rows={2} style={{ minHeight: 60 }} value={accept} onChange={(e) => setAccept(e.target.value)} />
                </div>
              ) : null}
              <div className="sign-row">
                <div className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
                  <label className="label" htmlFor="pub-name">Type your full name to publish v{row.draft.version}</label>
                  <input id="pub-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={me.user.name} autoComplete="off" />
                </div>
                <button type="submit" className="btn" disabled={Boolean(busy) || (issues ? blocking.length > 0 : false)}>Publish v{row.draft.version}</button>
              </div>
              {!issues ? <p className="help">Check this version first; publishing runs the same checks and the test set.</p> : null}
            </form>
          ) : <p className="muted small">Only the process owner can publish.</p>}
        </section>
      ) : canEdit && !["brand", "words", "autonomy", "sop"].includes(meta.kind) ? (
        <div><button type="button" className="btn quiet" disabled={Boolean(busy)} onClick={() => void run("draft", () => api.post(`/api/studio/${meta.kind}/drafts`, { note: `Started from v${row?.published?.version ?? ""}` }), "Draft started").then(() => onChanged())}>Start a draft from the published version</button></div>
      ) : null}
      {err ? <p className="error-text" role="alert">{err}</p> : null}
    </div>
  );
}

async function fetchPut(url: string, body: unknown) {
  const r = await fetch(url, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Saving the draft failed.");
}
async function fetchDelete(url: string) {
  const r = await fetch(url, { method: "DELETE", credentials: "same-origin" });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Discarding failed.");
}

interface LogoRef { sha: string; mime: string; name?: string }

function BrandEditor({ body, draftVersion, canEdit, busy, onSave }: { body?: Record<string, unknown>; draftVersion?: number; canEdit: boolean; busy?: string; onSave: (b: unknown) => void }) {
  const { me } = useMe();
  const [color, setColor] = useState(String(body?.color ?? "#176B63"));
  const [logo, setLogo] = useState(String(body?.logoText ?? ""));
  const [image, setImage] = useState<LogoRef | undefined>(body?.logo as LogoRef | undefined);
  const [localUrl, setLocalUrl] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [imgErr, setImgErr] = useState<string>();
  const [imgNote, setImgNote] = useState<string>();
  useEffect(() => { setColor(String(body?.color ?? "#176B63")); setLogo(String(body?.logoText ?? "")); setImage(body?.logo as LogoRef | undefined); setLocalUrl(undefined); }, [body]);
  const c = contrastWithGround(color);
  // What the preview shows: a file just chosen, the draft's logo, or the published one.
  const imageUrl = !image ? undefined : localUrl ?? (draftVersion ? `/api/tenant/logo?v=${draftVersion}&h=${image.sha.slice(0, 12)}` : me.tenant?.brand?.logoUrl);
  const changed = color !== String(body?.color ?? "#176B63") || logo !== String(body?.logoText ?? "") || (image?.sha ?? "") !== ((body?.logo as LogoRef | undefined)?.sha ?? "");

  async function chooseLogo(chosen: File | undefined) {
    if (!chosen) return;
    setImgErr(undefined); setImgNote(undefined);
    setUploading(true);
    try {
      // Empty borders are cropped and very large images scaled down here, before upload.
      const prepared = await prepareLogo(chosen).catch(() => ({ file: chosen, trimmed: false, resized: false }));
      const file = prepared.file;
      if (file.size > 512 * 1024) { setImgErr("That image is larger than 512 KB even after preparing it. Use a smaller one."); return; }
      if (prepared.trimmed) setImgNote("Empty space around the logo was cropped so it fills its space.");
      const fd = new FormData();
      fd.append("file", file, file.name);
      const ref = await api.post<LogoRef>("/api/studio/brand/logo", fd);
      setImage(ref);
      setLocalUrl(URL.createObjectURL(file));
    } catch (e) { setImgErr(errorText(e)); } finally { setUploading(false); }
  }
  return (
    <section className="panel calm" aria-labelledby="h-brand">
      <h2 id="h-brand" style={{ fontSize: 20 }}>Colour and name</h2>
      <div className="row" style={{ alignItems: "flex-start", gap: 20 }}>
        <div className="stack" style={{ gap: 4 }}>
          <label className="label" htmlFor="b-color">Brand colour</label>
          <div className="row"><input id="b-color" type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#176b63"} onChange={(e) => setColor(e.target.value)} disabled={!canEdit} style={{ width: 44, height: 44, padding: 0, border: "1px solid var(--ink)", borderRadius: 2 }} />
            <input className="input mono" style={{ width: 120 }} value={color} onChange={(e) => setColor(e.target.value)} disabled={!canEdit} aria-label="Colour as hex" /></div>
          <p className={c.light >= 4.5 ? "help" : "error-text"}>Contrast on the page: {c.light.toFixed(1)}:1 {c.light >= 4.5 ? "(passes AA)" : "(below 4.5:1; links and chips will be darkened to stay readable)"} · on dark: {c.dark.toFixed(1)}:1</p>
        </div>
        <div className="stack" style={{ gap: 4, flex: "1 1 240px" }}>
          <label className="label" htmlFor="b-logo">Name shown in the top bar</label>
          <input id="b-logo" className="input" value={logo} onChange={(e) => setLogo(e.target.value)} disabled={!canEdit} />
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="label">Logo</span>
        <div className="row" style={{ gap: 14, alignItems: "center" }}>
          {imageUrl ? <span className="logo-stage"><img className="logo-preview" src={imageUrl} alt="Logo" /></span> : <span className="muted small">No logo. The name above is shown instead.</span>}
          {canEdit ? (
            <>
              <label className="btn small quiet" style={{ cursor: "pointer" }}>
                {uploading ? "Uploading…" : image ? "Choose another image" : "Upload a logo"}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" disabled={uploading} onChange={(e) => { void chooseLogo(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              {image ? <button type="button" className="linkbtn small" onClick={() => { setImage(undefined); setLocalUrl(undefined); }}>Remove logo</button> : null}
            </>
          ) : null}
        </div>
        <p className="help">PNG, JPEG, WebP or SVG. A wide logo meant for light backgrounds works best. Empty space around it is cropped automatically, and it is shown 40 pixels high in the top bar, as in the preview below.</p>
        {imgNote ? <p className="small" style={{ color: "var(--accent)" }}>{imgNote}</p> : null}
        {imgErr ? <p className="error-text" role="alert">{imgErr}</p> : null}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">Preview as the requestor</span>
        <div style={{ border: "1px solid var(--rule)", padding: "12px 16px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", background: "var(--ground)" }}>
          <span className="brand">{imageUrl ? <img className="brand-logo" src={imageUrl} alt={logo || "Company"} /> : logo || "Company"} <span className="seat">· Funding</span></span>
          <span className="chip" style={{ background: `color-mix(in srgb, ${color} 12%, #fff)`, color }}>Passed</span>
          <a href="#preview" onClick={(e) => e.preventDefault()} style={{ color }}>A link in your colour</a>
          <span className="dot" style={{ background: color }} aria-hidden="true" />
        </div>
        <p className="help">Only the colour and name change. The layout, the safety rules and the locked outcomes are the platform's.</p>
      </div>
      {canEdit ? (
        <div className="row">
          <button type="button" className="btn" disabled={Boolean(busy) || uploading || !changed} onClick={() => { const { logo: _old, ...rest } = body ?? {}; onSave({ ...rest, color, logoText: logo, ...(image ? { logo: image } : {}) }); }}>Save as draft</button>
          {!changed ? <span className="muted small">Change the colour, name or logo to start a draft.</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function WordsEditor({ body, canEdit, busy, onSave }: { body?: Record<string, unknown>; canEdit: boolean; busy?: string; onSave: (b: unknown) => void }) {
  const [words, setWords] = useState<Record<string, string>>({});
  useEffect(() => setWords(Object.fromEntries(Object.entries(body ?? {}).map(([k, v]) => [k, String(v)]))), [body]);
  const LABELS: Record<string, string> = { request: "A request is called", committee: "The committee is called", assistantName: "The assistant is called", reviewingTeam: "A reviewing team is called", reconciliation: "Reconciliation is called" };
  return (
    <section className="panel calm" aria-labelledby="h-words">
      <h2 id="h-words" style={{ fontSize: 20 }}>Your terms</h2>
      <div className="stack" style={{ gap: 10 }}>
        {Object.keys(words).map((k) => (
          <div key={k} className="kv" style={{ alignItems: "center" }}>
            <label className="k" htmlFor={`w-${k}`}>{LABELS[k] ?? k}</label>
            <input id={`w-${k}`} className="input" value={words[k]} onChange={(e) => setWords((w) => ({ ...w, [k]: e.target.value }))} disabled={!canEdit} />
          </div>
        ))}
      </div>
      {canEdit ? <div><button type="button" className="btn" disabled={Boolean(busy)} onClick={() => onSave(words)}>Save as draft</button></div> : null}
    </section>
  );
}

function AutonomyEditor({ body, canEdit, busy, onSave }: { body?: Record<string, unknown>; canEdit: boolean; busy?: string; onSave: (b: unknown) => void }) {
  const { me } = useMe();
  const fe = assistantName(me);
  const view = useResource<{ profile: string; confidenceFloor: number; stages: AutonomyStage[] }>("/api/studio/autonomy");
  const overrides = (body?.overrides as { stage: string; level: number }[] | undefined) ?? [];
  const [levels, setLevels] = useState<Record<string, number>>({});
  useEffect(() => setLevels(Object.fromEntries(overrides.map((o) => [o.stage, o.level]))), [body]); // eslint-disable-line react-hooks/exhaustive-deps
  const LEVELS = ["Off", "Observe", "Recommend", "Act with confirmation", "Autonomous"];
  const stages = view.data?.stages ?? [];
  const changed = stages.some((s) => (levels[s.id] ?? s.level) !== s.level);
  return (
    <section className="stack" style={{ gap: 10 }} aria-labelledby="h-dial">
      <h2 id="h-dial" style={{ fontSize: 20 }}>The dial, stage by stage</h2>
      <p className="muted small">Five outcomes are always a named person's and cannot be dialled: the funding decision, statements, agreement signature, payment release and disclosure submission. Confidence never decides on its own; reversibility and impact do.</p>
      {view.error ? <p className="error-text">{view.error.message}</p> : null}
      <div style={{ borderTop: "1px solid var(--ink)" }}>
        {stages.map((s) => {
          const lv = levels[s.id] ?? s.level;
          const p = s.preview.find((x) => x.level === lv);
          return (
            <div key={s.id} className="crow" style={{ gridTemplateColumns: "minmax(0,1.3fr) 220px minmax(0,1.2fr)" }}>
              <span><strong style={{ fontWeight: 500 }}>{s.name}</strong><span className="note-basis"> · {s.sopRefs.join(", ")}</span><br /><span className="muted small">{s.does}</span></span>
              <span>
                <label className="sr-only" htmlFor={`lv-${s.id}`}>Level for {s.name}</label>
                <select id={`lv-${s.id}`} className="select small" value={lv} disabled={!canEdit} onChange={(e) => setLevels((x) => ({ ...x, [s.id]: Number(e.target.value) }))}>
                  {LEVELS.slice(0, s.max + 1).map((l, i) => <option key={l} value={i}>{i} · {l}</option>)}
                </select>
                {s.locked.length ? <span className="help" style={{ display: "block", marginTop: 4 }}>Locked to a person: {[...new Set(s.locked)].map((x) => x.replace(/-/g, " ")).join(", ")}</span> : null}
              </span>
              <span className="small">{p && p.total ? `At level ${lv}, ${p.applied} of ${p.total} of ${fe}'s recent actions here would have gone ahead without a person; ${p.heldForPerson} would have waited for you.` : `No recent ${fe} actions at this stage to preview.`}</span>
            </div>
          );
        })}
      </div>
      {canEdit ? <div className="row"><button type="button" className="btn" disabled={Boolean(busy) || !changed} onClick={() => onSave({ ...(body ?? {}), profile: "custom", overrides: stages.map((s) => ({ stage: s.id, level: levels[s.id] ?? s.level })), confidenceFloor: view.data?.confidenceFloor ?? 0.7 })}>Save as draft</button>{!changed ? <span className="muted small">Change a level to start a draft.</span> : null}</div> : null}
    </section>
  );
}

function WorkflowView({ body }: { body?: unknown }) {
  const wf = body as { name?: string; source?: { document: string }; stages?: { id: string; order: number; name: string; ownerRoles: string[]; slaBusinessDays?: number; sopRefs: string[]; assistant: { level: number } }[] } | undefined;
  if (!wf?.stages) return null;
  return (
    <section className="stack" style={{ gap: 6 }} aria-labelledby="h-wf">
      <div className="section-head"><h2 id="h-wf" style={{ fontSize: 20 }}>{wf.name ?? "Workflow"}</h2>{wf.source?.document ? <span className="muted small">Drafted from {wf.source.document}</span> : null}</div>
      <div className="crow head"><span>Stage · who</span><span>Time allowed</span><span>From</span></div>
      {[...wf.stages].sort((a, b) => a.order - b.order).map((s) => (
        <div key={s.id} className="crow">
          <span><span className="mono muted">{s.order}</span> {s.name}<br /><span className="muted small">{s.ownerRoles.map(roleWords).join(", ")}</span></span>
          <span className="small">{s.slaBusinessDays ? `${s.slaBusinessDays} working days` : "No limit"}</span>
          <span className="r">{s.sopRefs.join(" · ")}</span>
        </div>
      ))}
    </section>
  );
}

function RulebookView({ body }: { body?: unknown }) {
  const rb = body as { rules?: { id: string; statement: string; severity: string; basis: { ref: string } }[]; packs?: { id: string; version: number }[] } | undefined;
  const [q, setQ] = useState("");
  const rules = useMemo(() => (rb?.rules ?? []).filter((r) => !q || `${r.id} ${r.statement} ${r.basis.ref}`.toLowerCase().includes(q.toLowerCase())), [rb, q]);
  if (!rb?.rules) return null;
  return (
    <section className="stack" style={{ gap: 6 }} aria-labelledby="h-rb">
      <div className="section-head"><h2 id="h-rb" style={{ fontSize: 20 }}>{plural(rb.rules.length, "tenant rule")}{rb.packs ? ` on ${plural(rb.packs.length, "pack")}` : ""}</h2>
        <input className="input small" style={{ width: 240 }} aria-label="Find a rule" placeholder="Find a rule" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="crow head"><span>Rule</span><span>Severity</span><span>Basis</span></div>
      {rules.map((r) => (
        <div key={r.id} className="crow"><span><span className="mono muted">{r.id}</span> {r.statement}</span><span><span className={`chip ${r.severity === "block" ? "block" : r.severity === "warn" ? "warn" : ""}`}>{r.severity === "block" ? "Must fix" : r.severity === "warn" ? "Your call" : r.severity === "judge" ? "For a reviewer" : "Note"}</span></span><span className="r">{r.basis.ref}</span></div>
      ))}
    </section>
  );
}

function CatalogueView({ body }: { body?: unknown }) {
  const cat = body as { subtypes?: { id: string; name: string; family: string; fields: unknown[]; documents: unknown[]; attestations: string[]; coi: string[] }[] } | undefined;
  if (!cat?.subtypes) return null;
  return (
    <section className="stack" style={{ gap: 6 }} aria-labelledby="h-cat">
      <h2 id="h-cat" style={{ fontSize: 20 }}>{plural(cat.subtypes.length, "request type")}</h2>
      <div className="crow head"><span>Type</span><span>Family</span><span>What it asks</span></div>
      {cat.subtypes.map((s) => (
        <div key={s.id} className="crow"><span>{s.name}</span><span className="small">{s.family}</span><span className="small">{plural(s.fields.length, "field")} · {plural(s.documents.length, "document")} · {plural(s.attestations.length, "statement")} · {plural(s.coi.length, "conflict question")}</span></div>
      ))}
    </section>
  );
}

function DocumentView({ body }: { body?: unknown }) {
  const d = body as { title?: string; markdown?: string } | undefined;
  if (!d?.markdown) return null;
  const clauses = d.markdown.split("\n").filter((l) => /^\s*\d+(\.\d+)+\s/.test(l)).length;
  return (
    <section className="stack" style={{ gap: 6 }}>
      <h2 style={{ fontSize: 20 }}>{d.title}</h2>
      <p className="muted small">{plural(clauses, "numbered clause")} · {plural(d.markdown.split(/\s+/).length, "word")}</p>
      <details><summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>Read the text</summary><pre className="small" style={{ whiteSpace: "pre-wrap", fontFamily: "var(--serif)", fontSize: 15, lineHeight: 1.55 }}>{d.markdown}</pre></details>
    </section>
  );
}

function SopUpload({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [md, setMd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [res, setRes] = useState<{ clauses: { total: number; changed: string[]; added: string[]; removed: string[] }; stageImpact: { stage: string; name: string; affectedBy: string[]; orphaned: string[] }[]; questions: { clause: string; text: string }[]; drafts: { sop?: number; workflow?: number }; note: string }>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3 || md.trim().length < 50) { setErr("Give the SOP a title and paste or upload its text (at least a few clauses)."); return; }
    setBusy(true); setErr(undefined);
    try { setRes(await api.post("/api/studio/sop", { title: title.trim(), markdown: md })); onDone(); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return (
    <section className="panel calm" aria-labelledby="h-sop">
      <h2 id="h-sop" style={{ fontSize: 20 }}>Upload a new SOP version</h2>
      <p className="muted small">The assistant compares it clause by clause with the current SOP, re-drafts the workflow, shows which stages are affected and asks about anything the SOP leaves unsaid. Nothing changes until you publish.</p>
      <form className="stack" style={{ gap: 10 }} onSubmit={submit}>
        <div className="stack" style={{ gap: 4 }}><label className="label" htmlFor="sop-t">Title</label><input id="sop-t" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Management of Grants and Donations SOP v5" /></div>
        <div className="stack" style={{ gap: 4 }}>
          <label className="label" htmlFor="sop-md">Text</label>
          <textarea id="sop-md" className="textarea" rows={6} value={md} onChange={(e) => setMd(e.target.value)} placeholder="Paste the SOP, or choose a Markdown or text file" />
          <input type="file" accept=".md,.txt" aria-label="Choose an SOP file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setMd(await f.text()); if (!title) setTitle(f.name.replace(/\.[a-z]+$/i, "")); } }} />
        </div>
        {err ? <p className="error-text" role="alert">{err}</p> : null}
        <div><button type="submit" className="btn" disabled={busy}>{busy ? "Comparing…" : "Compare and draft the workflow"}</button></div>
      </form>
      {res ? (
        <div className="stack" style={{ gap: 8 }} aria-live="polite">
          <p>{res.clauses.total} clauses: {res.clauses.changed.length} changed, {res.clauses.added.length} new, {res.clauses.removed.length} removed. Drafts created: SOP v{res.drafts.sop ?? "?"}, workflow v{res.drafts.workflow ?? "?"}.</p>
          {res.stageImpact.length ? <div className="stack" style={{ gap: 2 }}><span className="eyebrow">Stages affected</span>{res.stageImpact.map((s) => <p key={s.stage} className="small">{s.name}: clause {s.affectedBy.join(", ")}{s.orphaned.length ? ` (removed: ${s.orphaned.join(", ")})` : ""}</p>)}</div> : <p className="small">No stage cites a changed clause.</p>}
          {res.questions.length ? <div className="stack" style={{ gap: 2 }}><span className="eyebrow">What the SOP leaves unsaid</span>{res.questions.map((q, i) => <p key={i} className="small">{q.text}</p>)}</div> : null}
          <p className="muted small">{res.note} <Link to="/studio/workflow">Open the workflow draft</Link></p>
        </div>
      ) : null}
    </section>
  );
}

function Tests() {
  const [rep, setRep] = useState<TestReport>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async () => { setBusy(true); setErr(undefined); try { setRep(await api.get<TestReport>("/api/studio/tests")); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); } };
  useEffect(() => { void run(); }, []);
  const failing = rep?.results.filter((r) => !r.ok) ?? [];
  return (
    <section className="stack" style={{ gap: 6 }} aria-labelledby="h-tests">
      <div className="section-head"><h2 id="h-tests" style={{ fontSize: 20 }}>Test set</h2><button type="button" className="btn small quiet" onClick={() => void run()} disabled={busy}>{busy ? "Running…" : "Run again"}</button></div>
      {err ? <p className="error-text">{err}</p> : null}
      {rep ? <p className={failing.length ? "error-text" : "small"} style={{ color: failing.length ? undefined : "var(--accent)" }}>{rep.passed} of {rep.total} past requests get the expected outcome with the published rulebook v{rep.rulebookVersion} and catalogue v{rep.catalogueVersion}.</p> : busy ? <p className="muted small">Running {""}the test set…</p> : null}
      {failing.map((r) => <p key={r.id} className="small"><span className="mono">{r.id}</span> {r.title}: {r.mismatches.join("; ")}</p>)}
      {rep ? <details><summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>Every case</summary>{rep.results.map((r) => <p key={r.id} className="small"><span className={`chip ${r.ok ? "ok" : "block"}`}>{r.ok ? "Agrees" : "Differs"}</span> <span className="mono">{r.id}</span> {r.title}</p>)}</details> : null}
    </section>
  );
}

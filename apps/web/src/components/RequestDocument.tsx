import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { assistantName, useMe } from "../lib/app";
import { fieldValueText, fmtDate, fmtMoney, fmtTime, fmtWhen, humanize, plural, sourceLabel } from "../lib/format";
import { countryName, docLabel, flaggedLines, orgTypeName, shortDocLabel, statusSentence } from "../lib/request";
import type { DocumentEntry, FieldDef, FieldValue } from "../lib/types";
import { useRequest } from "./requestCtx";
import { acceptFor, FieldInput, FilePick, isEmpty } from "./ui";
import { InfoAnswer } from "./InfoAnswer";
import { Reconciliation } from "./Reconciliation";

export function RequestDocument({ formView }: { formView: boolean }) {
  const { me } = useMe();
  const { view: v, editable, requestor, id } = useRequest();
  const r = v.request;
  const title = (r.fields.title?.value as string | undefined) ?? r.title;
  const s = v.summary;
  const proposed = Object.values(r.fields).filter((f) => f.status === "proposed").length;
  const decide = s.yourCall.filter((c) => !c.acknowledged).length;
  const openInfo = r.infoRequests?.find((i) => i.status === "open");
  const sections = v.sections.filter((sec) => !(requestor && sec.id === "internal"));
  const savedAt = useMemo(() => latestChange(v.request.fields), [v.request.fields]);

  return (
    <article className="doc" aria-labelledby="doc-title" id="doc-top">
      <header className="doc-head">
        <span className="eyebrow">
          {r.status === "draft" ? "Request · draft · nothing has been sent" : `${r.ref} · ${v.stage.name}`}
        </span>
        <h1 id="doc-title">{title ?? "Untitled request"}</h1>
        <p className="muted">
          {[v.subtype?.name, v.organization.legalName, savedAt && r.status === "draft" ? `saved ${fmtTime(savedAt)}` : undefined, `checked against rulebook v${r.versions.rulebook}`].filter(Boolean).join(" · ")}
        </p>
        {r.status !== "draft" ? <p className="status-line">{statusSentence(v)}</p> : null}
        {editable && r.typeConfirmed ? (
          <div className="chips" aria-label="Where the request stands">
            <span className="chip">{v.progress.answered} of {v.progress.total} answers</span>
            <span className="chip">{v.progress.documentsPresent} of {v.progress.documentsRequired} documents</span>
            {proposed ? <span className="chip proposed">{proposed} to confirm</span> : null}
            {s.mustFix.length ? <span className="chip block">{s.mustFix.length} to fix</span> : null}
            {decide ? <span className="chip warn">{decide} to decide</span> : null}
            <span className="chip ok">{s.passed.length} passed</span>
          </div>
        ) : null}
        {editable && proposed ? <ConfirmAll count={proposed} /> : null}
        {!requestor ? <p className="small"><Link to={`/desk/${id}`}>Open the brief</Link> · <Link to={`/audit/${id}`}>Trail</Link></p> : null}
        {requestor && r.status !== "draft" ? <p className="small"><Link to={`/requests/${id}/trail`}>Everything that happened on this request</Link></p> : null}
        {requestor && r.status === "agreement" ? <p><Link className="btn small" to={`/requests/${id}/agreement`}>Read and sign the agreement</Link></p> : null}
      </header>

      {openInfo && requestor ? <InfoAnswer info={openInfo} /> : null}
      {requestor && (r.status === "reconciliation" || r.status === "outcomes") ? <Reconciliation /> : null}

      <TypeSection />
      <OrgSection />

      {sections.map((sec) => (
        <section key={sec.id} className="doc-section" aria-labelledby={`h-${sec.id}`} id={`sec-${sec.id}`}>
          <h2 id={`h-${sec.id}`}>{sec.label}</h2>
          {sec.fields.map((f) => <FieldRow key={f.key} def={f} fv={f.current} formView={formView} />)}
          {sec.id === "funding" && r.budget.length ? <Budget /> : null}
        </section>
      ))}
      {!sections.some((x) => x.id === "funding") && r.budget.length ? (
        <section className="doc-section" aria-labelledby="h-budget"><h2 id="h-budget">Budget</h2><Budget /></section>
      ) : null}

      <Documents />
      {v.subtype ? <Statements /> : null}
      {editable && !r.typeConfirmed && !v.subtype ? (
        <p className="muted small">Once the type is confirmed, the questions, documents and statements for that type appear here. {assistantName(me)} asks only for what applies.</p>
      ) : null}
    </article>
  );
}

function latestChange(fields: Record<string, FieldValue>): string | undefined {
  return Object.values(fields).map((f) => f.confirmedAt).filter(Boolean).sort().pop();
}

function ConfirmAll({ count }: { count: number }) {
  const { act, id, busy } = useRequest();
  return (
    <div className="row" style={{ marginTop: 4 }}>
      <button type="button" className="btn small" disabled={Boolean(busy)}
        onClick={() => void act("confirm-all", () => api.post(`/api/requests/${id}/confirm-all`), `Confirmed ${plural(count, "value")}`)}>
        Confirm all {count} proposed
      </button>
      <span className="muted small">Read each underlined value first. Each shows the page or cell it came from.</span>
    </div>
  );
}

function TypeSection() {
  const { view: v, editable, act, id, busy } = useRequest();
  const r = v.request;
  const [choice, setChoice] = useState("");
  const [changing, setChanging] = useState(false);
  const proposedType = v.catalogue.subtypes.find((s) => s.id === r.subtype);
  if (!editable && !proposedType) return null;
  const confirm = (sid: string) => act("type", () => api.post(`/api/requests/${id}/choice`, { questionId: "type", optionId: `subtype:${sid}` }), "Request type confirmed");
  return (
    <section className="doc-section" aria-labelledby="h-type" id="type">
      <h2 id="h-type">Request type</h2>
      <div className={`frow ${!r.typeConfirmed && proposedType ? "proposed" : ""}`}>
        <span className="lbl">Type</span>
        <span className="val">{proposedType ? proposedType.name : <span className="unanswered">Not chosen yet</span>}</span>
        <span className="side">
          {r.typeConfirmed ? <span className="chip ok">Confirmed by you</span> : proposedType ? <span className="chip proposed">Proposed</span> : null}
        </span>
        {editable && r.typeConfirmed && !changing ? (
          <div className="inline-actions"><button type="button" className="btn small quiet" onClick={() => setChanging(true)}>Change type</button></div>
        ) : null}
        {editable && (!r.typeConfirmed || changing) ? (
          <div className="inline-actions">
            {!r.typeConfirmed && proposedType ? <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void confirm(proposedType.id)}>Confirm</button> : null}
            <label className="sr-only" htmlFor="type-select">{proposedType ? "Choose a different type" : "Choose the request type"}</label>
            <select id="type-select" className="select small" style={{ width: "auto", maxWidth: "100%" }} value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">{proposedType ? "Choose a different type…" : "Choose the request type…"}</option>
              {v.catalogue.subtypes.filter((s) => s.id !== r.subtype || !r.typeConfirmed).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {choice ? <button type="button" className="btn small quiet" disabled={Boolean(busy)} onClick={() => void confirm(choice).then(() => { setChoice(""); setChanging(false); })}>Use this type</button> : null}
            {changing ? <button type="button" className="btn small quiet" onClick={() => setChanging(false)}>Cancel</button> : null}
          </div>
        ) : null}
      </div>
      {editable && (!r.typeConfirmed || changing) ? <p className="muted small" style={{ marginTop: 6 }}>The type decides what else is asked and who reviews the request. Changing it later drops answers that don't apply to the new type.</p> : null}
    </section>
  );
}

function OrgSection() {
  const { view: v } = useRequest();
  const o = v.organization;
  const clear = o.screening.length && o.screening.every((x) => x.result === "clear");
  const checked = o.screening.map((x) => x.checkedAt).sort().pop();
  return (
    <section className="doc-section" aria-labelledby="h-org">
      <h2 id="h-org">Your organization</h2>
      <p className="section-note">From your organization's profile. Change it in the profile, not here.</p>
      <Row label="Organization" value={o.legalName} chip={<span className="chip ok">Profile{o.identifiers.ein ? " · EIN" : ""}</span>} />
      <Row label="Type · country" value={`${orgTypeName(o.type)} · ${countryName(o.country)}`} chip={<span className="chip ok">Profile</span>} />
      {o.taxStatus ? <Row label="Tax status" value={`${o.taxStatus.status}${o.taxStatus.asOf ? ` · determination ${fmtDate(o.taxStatus.asOf)}` : ""}`} chip={<span className="chip ok">Profile</span>} /> : null}
      {o.annualRevenue ? <Row label="Annual revenue" value={<span className="mono">{fmtMoney(o.annualRevenue.amount, o.annualRevenue.currency)} <span className="muted">({o.annualRevenue.fiscalYear})</span></span>} chip={<span className="chip ok">Profile</span>} /> : null}
      {o.screening.length ? (
        <Row label="Screening" value={clear ? `Not on ${o.screening.map((x) => x.list).join(", ")}` : o.screening.map((x) => `${x.list}: ${x.result}`).join(" · ")}
          chip={<span className={`chip ${clear ? "ok" : "warn"}`}>Checked {checked ? fmtDate(checked) : ""}</span>} />
      ) : null}
      {o.signers[0] ? <Row label="Authorized signer" value={`${o.signers[0].name}, ${o.signers[0].title}`} chip={<span className="chip ok">Profile</span>} /> : null}
    </section>
  );
}

function Row({ label, value, chip }: { label: string; value: React.ReactNode; chip?: React.ReactNode }) {
  return (
    <div className="frow">
      <span className="lbl">{label}</span>
      <span className="val">{value}</span>
      <span className="side">{chip}</span>
    </div>
  );
}

function SourceChip({ fv, label }: { fv: FieldValue; label: string }) {
  const { openEvidence, docTypeOf } = useRequest();
  const text = sourceLabel(fv.source, docTypeOf);
  if (!text) return null;
  const cls = `chip ${fv.status === "proposed" ? "proposed" : ""}`;
  if (fv.source.documentId) {
    return <button type="button" className={cls} title={fv.source.quote ? `"${fv.source.quote}"` : undefined} onClick={() => openEvidence({ source: fv.source, title: label })}>{text}</button>;
  }
  return <span className={cls} title={fv.source.quote ? `"${fv.source.quote}"` : fv.source.note}>{text}</span>;
}

export function FieldRow({ def, fv, formView }: { def: FieldDef; fv?: FieldValue; formView?: boolean }) {
  const { view: v, editable, act, id, editKey, setEditKey, busy } = useRequest();
  const editing = editKey === def.key;
  const currency = (v.request.fields["amount.currency"]?.value as string | undefined) ?? "USD";
  const empty = !fv || isEmpty(fv.value);
  const label = def.label;
  const inlineForm = Boolean(formView && empty && editable);

  if ((editing || inlineForm) && editable) return <FieldEditor def={def} fv={fv} inline={inlineForm && !editing} />;

  const prev = fv?.previous?.[fv.previous.length - 1];
  return (
    <div className={`frow ${fv?.status === "proposed" ? "proposed" : ""}`} id={`field-${def.key}`}>
      <span className="lbl">{label}{def.required ? "" : <span className="sr-only"> (optional)</span>}</span>
      <span className={`val ${def.kind === "longtext" ? "long" : ""}`}>
        {empty ? <span className="unanswered">{def.required ? "Not yet answered" : "Not given"}</span> : (
          <>
            <span className={def.kind === "money" || def.kind === "number" ? "mono" : undefined}>{fieldValueText(def, fv!.value, currency)}</span>
            {prev ? <span className="was"> · was {fieldValueText(def, prev.value, currency)}</span> : null}
          </>
        )}
      </span>
      <span className="side">
        {fv && !empty ? <SourceChip fv={fv} label={label} /> : null}
        {fv?.status === "changed" ? <span className="chip ok">Changed by you</span> : null}
        {empty && def.required && editable ? <span className="chip">Up next</span> : null}
      </span>
      {editable ? (
        <div className="inline-actions">
          {fv?.status === "proposed" ? (
            <button type="button" className="btn small" disabled={Boolean(busy)} aria-label={`Confirm ${label}`}
              onClick={() => void act(`confirm:${def.key}`, () => api.post(`/api/requests/${id}/fields`, { changes: [{ key: def.key, confirm: true }] }))}>Confirm</button>
          ) : null}
          {empty ? (
            <button type="button" className="btn small quiet" onClick={() => setEditKey(def.key)} aria-label={`Answer ${label}`}>Answer</button>
          ) : (
            <button type="button" className="btn small quiet" onClick={() => setEditKey(def.key)} aria-label={`Edit ${label}`}>Edit</button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FieldEditor({ def, fv, inline }: { def: FieldDef; fv?: FieldValue; inline: boolean }) {
  const { act, id, setEditKey, busy } = useRequest();
  const [value, setValue] = useState<unknown>(fv?.value ?? (def.kind === "boolean" ? undefined : ""));
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string>();
  const changing = fv !== undefined && !isEmpty(fv.value);
  const reasonRequired = changing && fv!.status !== "proposed";
  const inputId = `in-${def.key}`;

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (isEmpty(value)) { setErr(`Enter ${def.label.toLowerCase()}, or cancel.`); return; }
    if (reasonRequired && JSON.stringify(value) !== JSON.stringify(fv!.value) && !reason.trim()) { setErr("Say briefly why it changed. The reason is kept with the change."); return; }
    setErr(undefined);
    const ok = await act(`save:${def.key}`, () => api.post(`/api/requests/${id}/fields`, { changes: [{ key: def.key, value, reason: reason.trim() || undefined }] }), changing ? "Changed" : "Saved");
    if (ok) setEditKey(undefined);
  }

  return (
    <form className="frow editing" id={`field-${def.key}`} onSubmit={save} onBlur={inline ? (e) => {
      // In the form view an empty field saves itself when you move on.
      if (!e.currentTarget.contains(e.relatedTarget as Node) && !isEmpty(value)) void save();
    } : undefined}>
      <label className="lbl" htmlFor={inputId} id={`${inputId}-l`}>{def.label}</label>
      <div className="edit">
        <FieldInput field={def} value={value} onChange={setValue} id={inputId} autoFocus={!inline} invalid={Boolean(err)} />
        {def.help ? <p className="help">{def.help}</p> : null}
        {changing ? (
          <div>
            <label className="label" htmlFor={`${inputId}-why`}>Why it changed{reasonRequired ? "" : " (optional)"}</label>
            <input id={`${inputId}-why`} className="input small" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Kept in the record with the change" />
          </div>
        ) : null}
        {err ? <p className="error-text" role="alert">{err}</p> : null}
        {!inline ? (
          <div className="row">
            <button type="submit" className="btn small" disabled={Boolean(busy)}>Save</button>
            <button type="button" className="btn small quiet" onClick={() => setEditKey(undefined)}>Cancel</button>
          </div>
        ) : null}
      </div>
    </form>
  );
}

const CATEGORIES = ["venue", "av", "faculty-honoraria", "faculty-travel", "meals", "materials", "accreditation", "outcomes", "marketing", "management-fee", "other"];

function AddLine({ currency }: { currency: string }) {
  const { act, id, busy, setAddingLine } = useRequest();
  const [desc, setDesc] = useState("");
  const [cat, setCat] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string>();
  async function add(e: FormEvent) {
    e.preventDefault();
    const n = Number(amount);
    if (!desc.trim()) { setErr("Describe the line as it appears in your budget."); return; }
    if (!cat) { setErr("Choose a category; it decides which checks apply to the line."); return; }
    if (!Number.isFinite(n) || n <= 0) { setErr(`Enter the amount in ${currency}, for example 1500.`); return; }
    setErr(undefined);
    const ok = await act("add-line", () => api.post(`/api/requests/${id}/budget`, { addLine: { description: desc.trim(), category: cat, amount: n }, note: note.trim() || undefined }), "Line added");
    if (ok) setAddingLine(false);
  }
  return (
    <form className="panel calm" onSubmit={add} aria-labelledby="h-addline">
      <h3 id="h-addline">Add a budget line</h3>
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack" style={{ gap: 4, flex: "2 1 240px" }}><label className="label" htmlFor="al-desc">Description</label><input id="al-desc" className="input" value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus /></div>
        <div className="stack" style={{ gap: 4, flex: "1 1 160px" }}>
          <label className="label" htmlFor="al-cat">Category</label>
          <select id="al-cat" className="select" value={cat} onChange={(e) => setCat(e.target.value)}><option value="" disabled>Choose…</option>{CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select>
        </div>
        <div className="stack" style={{ gap: 4, flex: "1 1 120px" }}><label className="label" htmlFor="al-amt">Amount ({currency})</label><input id="al-amt" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /></div>
      </div>
      <div className="stack" style={{ gap: 4 }}><label className="label" htmlFor="al-note">Why it was missing (optional)</label><input id="al-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <div className="row"><button type="submit" className="btn small" disabled={Boolean(busy)}>Add the line</button><button type="button" className="btn small quiet" onClick={() => setAddingLine(false)}>Cancel</button></div>
    </form>
  );
}

function Budget() {
  const { view: v, editable, act, id, busy, openEvidence, addingLine, setAddingLine } = useRequest();
  const r = v.request;
  const currency = (r.fields["amount.currency"]?.value as string | undefined) ?? "USD";
  const flagged = flaggedLines(v.checks);
  const total = r.budget.reduce((s, l) => s + l.amount, 0);
  const requested = Number(r.fields["amount.requested"]?.value ?? NaN);
  const diff = Number.isFinite(requested) ? requested - total : 0;
  return (
    <div className="stack" style={{ gap: 8, marginTop: 18 }} id="budget">
      <h3>Itemized budget</h3>
      <div className="table-scroll">
        <table className="table">
          <thead><tr><th scope="col">Line</th><th scope="col">Description</th><th scope="col" className="hide-phone">Category</th><th scope="col" className="num">Amount</th><th scope="col" className="hide-phone"><span className="sr-only">Source</span></th></tr></thead>
          <tbody>
            {r.budget.map((l) => {
              const c = flagged.get(l.line);
              return (
                <tr key={l.line} className={c ? "flagged" : undefined}>
                  <td className="mono">{l.line}</td>
                  <td>
                    {l.description}
                    {c ? (
                      <div className="row" style={{ marginTop: 4 }}>
                        <span className="chip warn">{c.acknowledged ? "Kept · for the reviewer" : "Reads as hospitality"}</span>
                        {editable && !c.acknowledged ? (
                          <button type="button" className="btn small quiet" disabled={Boolean(busy)} onClick={() => void act(`remove-${l.line}`, () => api.post(`/api/requests/${id}/budget`, { removeLine: l.line }), `Line ${l.line} removed`)}>Remove line</button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="muted hide-phone">{humanize(l.category)}</td>
                  <td className="num">{fmtMoney(l.amount, currency)}</td>
                  <td className="hide-phone">{l.source?.documentId ? <button type="button" className="chip" onClick={() => openEvidence({ source: l.source!, title: `Budget line ${l.line}` })}>{sourceLabel(l.source)}</button> : null}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr><td /><td>Total</td><td className="hide-phone" /><td className="num">{fmtMoney(total, currency)}</td><td className="hide-phone" /></tr>
            {Number.isFinite(requested) && Math.abs(diff) > 0.5 ? (
              <tr><td /><td className="muted" style={{ fontWeight: 400 }}>Requested is {fmtMoney(Math.abs(diff), currency)} {diff > 0 ? "more" : "less"} than the budget</td><td className="hide-phone" /><td className="num" style={{ fontWeight: 400 }}>{fmtMoney(requested, currency)}</td><td className="hide-phone" /></tr>
            ) : null}
          </tfoot>
        </table>
      </div>
      {editable && addingLine ? <AddLine currency={currency} /> : editable ? <div><button type="button" className="btn small quiet" onClick={() => setAddingLine(true)}>Add a line</button></div> : null}
    </div>
  );
}

function Documents() {
  const { view: v, editable, pick, upload, openEvidence, busy } = useRequest();
  const present = new Map<string, DocumentEntry[]>();
  for (const d of v.documents) {
    for (const t of [d.type, ...d.covers]) present.set(t, [...(present.get(t) ?? []), d]);
  }
  const missing = new Set(v.progress.missingDocs);
  const reqs = v.documentRequirements.filter((d) => d.type !== "other" && (d.required || missing.has(d.type) || present.has(d.type)));
  const others = v.documents.filter((d) => !reqs.some((r) => r.type === d.type));
  return (
    <section className="doc-section" aria-labelledby="h-docs" id="documents">
      <h2 id="h-docs">Documents</h2>
      {reqs.map((req) => {
        const docs = present.get(req.type) ?? [];
        const isMissing = !docs.length;
        return (
          <div className="frow" key={req.type} id={`docreq-${req.type}`}>
            <span className="lbl">{shortDocLabel(req.label)}</span>
            <span className="val">
              {isMissing ? (
                <span className="stack" style={{ gap: 2 }}>
                  <span className="unanswered">{missing.has(req.type) || req.required ? "Missing" : "Not needed for this request"}</span>
                  {req.help ? <span className="help">{req.help}</span> : null}
                </span>
              ) : docs.map((d) => (
                <span key={d.id} className="stack" style={{ gap: 2 }}>
                  <button type="button" className="linkbtn" style={{ textAlign: "left", overflowWrap: "anywhere" }} onClick={() => openEvidence({ source: { kind: "document", documentId: d.id, documentName: d.name, page: d.type === req.type ? 1 : undefined }, title: shortDocLabel(req.label) })}>{d.name}</button>
                  <span className="help">
                    {d.type !== req.type ? `Also covers this (the main file is the ${shortDocLabel(docLabel(d.type, v)).toLowerCase()})` : [d.pages ? plural(d.pages, "page") : "", d.classifiedBy === "assistant" ? "type recognised by the assistant" : "", d.fromPassport ? "from your profile" : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
              ))}
            </span>
            <span className="side">
              {isMissing ? <span className={`chip ${missing.has(req.type) ? "block" : ""}`}>{missing.has(req.type) ? "Missing" : "Optional"}</span> : docs.some((d) => d.type !== req.type) && !docs.some((d) => d.type === req.type) ? <span className="chip ok">Also covered</span> : <span className="chip ok">Present</span>}
            </span>
            {editable && isMissing ? (
              <div className="inline-actions">
                <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => pick(req.type, acceptFor(req.accept))}>Upload</button>
              </div>
            ) : null}
            {!isMissing && docs.some((d) => d.covers.length && d.type === req.type) ? (
              <div className="inline-actions">
                <span className="help">Also covers:</span>
                {docs.flatMap((d) => d.covers).map((c) => <span key={c} className="chip">{shortDocLabel(docLabel(c, v))}</span>)}
              </div>
            ) : null}
          </div>
        );
      })}
      {others.map((d) => (
        <div className="frow" key={d.id}>
          <span className="lbl">{shortDocLabel(docLabel(d.type, v))}</span>
          <span className="val"><button type="button" className="linkbtn" onClick={() => openEvidence({ source: { kind: "document", documentId: d.id, documentName: d.name, page: 1 } })}>{d.name}</button></span>
          <span className="side"><span className="chip">Added</span></span>
        </div>
      ))}
      {editable ? (
        <div className="row" style={{ marginTop: 12 }}>
          <FilePick className="btn small quiet" label="Add a document" multiple onFiles={(f) => void upload(f)} disabled={Boolean(busy)} />
          <span className="help">The assistant recognises the type and counts it against what's needed.</span>
        </div>
      ) : null}
    </section>
  );
}

function Statements() {
  const { me } = useMe();
  const { view: v } = useRequest();
  const fe = assistantName(me);
  const atts = (v.subtype?.attestations ?? []).map((aid) => v.catalogue.attestations.find((a) => a.id === aid)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  return (
    <section className="doc-section" aria-labelledby="h-statements" id="statements">
      <h2 id="h-statements">Your statements</h2>
      <p className="section-note">Typed or ticked by you, recorded with your name and the time. {fe} cannot make these for you.</p>
      <Coi />
      {atts.map((a) => <Attestation key={a.id} att={a} />)}
    </section>
  );
}

function Coi() {
  const { view: v, editable, act, id, busy } = useRequest();
  const qs = (v.subtype?.coi ?? []).map((qid) => v.catalogue.coiQuestions.find((q) => q.id === qid)).filter((q): q is NonNullable<typeof q> => Boolean(q));
  const answers = v.request.coi;
  const [redo, setRedo] = useState<string>();
  const current = redo ? qs.find((q) => q.id === redo) : qs.find((q) => !answers[q.id]);
  const done = qs.filter((q) => answers[q.id]).length;
  const [yes, setYes] = useState(false);
  const [detail, setDetail] = useState("");
  const [err, setErr] = useState<string>();
  const [showAnswers, setShowAnswers] = useState(false);
  useEffect(() => { setYes(false); setDetail(""); setErr(undefined); }, [current?.id]);
  if (!qs.length) return null;

  const answer = async (a: "yes" | "no") => {
    if (!current) return;
    if (a === "yes" && !detail.trim()) { setErr("Give the details of a yes in your own words. A yes doesn't stop your request; a compliance reviewer looks at it."); return; }
    const ok = await act(`coi:${current.id}`, () => api.post(`/api/requests/${id}/coi`, { questionId: current.id, answer: a, detail: a === "yes" ? detail.trim() : undefined }));
    if (ok) setRedo(undefined);
  };

  return (
    <div className="statement" id="coi">
      <div className="section-head">
        <h3>Conflict of interest</h3>
        <span className={`chip ${done === qs.length ? "ok" : "warn"}`}>{done} of {qs.length} answered</span>
      </div>
      {current && editable ? (
        <div className="stack" style={{ gap: 10 }}>
          <span className="eyebrow">Question {qs.indexOf(current) + 1} of {qs.length}</span>
          <p className="coi-q" id="coi-q">{current.text}</p>
          {current.help ? <p className="help">{current.help}</p> : null}
          {!yes ? (
            <div className="row" role="group" aria-labelledby="coi-q">
              <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void answer("no")}>No</button>
              <button type="button" className="btn small quiet" disabled={Boolean(busy)} onClick={() => setYes(true)}>Yes</button>
              {redo ? <button type="button" className="linkbtn muted small" onClick={() => setRedo(undefined)}>Keep my earlier answer</button> : null}
            </div>
          ) : (
            <form className="stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void answer("yes"); }}>
              {current.ifYes ? <p className="help">{current.ifYes}</p> : null}
              <label className="label" htmlFor="coi-yes">Details, in your own words</label>
              <textarea id="coi-yes" className="textarea" rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} autoFocus aria-invalid={Boolean(err) || undefined} />
              {err ? <p className="error-text" role="alert">{err}</p> : null}
              <div className="row"><button type="submit" className="btn small" disabled={Boolean(busy)}>Answer yes with these details</button><button type="button" className="btn small quiet" onClick={() => setYes(false)}>Back</button></div>
            </form>
          )}
        </div>
      ) : null}
      {done ? (
        <div>
          <button type="button" className="linkbtn small" aria-expanded={showAnswers} onClick={() => setShowAnswers((s) => !s)}>{showAnswers ? "Hide your answers" : `Show your ${plural(done, "answer")}`}</button>
          {showAnswers ? (
            <ul className="coi-answers" style={{ marginTop: 8 }}>
              {qs.filter((q) => answers[q.id]).map((q) => {
                const a = answers[q.id]!;
                return (
                  <li key={q.id}>
                    <span className="mono muted">{qs.indexOf(q) + 1}</span>
                    <span>{q.text}<br /><strong>{a.answer === "yes" ? "Yes" : "No"}</strong>{a.detail ? ` · "${a.detail}"` : ""} <span className="muted tiny">· {a.by.name}, {fmtWhen(a.at)}</span></span>
                    {editable ? <button type="button" className="linkbtn small" onClick={() => setRedo(q.id)}>Change</button> : <span />}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Attestation({ att }: { att: { id: string; label: string; text: string; mode: "type" | "tick"; version: string } }) {
  const { me } = useMe();
  const { view: v, editable, act, id, busy } = useRequest();
  const made = v.request.attestations[att.id];
  const [name, setName] = useState("");
  const [err, setErr] = useState<string>();
  const [ticked, setTicked] = useState(false);
  const inputId = `att-in-${att.id}`;

  async function make(e?: FormEvent) {
    e?.preventDefault();
    if (att.mode === "type" && name.trim().toLowerCase() !== me.user.name.trim().toLowerCase()) {
      setErr(`Type your full name exactly as "${me.user.name}" to make this statement.`);
      return;
    }
    setErr(undefined);
    const ok = await act(`att:${att.id}`, () => api.post(`/api/requests/${id}/attestations`, { attestationId: att.id, typedName: att.mode === "type" ? name.trim() : undefined }), "Statement recorded");
    if (!ok) setTicked(false);
  }

  return (
    <div className="statement" id={`att-${att.id}`}>
      <div className="section-head"><h3>{att.label}</h3>{made ? <span className="chip ok">Made</span> : null}</div>
      <blockquote className="statement-text">{made?.text ?? att.text}</blockquote>
      {made ? (
        <p className="made">{made.typedName ? `Typed "${made.typedName}"` : "Ticked"} by {made.by.name} · {fmtDate(made.at)} {fmtTime(made.at)} · wording version {made.version}</p>
      ) : editable ? (
        att.mode === "type" ? (
          <form className="sign-row" onSubmit={make}>
            <div className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
              <label className="label" htmlFor={inputId}>Type your full name to make this statement</label>
              <input id={inputId} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={me.user.name} autoComplete="off" spellCheck={false} aria-invalid={Boolean(err) || undefined} aria-describedby={err ? `${inputId}-err` : undefined} />
            </div>
            <button type="submit" className="btn" disabled={Boolean(busy)}>Make statement</button>
            {err ? <p id={`${inputId}-err`} className="error-text" role="alert" style={{ flexBasis: "100%" }}>{err}</p> : null}
          </form>
        ) : (
          <label className="check">
            <input type="checkbox" checked={ticked} disabled={Boolean(busy) || ticked} onChange={() => { setTicked(true); void make(); }} />
            <span>I make this statement on behalf of {v.organization.legalName}.</span>
          </label>
        )
      ) : <p className="muted small">Not made.</p>}
    </div>
  );
}


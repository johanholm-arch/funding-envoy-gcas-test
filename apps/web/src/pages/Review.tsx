import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, errorText } from "../lib/api";
import { useMe, useToast } from "../lib/app";
import { fieldValueText, fmtDate, fmtMoney, fmtTime, plural, roleWords, sourceLabel } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import { docLabel, labelize, shortDocLabel } from "../lib/request";
import type { Preview } from "../lib/types";

export function Review() {
  const { id = "" } = useParams();
  const { me } = useMe();
  const toast = useToast();
  const p = useResource<Preview>(`/api/requests/${id}/preview`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ ref: string; at: Date }>();
  useDocumentTitle(done ? "Submitted" : "Review and submit");
  const funder = me.tenant?.name ?? "the funder";

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<{ ref: string }>(`/api/requests/${id}/submit`);
      setDone({ ref: r.ref, at: new Date() });
      toast("Submitted");
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof ApiError && e.code === "not-ready" ? `Not sent. ${e.message}` : errorText(e));
      await p.refetch();
    } finally {
      setBusy(false);
    }
  }

  if (p.error && !p.data) return <div className="page narrow"><h1>Review didn't open</h1><p className="lede">{p.error.message} <Link to={`/requests/${id}`}>Back to the request</Link></p></div>;
  const v = p.data;
  if (!v) return <div className="page narrow"><p className="muted small">Preparing exactly what will be sent…</p></div>;
  const title = (v.request.fields.title?.value as string | undefined) ?? "Untitled request";
  const currency = (v.request.fields["amount.currency"]?.value as string | undefined) ?? "USD";

  if (done) {
    return (
      <div className="page narrow">
        <div className="page-head">
          <span className="eyebrow">Submitted · {fmtDate(done.at)} {fmtTime(done.at)}</span>
          <h1>Submitted to {funder}</h1>
          <p className="lede">"{title}" was sent in your name as <strong className="mono">{done.ref}</strong>. Keep the reference for any correspondence.</p>
        </div>
        <WhatNext v={v} />
        <div className="row"><Link to={`/requests/${id}`} className="btn">Open the request</Link><Link to="/requests" className="btn quiet">Back to my requests</Link></div>
      </div>
    );
  }

  if (v.request.status !== "draft" && v.request.status !== "info-requested") {
    return <div className="page narrow"><h1>Already submitted</h1><p className="lede">This request was submitted as {v.request.ref}. <Link to={`/requests/${id}`}>Open it</Link>.</p></div>;
  }

  const sections = v.sections.filter((s) => s.id !== "internal");
  const atts = v.subtype?.attestations ?? [];
  const coiDone = Object.values(v.request.coi);
  return (
    <div className="page narrow">
      <div className="page-head">
        <span className="eyebrow">Review and submit · {v.organization.legalName}</span>
        <h1>{title}</h1>
        <p className="lede">This is exactly what will be written to {funder}'s grants system, in your name. Nothing has been sent yet.</p>
      </div>

      {!v.canSubmit ? (
        <section className="panel" aria-labelledby="h-block" style={{ borderColor: "var(--block)" }}>
          <h2 id="h-block">Before you can submit</h2>
          <ul className="stack" style={{ gap: 8, paddingLeft: 18 }}>
            {v.blockers.map((b) => (
              <li key={b.ruleId}>{labelize(b.text, v)} <Link to={`/requests/${id}${b.ruleId === "proposed" ? "" : `#note-${b.ruleId}`}`}>Fix in the request</Link></li>
            ))}
          </ul>
        </section>
      ) : null}

      {sections.map((s) => (
        <section key={s.id} className="doc-section" aria-labelledby={`r-${s.id}`}>
          <h2 id={`r-${s.id}`}>{s.label}</h2>
          {s.fields.filter((f) => f.current && f.current.value !== "" && f.current.value !== undefined).map((f) => (
            <div key={f.key} className="frow">
              <span className="lbl">{f.label}</span>
              <span className="val">{fieldValueText(f, f.current!.value, currency)}</span>
              <span className="side"><span className="chip">{sourceLabel(f.current!.source, (d) => v.documents.find((x) => x.id === d)?.type)}</span></span>
            </div>
          ))}
          {s.id === "funding" && v.request.budget.length ? (
            <div className="frow"><span className="lbl">Itemized budget</span><span className="val"><span className="mono">{fmtMoney(v.request.budget.reduce((a, l) => a + l.amount, 0), currency)}</span> · {plural(v.request.budget.length, "line")}</span><span className="side" /></div>
          ) : null}
        </section>
      ))}

      <section className="doc-section" aria-labelledby="r-docs">
        <h2 id="r-docs">Documents</h2>
        {v.documents.map((d) => (
          <div key={d.id} className="frow"><span className="lbl">{shortDocLabel(docLabel(d.type, v))}</span><span className="val">{d.name}{d.covers.length ? <span className="was"> · also covers {d.covers.map((c) => shortDocLabel(docLabel(c, v)).toLowerCase()).join(", ")}</span> : null}</span><span className="side" /></div>
        ))}
      </section>

      <section className="doc-section" aria-labelledby="r-st">
        <h2 id="r-st">Your statements</h2>
        <div className="frow"><span className="lbl">Conflict of interest</span><span className="val">{coiDone.length} of {v.subtype?.coi.length ?? 0} answered{coiDone.length ? `; ${coiDone.filter((a) => a.answer === "yes").length ? `${coiDone.filter((a) => a.answer === "yes").length} yes, with your details` : "all no"}` : ""}</span><span className="side" /></div>
        {atts.map((aid) => {
          const made = v.request.attestations[aid];
          const def = v.catalogue.attestations.find((a) => a.id === aid);
          return (
            <div key={aid} className="statement">
              <strong>{def?.label}</strong>
              <blockquote className="statement-text">{made?.text ?? def?.text}</blockquote>
              <p className={made ? "made" : "error-text"}>{made ? `${made.typedName ? `Typed "${made.typedName}"` : "Ticked"} by ${made.by.name} · ${fmtDate(made.at)} ${fmtTime(made.at)}` : "Not made yet"}</p>
            </div>
          );
        })}
      </section>

      {v.flagsForReviewer.length ? (
        <section className="doc-section" aria-labelledby="r-flags">
          <h2 id="r-flags">Flags the reviewer will see</h2>
          {v.flagsForReviewer.map((f) => (
            <div key={f.ruleId} className="note warn" style={{ margin: "10px 0" }}>
              <p>{labelize(f.text, v)}</p>
              {f.note ? <p className="note-body">Your note: "{f.note}"</p> : null}
            </div>
          ))}
        </section>
      ) : null}

      <WhatNext v={v} />

      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="row" style={{ borderTop: "1px solid var(--ink)", paddingTop: 20 }}>
        <button type="button" className="btn" disabled={!v.canSubmit || busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Submit request"}</button>
        <Link to={`/requests/${id}`} className="btn quiet">Back to the request</Link>
        <span className="muted small">Submitting writes this to {funder}'s record as {me.user.name}, {me.organization?.name}.</span>
      </div>
    </div>
  );
}

function WhatNext({ v }: { v: Preview }) {
  if (!v.whatHappensNext.length) return null;
  const weeks = v.subtype?.typicalDecisionWeeks;
  return (
    <section className="doc-section" aria-labelledby="r-next">
      <h2 id="r-next">What happens next</h2>
      {weeks ? <p className="section-note">Decisions for this type usually take {weeks[0]} to {weeks[1]} weeks after a complete submission. Nothing here predicts the outcome.</p> : null}
      <ol className="stack" style={{ gap: 0 }}>
        {v.whatHappensNext.map((s, i) => (
          <li key={s.id} className="frow steps" style={{ listStyle: "none" }}>
            <span className="lbl mono">{i + 1}</span>
            <span className="val">{s.name}<span className="was"> · {s.owner.map(roleWords).join(" or ").toLowerCase()}</span></span>
            <span className="side">{s.slaBusinessDays ? <span className="chip">{s.slaBusinessDays === 1 ? "within a working day" : `about ${s.slaBusinessDays} working days`}</span> : null}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

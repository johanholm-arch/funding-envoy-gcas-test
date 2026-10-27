import { useState, type FormEvent } from "react";
import { useMediaQuery } from "../lib/hooks";
import { api } from "../lib/api";
import { firstSentence, fmtWhen, plural } from "../lib/format";
import { isStatementCheck, labelize, supportedHint } from "../lib/request";
import type { CheckResult } from "../lib/types";
import { useRequest } from "./requestCtx";

/** Checks as margin notes: must fix → your call → for a reviewer → passed (collapsed). */
export function MarginNotes() {
  const { view: v, editable, requestor } = useRequest();
  const s = v.summary;
  const [showPassed, setShowPassed] = useState(false);
  const phone = useMediaQuery("(max-width: 899px)");
  const [showAll, setShowAll] = useState(false);
  if (!v.request.typeConfirmed && !v.subtype) return null;
  const statements = s.mustFix.filter(isStatementCheck);
  const mustFix = s.mustFix.filter((c) => !isStatementCheck(c));
  const lbl = (t: string) => labelize(t, v);
  // On a phone, lead with the first few open points; the rest are one tap away.
  const cap = phone && !showAll ? 3 : Infinity;
  const openCount = mustFix.length + (statements.length ? 1 : 0) + s.yourCall.length + s.forReviewer.length;
  let shown = 0;
  const take = () => shown++ < cap;

  return (
    <aside className="margin" aria-label="Checks">
      <span className="eyebrow">{editable ? "In the margin · checks run on every change" : "Checks at submission"}</span>
      {mustFix.map((c) => take() && <Note key={c.ruleId} c={c} tone="block" chip="Must fix" lbl={lbl} />)}
      {statements.length && take() ? (
        <div className="note block">
          <div className="note-title"><span>{plural(statements.length, "statement")} still to make</span><span className="chip block">Must fix</span></div>
          <p className="note-body">{statements.map((c) => c.statement.replace(/^(The requestor confirms|For education, the requestor confirms) /, "").replace(/ (made|acknowledged)$/, "")).join(" · ")}. Yours to make, typed or ticked.</p>
          <p className="note-basis">{statements.map((c) => c.basis.ref).filter((x, i, a) => a.indexOf(x) === i).join(" · ")}</p>
          {editable && requestor ? <StatementsButton /> : null}
        </div>
      ) : null}
      {s.yourCall.map((c) => take() && <Note key={c.ruleId} c={c} tone="warn" chip="Your call" lbl={lbl} />)}
      {s.forReviewer.map((c) => take() && <Note key={c.ruleId} c={c} tone="judge" chip="For a reviewer" lbl={lbl} />)}
      {openCount > cap ? <div><button type="button" className="btn small quiet" onClick={() => setShowAll(true)}>Show all {openCount} open points</button></div> : null}
      {s.passed.length ? (
        <div className="note ok" id="passed">
          <div className="note-title"><span>{plural(s.passed.length, "check")} passed</span><span className="chip ok">Passed</span></div>
          {!showPassed ? (
            <p className="note-body">{s.passed.slice(0, 4).map((c) => firstSentence(lbl(c.message))[0]).join(" · ")}{s.passed.length > 4 ? " · …" : ""}</p>
          ) : (
            <ul className="passed-list">
              {s.passed.map((c) => (
                <li key={c.ruleId}><span>{lbl(c.message)}</span><span className="note-basis">{c.basis.ref}</span></li>
              ))}
            </ul>
          )}
          <div><button type="button" className="linkbtn small" aria-expanded={showPassed} onClick={() => setShowPassed((x) => !x)}>{showPassed ? "Show fewer" : "Show each with its evidence"}</button></div>
        </div>
      ) : null}
    </aside>
  );
}

function StatementsButton() {
  const { goTo } = useRequest();
  return <div className="note-actions"><button type="button" className="btn small" onClick={() => goTo("statements")}>Go to your statements</button></div>;
}

function Note({ c, tone, chip, lbl }: { c: CheckResult; tone: "block" | "warn" | "judge"; chip: string; lbl: (t: string) => string }) {
  const { editable, requestor, runHint, act, id, busy, openEvidence } = useRequest();
  const [explain, setExplain] = useState<"submit-with-flag" | "keep-and-explain">();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string>();
  const [title, rest] = firstSentence(lbl(c.message));
  const body = c.requestorMessage && requestor ? lbl(c.requestorMessage) : lbl(rest);
  const hints = c.actions.filter((h) => supportedHint(h, requestor));
  const ack = c.acknowledged;
  const docEvidence = c.evidence.find((e) => e.source?.documentId);

  async function flag(e: FormEvent) {
    e.preventDefault();
    if (explain === "keep-and-explain" && !note.trim()) { setErr("Explain why the line belongs in the activity. The reviewer reads your words."); return; }
    setErr(undefined);
    const ok = await act(`flag:${c.ruleId}`, () => api.post(`/api/requests/${id}/flags`, { ruleId: c.ruleId, choice: explain, note: note.trim() || undefined }), "Flagged for the reviewer");
    if (ok) setExplain(undefined);
  }

  return (
    <div className={`note ${tone}`} id={`note-${c.ruleId}`}>
      <div className="note-title"><span>{title}</span><span className={`chip ${tone === "judge" ? "" : tone}`}>{ack ? "Flagged" : chip}</span></div>
      {body && body !== title ? <p className="note-body">{body}</p> : null}
      <p className="note-basis">
        {c.basis.ref}{c.basis.citation ? <span className="sr-only">: {c.basis.citation}</span> : null}
        {docEvidence?.source ? <> · <button type="button" className="evlink" style={{ fontSize: 11.5 }} onClick={() => openEvidence({ source: docEvidence.source!, title: c.statement })}>{docEvidence.label}</button></> : null}
      </p>
      {ack ? (
        <p className="note-done">
          {ack.choice === "keep-and-explain" ? "Kept with your explanation" : "You chose to submit with this flagged"}{ack.note ? `: "${ack.note}"` : ""} · {ack.by.name}, {fmtWhen(ack.at)}
        </p>
      ) : null}
      {editable && !ack && hints.length && !explain ? (
        <div className="note-actions">
          {[...hints].sort((a, b) => Number(a.id.startsWith("change:")) - Number(b.id.startsWith("change:"))).map((h, i) => {
            const primary = tone === "block" && i === 0 && !h.id.startsWith("change:");
            const onClick = () => {
              if (h.id === "submit-with-flag" || h.id === "keep-and-explain") { setExplain(h.id); return; }
              runHint(h, c);
            };
            return <button key={h.id} type="button" className={`btn small ${primary ? "" : "quiet"}`} disabled={Boolean(busy)} onClick={onClick}>{h.label}</button>;
          })}
        </div>
      ) : null}
      {explain ? (
        <form className="stack" style={{ gap: 6 }} onSubmit={flag}>
          <label className="label" htmlFor={`flag-${c.ruleId}`}>{explain === "keep-and-explain" ? "Your explanation for the reviewer" : "A note for the reviewer (optional)"}</label>
          <textarea id={`flag-${c.ruleId}`} className="textarea" rows={2} style={{ minHeight: 64 }} value={note} onChange={(e) => setNote(e.target.value)} autoFocus aria-invalid={Boolean(err) || undefined} />
          {err ? <p className="error-text" role="alert">{err}</p> : null}
          <div className="row">
            <button type="submit" className="btn small" disabled={Boolean(busy)}>{explain === "keep-and-explain" ? "Keep the line" : "Submit with the flag"}</button>
            <button type="button" className="btn small quiet" onClick={() => setExplain(undefined)}>Cancel</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

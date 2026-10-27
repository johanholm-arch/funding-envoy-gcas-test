import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { assistantName, hasRole, useMe, useToast } from "../lib/app";
import { fmtDate, fmtMoney, fmtTime, fmtWhen, plural } from "../lib/format";
import { useResource } from "../lib/hooks";
import { countryName, docLabel, labelize, shortDocLabel } from "../lib/request";
import type { Brief as BriefData, CheckResult, Evidence, JudgementItem } from "../lib/types";
import type { EvidenceTarget } from "./EvidencePane";

export interface BriefHandle {
  focusAccept: () => void;
  focusDecline: () => void;
  openInfo: () => void;
  openFirstEvidence: () => void;
}

interface Props {
  id: string;
  onEvidence: (t: EvidenceTarget) => void;
  onChanged?: () => void;
  /** Extra content placed after the recommendation, e.g. the committee's decision form. */
  children?: (b: BriefData, refetch: () => Promise<unknown>) => ReactNode;
  mode?: "desk" | "committee";
}

export const Brief = forwardRef<BriefHandle, Props>(function Brief({ id, onEvidence, onChanged, children, mode = "desk" }, ref) {
  const { me } = useMe();
  const toast = useToast();
  const b = useResource<BriefData>(`/api/requests/${id}/brief`);
  const [busy, setBusy] = useState<string>();
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoSeed, setInfoSeed] = useState<string>();
  const acceptRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [declineArmed, setDeclineArmed] = useState(false);
  const fe = assistantName(me);

  useEffect(() => { setInfoOpen(false); setInfoSeed(undefined); setDeclineArmed(false); }, [id]);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
    setBusy(key);
    try {
      await fn();
      await b.refetch();
      onChanged?.();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  const d = b.data;
  useImperativeHandle(ref, () => ({
    focusAccept: () => { acceptRef.current?.scrollIntoView({ block: "center" }); acceptRef.current?.focus(); },
    focusDecline: () => { setDeclineArmed(true); window.setTimeout(() => { reasonRef.current?.scrollIntoView({ block: "center" }); reasonRef.current?.focus(); }, 0); },
    openInfo: () => { setInfoOpen(true); window.setTimeout(() => document.getElementById("info-q-0")?.focus(), 0); },
    openFirstEvidence: () => {
      const c = d?.checks.find((x) => x.evidence.some((e) => e.source?.documentId));
      const e = c?.evidence.find((x) => x.source?.documentId);
      if (c && e?.source) onEvidence({ source: e.source, title: c.statement });
    },
  }), [d, onEvidence]);

  if (b.error && !d) return <div className="brief-inner"><h1>The brief didn't open</h1><p className="lede">{b.error.message}</p></div>;
  if (!d) return <div className="brief-inner" aria-busy="true"><p className="muted small">Opening the brief…</p></div>;

  const r = d.request;
  const title = (r.fields.title?.value as string | undefined) ?? r.title ?? "Untitled request";
  const currency = (r.fields["amount.currency"]?.value as string | undefined) ?? "USD";
  const requestorName = d.submittedBy ?? d.requestor?.name;
  const submittedAt = d.submittedAt ?? r.submittedAt;
  const start = r.fields["activity.startDate"]?.value, end = r.fields["activity.endDate"]?.value;
  const where = r.fields["activity.location"]?.value;
  const open = d.judgement.filter((j) => !j.decided);
  const canInfo = hasRole(me, "coordinator", "medical-reviewer", "compliance-reviewer") && !["closed", "declined", "withdrawn"].includes(r.status);
  const openInfo = d.infoRequests.find((i) => i.status === "open");

  return (
    <div className="brief-inner">
      <header className="stack" style={{ gap: 8 }}>
        <span className="eyebrow">{r.ref} · {d.stage.name}{submittedAt ? ` · submitted ${fmtDate(submittedAt)} ${fmtTime(submittedAt)}` : ""}{requestorName ? ` by ${requestorName}` : ""}</span>
        <h1 style={{ fontSize: 36 }}>{title}</h1>
        <p className="muted">
          {[d.organization.legalName, d.subtype?.name, countryName(r.country), where ? String(where) : undefined, start ? `${fmtDate(String(start).slice(0, 10))}${end && end !== start ? ` to ${fmtDate(String(end).slice(0, 10))}` : ""}` : undefined].filter(Boolean).join(" · ")}
          {" · "}<span className="mono" style={{ color: "var(--ink)" }}>{fmtMoney(r.fields["amount.requested"]?.value, currency)}</span>
        </p>
        <p className="small"><Link to={`/requests/${id}`}>Open the request as the requestor sees it</Link></p>
        {r.decision ? <p className="status-line">Decision: {r.decision.outcome.replace(/-/g, " ")} by {r.decision.by.name}, {fmtDate(r.decision.at)}. "{r.decision.rationale}"</p> : null}
      </header>

      {(["reconciliation.report", "outcomes.report"] as const).map((k) => {
        const rep = r.fields[k]?.value as { actualTotal: number; unusedFunds: number; attendees?: number; notes?: string; outcomesSummary?: string; by: { name: string }; at: string } | undefined;
        if (!rep) return null;
        return (
          <section key={k} className="panel calm" aria-label={k === "outcomes.report" ? "Outcomes report" : "Reconciliation"}>
            <span className="eyebrow">{k === "outcomes.report" ? "Outcomes report" : "Reconciliation"} · from {rep.by.name}, {fmtDate(rep.at)}</span>
            <p>Spent <span className="mono">{fmtMoney(rep.actualTotal, currency)}</span> of <span className="mono">{fmtMoney(r.decision?.amount ?? r.fields["amount.requested"]?.value, currency)}</span>{rep.unusedFunds ? <> · <span className="mono">{fmtMoney(rep.unusedFunds, currency)}</span> unused</> : null}{rep.attendees ? ` · ${rep.attendees} attended` : ""}.</p>
            {rep.notes ? <p className="small">"{rep.notes}"</p> : null}
            {rep.outcomesSummary ? <p className="small">"{rep.outcomesSummary}"</p> : null}
          </section>
        );
      })}

      {openInfo ? (
        <section className="panel calm" aria-label="Open information request">
          <span className="eyebrow">Waiting on the requestor · asked {fmtDate(openInfo.at)}{openInfo.dueAt ? ` · due ${fmtDate(openInfo.dueAt)}` : ""}</span>
          <ol className="stack" style={{ gap: 4, paddingLeft: 18 }}>{openInfo.questions.map((q) => <li key={q.id}>{q.text}{q.answer ? <span className="muted"> · answered: {q.answer}</span> : null}</li>)}</ol>
        </section>
      ) : null}

      {d.judgement.length ? (
        <section className="stack" style={{ gap: 12 }} aria-labelledby="h-judge">
          <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
            <h2 id="h-judge" style={{ fontSize: 24 }}>For your judgement</h2>
            {open.length ? <span className="chip you">{open.length}</span> : <span className="chip ok">All judged</span>}
          </div>
          <div className="jcards">
            {d.judgement.map((j) => (
              <JudgementCard key={j.ruleId} j={j} busy={busy} onEvidence={onEvidence} labelize={(t) => labelize(t, d)}
                onDecide={async (decision, note) => {
                  const ok = await run(`j:${j.ruleId}`, () => api.post(`/api/requests/${id}/judgements`, { ruleId: j.ruleId, decision, note: note || undefined }), "Judgement recorded");
                  if (ok && decision === "ask-requestor") { setInfoSeed(`${j.title}: `); setInfoOpen(true); window.setTimeout(() => document.getElementById("info-q-0")?.focus(), 50); }
                  return ok;
                }} />
            ))}
          </div>
        </section>
      ) : null}

      <Recommendation d={d} mode={mode} busy={busy} run={run} acceptRef={acceptRef} reasonRef={reasonRef} declineArmed={declineArmed} setDeclineArmed={setDeclineArmed} fe={fe} />

      {children?.(d, b.refetch)}

      {canInfo && !openInfo ? (
        infoOpen ? <InfoComposer id={id} seed={infoSeed} busy={busy} run={run} onClose={() => setInfoOpen(false)} /> : (
          <div><button type="button" className="btn small quiet" onClick={() => { setInfoOpen(true); window.setTimeout(() => document.getElementById("info-q-0")?.focus(), 0); }}>Request information from the requestor</button></div>
        )
      ) : null}

      <Checks d={d} onEvidence={onEvidence} />

      {d.documents.length ? (
        <section className="stack" style={{ gap: 6 }} aria-labelledby="h-bdocs">
          <h2 id="h-bdocs" style={{ fontSize: 20 }}>Documents</h2>
          <div className="stack">
            {d.documents.map((doc) => (
              <div key={doc.id} className="crow" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1.6fr)" }}>
                <span>{shortDocLabel(docLabel(doc.type, d))}{doc.covers.length ? <span className="muted"> · also {doc.covers.map((c) => shortDocLabel(docLabel(c, d)).toLowerCase()).join(", ")}</span> : null}</span>
                <span className="r"><button type="button" className="evlink" onClick={() => onEvidence({ source: { kind: "document", documentId: doc.id, documentName: doc.name, page: 1 } })}>{doc.name}{doc.pages ? ` · ${plural(doc.pages, "page")}` : ""}</button></span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {d.infoRequests.filter((i) => i.status !== "open").map((i) => (
        <section key={i.id} className="stack" style={{ gap: 6 }}>
          <h2 style={{ fontSize: 20 }}>Information request of {fmtDate(i.at)}</h2>
          <p className="muted small">Asked by {i.by.name}. What changed, written by {fe} and reviewed by the requestor:</p>
          <p className="pre small">{i.whatChanged}</p>
        </section>
      ))}

      <section className="stack" style={{ gap: 6 }} aria-labelledby="h-did">
        <h2 id="h-did" style={{ fontSize: 20 }}>What {fe} did on this request</h2>
        <p className="muted small">
          Proposed {plural(d.assistantActivity.proposedFields, "value")} from documents{d.assistantActivity.proposedFields ? " (each confirmed by the requestor)" : ""} · recognised {plural(d.assistantActivity.documentsClassified, "document")} · ran {plural(d.summaryCounts.total, "check")} · {plural(d.assistantActivity.actions, "recorded action")} in all. Nothing was decided by {fe}.{" "}
          <Link to={`/audit/${id}`}>Full trail</Link>
        </p>
        <p className="hash">{me.assistant.label}</p>
      </section>
    </div>
  );
});

function JudgementCard({ j, busy, onDecide, onEvidence, labelize }: { j: JudgementItem; busy?: string; onDecide: (decision: string, note: string) => Promise<boolean>; onEvidence: (t: EvidenceTarget) => void; labelize: (t: string) => string }) {
  const [note, setNote] = useState("");
  const [redo, setRedo] = useState(false);
  const decided = j.decided && !redo;
  const ev = j.evidence.find((e) => e.source?.documentId);
  return (
    <div className={`jcard ${decided ? "done" : ""}`}>
      <strong>{j.title}</strong>
      <p className="muted small">{labelize(j.text)}</p>
      <p className="note-basis">{j.basis.ref}{ev?.source ? <> · <button type="button" className="evlink" style={{ fontSize: 11.5 }} onClick={() => onEvidence({ source: ev.source!, title: j.title })}>{ev.label}{ev.value ? `: ${ev.value}` : ""}</button></> : j.evidence[0] ? ` · ${j.evidence[0].label}${j.evidence[0].value ? `: ${j.evidence[0].value}` : ""}` : ""}</p>
      {decided ? (
        <div className="stack" style={{ gap: 4 }}>
          <p className="small"><span className="chip ok">{j.options.find((o) => o.id === j.decided!.decision)?.label ?? j.decided!.decision}</span> {j.decided!.by.name}, {fmtWhen(j.decided!.at)}</p>
          {j.decided!.note ? <p className="small">"{j.decided!.note}"</p> : null}
          <div><button type="button" className="linkbtn small" onClick={() => setRedo(true)}>Change</button></div>
        </div>
      ) : (
        <>
          <label className="sr-only" htmlFor={`jn-${j.ruleId}`}>Note for {j.title}</label>
          <textarea id={`jn-${j.ruleId}`} className="textarea" rows={2} style={{ minHeight: 56 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Condition or note · recorded with your name" />
          <div className="row">
            {j.options.map((o, i) => (
              <button key={o.id} type="button" className={`btn small ${i === 0 ? "" : "quiet"}`} disabled={Boolean(busy)} onClick={() => void onDecide(o.id, note.trim()).then((ok) => { if (ok) { setRedo(false); setNote(""); } })}>{o.label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Recommendation({ d, mode, busy, run, acceptRef, reasonRef, declineArmed, setDeclineArmed, fe }: {
  d: BriefData; mode: "desk" | "committee"; busy?: string; run: (k: string, fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  acceptRef: React.RefObject<HTMLButtonElement | null>; reasonRef: React.RefObject<HTMLTextAreaElement | null>; declineArmed: boolean; setDeclineArmed: (b: boolean) => void; fe: string;
}) {
  // In the committee pack the decision form is the action; the stage's other outcomes stay on the desk.
  const actions = mode === "committee" ? [] : d.actions.filter((a) => !a.locked);
  const locked = d.actions.find((a) => a.locked === "decide-funding");
  const [reason, setReason] = useState("");
  const [group, setGroup] = useState(d.reviewingGroup?.id ?? "");
  const [err, setErr] = useState<string>();
  useEffect(() => { setReason(""); setErr(undefined); setGroup(d.reviewingGroup?.id ?? ""); }, [d.request.id, d.request.stage, d.reviewingGroup?.id]);
  const routing = actions.some((a) => a.id === "route");
  const primary = actions.find((a) => ["route", "accept", "complete", "approve"].includes(a.id)) ?? actions[0];
  const rest = actions.filter((a) => a !== primary);
  const isDecline = (id: string) => /decline|return|reject|withdraw/.test(id);
  const anyNeedsReason = actions.some((a) => a.requiresReason);

  async function doAct(a: (typeof actions)[number], e?: FormEvent) {
    e?.preventDefault();
    if (a.requiresReason && !reason.trim()) { setErr(`Write your reason for "${a.label}" first. It's recorded with your name.`); reasonRef.current?.focus(); return; }
    if (a.id === "route" && !group) { setErr("Choose the reviewing group."); return; }
    setErr(undefined);
    const ok = await run(`act:${a.id}`, () => api.post(`/api/requests/${d.request.id}/act`, { outcome: a.id, reason: reason.trim() || undefined, groupId: a.id === "route" ? group : undefined }),
      a.id === "route" ? `Routed to ${d.groups.find((g) => g.id === group)?.label ?? "the group"}` : `Recorded: ${a.label.toLowerCase()}`);
    if (ok) { setReason(""); setDeclineArmed(false); }
  }

  if (!d.recommendation && !actions.length && !locked) return null;
  return (
    <section className="rec" id="rec" aria-labelledby="h-rec">
      <div className="rec-text">
        <span className="eyebrow">{d.recommendation ? `${fe} recommends · you decide · level ${d.recommendation.level}, ${d.recommendation.levelLabel.toLowerCase()}` : "No recommendation at this stage"}</span>
        <h2 id="h-rec" className="serif">{d.recommendation?.text ?? (actions.length ? `${d.stage.name}: your decision.` : `${d.stage.name}.`)}</h2>
        {d.recommendation ? <p className="muted small">Basis: {d.recommendation.basis}</p> : null}
        {d.reviewingGroup ? <p className="muted small">Reviewing group: {d.reviewingGroup.label} · {d.reviewingGroup.by === "assistant" ? `proposed by ${fe}${d.reviewingGroup.rule ? ` under rule ${d.reviewingGroup.rule}` : ""}` : "set by a person"}</p> : null}
        {locked && mode === "desk" ? <p className="small">The funding decision is recorded by a committee member on the <Link to={`/committee/${d.request.id}`}>Committee</Link> page, with votes, recusals and a rationale.</p> : null}
      </div>
      {actions.length ? (
        <form className="rec-act" onSubmit={(e) => primary && void doAct(primary, e)}>
          {routing ? (
            <div className="stack" style={{ gap: 4 }}>
              <label className="label" htmlFor="route-group">Route to</label>
              <select id="route-group" className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="" disabled>Choose a reviewing group…</option>
                {d.groups.map((g) => <option key={g.id} value={g.id}>{g.label}{g.id === d.reviewingGroup?.id ? " (recommended)" : ""}</option>)}
              </select>
            </div>
          ) : null}
          {primary ? <button ref={acceptRef} type="submit" className="btn" disabled={Boolean(busy)}>{primary.id === "route" ? "Accept and route" : primary.label}</button> : null}
          {rest.length ? (
            <div className="row">
              {rest.map((a) => (
                <button key={a.id} type="button" className={`btn small quiet ${isDecline(a.id) ? "danger" : ""}`} disabled={Boolean(busy)}
                  onClick={() => { if (isDecline(a.id) && !declineArmed && !reason.trim()) { setDeclineArmed(true); reasonRef.current?.focus(); return; } void doAct(a); }}>{a.label}</button>
              ))}
            </div>
          ) : null}
          {(anyNeedsReason || declineArmed) ? (
            <div className="stack" style={{ gap: 4 }}>
              <label className="eyebrow" htmlFor="act-reason">Your reason · recorded with your name</label>
              <textarea id="act-reason" ref={reasonRef} className="textarea" rows={2} style={{ minHeight: 64 }} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={actions.filter((a) => a.requiresReason).length ? `Required for ${actions.filter((a) => a.requiresReason).map((a) => a.label.toLowerCase()).join(" and ")}` : "Why"} aria-invalid={Boolean(err) || undefined} />
            </div>
          ) : null}
          {err ? <p className="error-text" role="alert">{err}</p> : null}
        </form>
      ) : null}
    </section>
  );
}

function InfoComposer({ id, seed, busy, run, onClose }: { id: string; seed?: string; busy?: string; run: (k: string, fn: () => Promise<unknown>, ok?: string) => Promise<boolean>; onClose: () => void }) {
  const [qs, setQs] = useState<string[]>([seed ?? ""]);
  const [days, setDays] = useState(10);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (seed) setQs([seed]); }, [seed]);
  async function send(e: FormEvent) {
    e.preventDefault();
    const questions = qs.map((q) => q.trim()).filter(Boolean);
    if (!questions.length) { setErr("Write at least one question."); return; }
    setErr(undefined);
    const ok = await run("info", () => api.post(`/api/requests/${id}/info-request`, { questions, dueDays: days }), `Sent ${plural(questions.length, "question")} to the requestor`);
    if (ok) onClose();
  }
  return (
    <form className="panel" onSubmit={send} aria-labelledby="h-info-c">
      <div className="stack" style={{ gap: 4 }}>
        <h2 id="h-info-c" style={{ fontSize: 20 }}>Request information</h2>
        <p className="muted small">Your words are quoted to the requestor exactly. Only these questions open; the rest of the request stays as it is.</p>
      </div>
      <div className="questions">
        {qs.map((q, i) => (
          <div key={i} className="qline">
            <span className="n">{i + 1}</span>
            <label className="sr-only" htmlFor={`info-q-${i}`}>Question {i + 1}</label>
            <textarea id={`info-q-${i}`} className="textarea" rows={2} style={{ minHeight: 56 }} value={q} onChange={(e) => setQs((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
            {qs.length > 1 ? <button type="button" className="btn small quiet" onClick={() => setQs((x) => x.filter((_, j) => j !== i))} aria-label={`Remove question ${i + 1}`}>Remove</button> : null}
          </div>
        ))}
      </div>
      <div className="row">
        {qs.length < 5 ? <button type="button" className="btn small quiet" onClick={() => setQs((x) => [...x, ""])}>Add a question</button> : <span className="muted small">Five questions at most.</span>}
        <span className="spacer" />
        <label className="small" htmlFor="info-days">Answer within</label>
        <select id="info-days" className="select small" style={{ width: "auto" }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[5, 10, 15, 20].map((n) => <option key={n} value={n}>{n} days</option>)}
        </select>
      </div>
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <div className="row"><button type="submit" className="btn" disabled={Boolean(busy)}>Send to the requestor</button><button type="button" className="btn quiet" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

function resultChip(c: CheckResult, judged?: { decision: string }): { cls: string; text: string } {
  if (judged) return { cls: "ok", text: "Judged" };
  if (c.status === "pass") return { cls: "ok", text: c.computed && typeof c.computed.ratio === "number" ? `${(Number(c.computed.ratio) * 100).toFixed(1)}%` : "Pass" };
  if (c.acknowledged || c.status === "judge" || (c.severity === "judge" && c.status === "fail")) return { cls: "you", text: "For you" };
  if (c.status === "pending") return { cls: "", text: "Waiting" };
  if (c.severity === "block") return { cls: "block", text: "Fail" };
  if (c.severity === "warn") return { cls: "warn", text: "Flag" };
  return { cls: "", text: "Note" };
}

function Checks({ d, onEvidence }: { d: BriefData; onEvidence: (t: EvidenceTarget) => void }) {
  const rows = d.checks.filter((c) => c.status !== "na");
  return (
    <section className="stack" style={{ gap: 6 }} aria-labelledby="h-checked">
      <div className="section-head">
        <h2 id="h-checked" style={{ fontSize: 24 }}>What was checked</h2>
        <span className="muted small">Rulebook v{d.request.versions.rulebook} · run at submission and again now · {d.summaryCounts.passed} of {d.summaryCounts.total} passed</span>
      </div>
      <div className="crow head" role="presentation"><span>Check</span><span>Result</span><span>Evidence</span></div>
      {rows.map((c) => {
        const judged = d.request.judgements?.[c.ruleId];
        const chip = resultChip(c, judged);
        return (
          <div key={c.ruleId} className="crow">
            <span>{c.statement}<span className="note-basis"> · {c.basis.ref}</span></span>
            <span><span className={`chip ${chip.cls}`}>{chip.text}</span></span>
            <span className="r">
              {c.evidence.length ? c.evidence.map((e, i) => <EvidenceItem key={i} e={e} onOpen={() => e.source && onEvidence({ source: e.source, title: c.statement, why: c.basis.citation })} d={d} />) : <span className="muted">{labelize(c.message, d)}</span>}
              {c.acknowledged ? <span>Requestor: {c.acknowledged.choice === "keep-and-explain" ? "kept" : "submitted with flag"}{c.acknowledged.note ? ` · "${c.acknowledged.note}"` : ""}</span> : null}
              {judged ? <span>Judged by {judged.by.name}: {judged.decision.replace(/-/g, " ")}{judged.note ? ` · "${judged.note}"` : ""}</span> : null}
            </span>
          </div>
        );
      })}
    </section>
  );
}

function EvidenceItem({ e, onOpen, d }: { e: Evidence; onOpen: () => void; d: BriefData }) {
  const text = `${labelize(e.label, d)}${e.value ? ` · ${e.value}` : ""}`;
  if (e.source?.documentId) return <button type="button" className="evlink" onClick={onOpen}>{text} →</button>;
  return <span>{text}</span>;
}


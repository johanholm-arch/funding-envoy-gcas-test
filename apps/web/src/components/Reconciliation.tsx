import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useMe } from "../lib/app";
import { fmtDate, fmtMoney } from "../lib/format";
import { useRequest } from "./requestCtx";

interface Report { actualTotal: number; attendees?: number; unusedFunds: number; notes?: string; outcomesSummary?: string; by: { name: string }; at: string }

/** The requestor's follow-up after payment: how the funds were used, then the outcomes. */
export function Reconciliation() {
  const { me } = useMe();
  const { view: v, act, id, busy } = useRequest();
  const outcomes = v.request.stage === "outcomes";
  const words = me.tenant?.words?.reconciliation ?? "Reconciliation";
  const rec = v.request.fields["reconciliation.report"]?.value as Report | undefined;
  const out = v.request.fields["outcomes.report"]?.value as Report | undefined;
  const sent = outcomes ? out : rec;
  const currency = (v.request.fields["amount.currency"]?.value as string | undefined) ?? "USD";
  const granted = v.request.decision?.amount ?? Number(v.request.fields["amount.requested"]?.value ?? 0);
  const [actual, setActual] = useState(rec ? String(rec.actualTotal) : "");
  const [attendees, setAttendees] = useState(rec?.attendees ? String(rec.attendees) : "");
  const [unused, setUnused] = useState(rec ? String(rec.unusedFunds) : "");
  const [notes, setNotes] = useState("");
  const [summary, setSummary] = useState("");
  const [err, setErr] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const a = Number(actual), u = Number(unused || 0);
    if (!actual || !Number.isFinite(a) || a < 0) { setErr("Enter the actual total spent, in numbers, for example 47900."); return; }
    if (!Number.isFinite(u) || u < 0) { setErr("Enter the unused funds as a number, or 0."); return; }
    if (outcomes && !summary.trim()) { setErr("Describe the outcomes you measured, in your own words."); return; }
    setErr(undefined);
    await act("rec", () => api.post(`/api/requests/${id}/reconciliation`, {
      actualTotal: a, unusedFunds: u, attendees: attendees ? Number(attendees) : undefined, notes: notes.trim() || undefined, outcomesSummary: outcomes ? summary.trim() : undefined,
    }), outcomes ? "Outcomes report sent" : `${words} sent`);
  }

  if (sent) {
    return (
      <section className="panel calm" aria-labelledby="h-rec">
        <span className="eyebrow">{outcomes ? "Outcomes report" : words} · sent {fmtDate(sent.at)} by {sent.by.name}</span>
        <h2 id="h-rec">Sent. The coordinator reviews it next.</h2>
        <p className="small">Spent {fmtMoney(sent.actualTotal, currency)} of {fmtMoney(granted, currency)}{sent.unusedFunds ? ` · ${fmtMoney(sent.unusedFunds, currency)} unused` : ""}{sent.attendees ? ` · ${sent.attendees} attended` : ""}.</p>
        {sent.outcomesSummary ? <p className="small">{sent.outcomesSummary}</p> : null}
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="h-rec" id="reconciliation">
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Due from you</span>
        <h2 id="h-rec">{outcomes ? "Tell us what the activity achieved" : `${words}: how the funds were used`}</h2>
        <p className="muted small">{outcomes ? "The outcomes you planned were stated in your request. Report what you measured." : `You received ${fmtMoney(granted, currency)}. Unused funds are returned; the coordinator will tell you how.`}</p>
      </div>
      <form className="stack" style={{ gap: 14 }} onSubmit={submit} noValidate>
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <div className="stack" style={{ gap: 4, flex: "1 1 180px" }}>
            <label className="label" htmlFor="rec-actual">Actual total spent ({currency})</label>
            <input id="rec-actual" className="input mono" inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value.replace(/[^0-9.]/g, ""))} />
          </div>
          <div className="stack" style={{ gap: 4, flex: "1 1 160px" }}>
            <label className="label" htmlFor="rec-unused">Unused funds ({currency})</label>
            <input id="rec-unused" className="input mono" inputMode="decimal" value={unused} onChange={(e) => setUnused(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
          </div>
          {!outcomes ? (
            <div className="stack" style={{ gap: 4, flex: "1 1 140px" }}>
              <label className="label" htmlFor="rec-att">People who attended</label>
              <input id="rec-att" className="input mono" inputMode="numeric" value={attendees} onChange={(e) => setAttendees(e.target.value.replace(/\D/g, ""))} />
            </div>
          ) : null}
        </div>
        {outcomes ? (
          <div className="stack" style={{ gap: 4 }}>
            <label className="label" htmlFor="rec-sum">Outcomes measured</label>
            <textarea id="rec-sum" className="textarea" rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Pre/post knowledge test +18 points; 90-day survey response 41%." />
          </div>
        ) : (
          <div className="stack" style={{ gap: 4 }}>
            <label className="label" htmlFor="rec-notes">Notes (optional)</label>
            <textarea id="rec-notes" className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Unused funds returned by cheque on 3 June." />
          </div>
        )}
        {err ? <p className="error-text" role="alert">{err}</p> : null}
        <div><button type="submit" className="btn" disabled={Boolean(busy)}>{outcomes ? "Send outcomes report" : `Send ${words.toLowerCase()}`}</button></div>
      </form>
    </section>
  );
}

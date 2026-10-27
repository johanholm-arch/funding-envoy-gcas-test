import { useState } from "react";
import { api, errorText } from "../lib/api";
import { hasRole, useMe, useToast } from "../lib/app";
import { fmtDate, plural } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import type { CalendarItem, DisclosureRegimeStatus } from "../lib/types";

const STATUS: Record<DisclosureRegimeStatus["status"], { chip: string; text: (r: DisclosureRegimeStatus) => string }> = {
  "nothing-to-report": { chip: "", text: () => "Nothing to report so far: no payment this period falls under this regime." },
  "needs-attention": { chip: "block", text: (r) => `${plural(r.unmatched.length, "record")} can't be published yet: the recipient needs a ${r.unmatched[0]?.needs}.` },
  ready: { chip: "ok", text: (r) => `Ready: ${plural(r.records, "record")} reconciled against payments. A named person submits the file.` },
  submitted: { chip: "ok", text: (r) => `Submitted: all ${plural(r.records, "record")}.` },
};

export function Disclosure() {
  useDocumentTitle("Disclosure");
  const { me } = useMe();
  const toast = useToast();
  const regimes = useResource<DisclosureRegimeStatus[]>("/api/disclosure");
  const cal = useResource<CalendarItem[]>("/api/calendar");
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<{ id: string; text: string }>();
  const [confirming, setConfirming] = useState<string>();
  const canFile = hasRole(me, "finance", "compliance-auditor", "process-owner");

  async function submit(r: DisclosureRegimeStatus, period: string) {
    setConfirming(undefined);
    setBusy(`${r.id}:${period}`); setErr(undefined);
    try {
      const res = await api.post<{ submitted: number }>(`/api/disclosure/${r.id}/${period}/submit`);
      toast(`Submitted ${plural(res.submitted, "record")}`);
      await regimes.refetch();
    } catch (e) { setErr({ id: r.id, text: errorText(e) }); }
    finally { setBusy(undefined); }
  }

  const next = cal.data?.[0];
  return (
    <div className="page">
      <div className="page-head">
        <span className="eyebrow">{me.tenant?.name} · transparency reporting</span>
        <h1>Disclosure</h1>
        <p className="lede">{next ? `Next deadline: ${next.label}, ${fmtDate(next.next, { long: true })}.` : "Every payment is recorded as a transfer of value for each regime that applies, at the time of payment."}</p>
      </div>
      {regimes.error ? <p className="error-text">{regimes.error.message}</p> : null}
      {regimes.loading ? <p className="muted small">Checking each regime…</p> : null}
      <section aria-labelledby="h-reg" className="stack">
        <h2 id="h-reg" style={{ marginBottom: 8 }}>Regimes</h2>
        <div style={{ borderTop: "1px solid var(--ink)" }}>
          {(regimes.data ?? []).map((r) => (
            <div key={r.id} className="regime">
              <div className="stack" style={{ gap: 4 }}>
                <strong>{r.name}</strong>
                <span className="muted small">Deadline: {r.deadline}{r.nextDue ? ` · next ${fmtDate(r.nextDue)}` : ""}</span>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <span className="small">{STATUS[r.status].text(r)}</span>
                {r.unmatched.map((u) => <span key={u.id} className="small error-text">{u.recipient}{u.ref ? ` (${u.ref})` : ""}: needs a {u.needs}</span>)}
                {r.records ? <span className="mono small">{plural(r.records, "record")} · {r.totalLabel}</span> : null}
                {err?.id === r.id ? <span className="error-text small" role="alert">{err.text}</span> : null}
              </div>
              <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
                <span className={`chip ${STATUS[r.status].chip}`}>{r.status === "nothing-to-report" ? "Nothing yet" : r.status === "needs-attention" ? "Needs attention" : r.status === "ready" ? "Ready" : "Submitted"}</span>
                {r.periods.map((p) => (
                  <span key={p} className="row" style={{ justifyContent: "flex-end" }}>
                    {canFile ? <a className="btn small quiet" href={`/api/disclosure/${r.id}/${p}/file`} download>Download {p} file</a> : null}
                    {canFile && r.status === "ready" && confirming !== `${r.id}:${p}` ? <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => setConfirming(`${r.id}:${p}`)}>Submit {p}</button> : null}
                    {confirming === `${r.id}:${p}` ? (
                      <>
                        <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void submit(r, p)}>I confirm the file is complete and accurate</button>
                        <button type="button" className="btn small quiet" onClick={() => setConfirming(undefined)}>Cancel</button>
                      </>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        {!canFile ? <p className="muted small" style={{ marginTop: 8 }}>Files are downloaded and submitted by Finance, Audit or the process owner. Submitting is always a named person's act.</p> : null}
      </section>
      <section aria-labelledby="h-cal" className="stack" style={{ gap: 4 }}>
        <h2 id="h-cal" style={{ marginBottom: 8 }}>Compliance calendar</h2>
        <div style={{ borderTop: "1px solid var(--ink)" }}>
          {(cal.data ?? []).map((c) => (
            <div key={`${c.id}-${c.next}`} className="crow" style={{ gridTemplateColumns: "120px minmax(0,1fr) auto" }}>
              <span className="mono small">{fmtDate(c.next)}</span>
              <span>{c.label}</span>
              <span className="note-basis">{c.basis.ref}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

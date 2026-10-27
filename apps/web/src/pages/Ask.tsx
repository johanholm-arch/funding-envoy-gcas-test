import { useState, type FormEvent } from "react";
import { api, errorText } from "../lib/api";
import { useMe } from "../lib/app";
import { fmtMoney } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";

interface Metric { id: string; label: string; definition: string; unit: string }
interface Library { metrics: Metric[]; dimensions?: { id: string; label: string }[] }
interface Answer {
  answer: string; declined?: string;
  plan?: { metric: string; groupBy: string[]; filters: unknown[] };
  metric?: Metric; columns?: string[]; rows?: (string | number | null)[][] | Record<string, unknown>[];
  how?: { measure: string; period: string; groupedBy: string[]; filters: string[]; access: string; sql: string; planner: string };
}

const SUGGESTIONS = ["Requests by stage", "Amount requested by country", "Amount paid by country, all time", "Median days to decision", "Information rounds per request by type"];

/** Questions about the funding function, answered from a governed metrics library, with the definition shown. */
export function Ask() {
  useDocumentTitle("Ask");
  const { me } = useMe();
  const lib = useResource<Library>("/api/ask/library");
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<{ q: string; a?: Answer; error?: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function ask(question: string, e?: FormEvent) {
    e?.preventDefault();
    if (question.trim().length < 3) return;
    setBusy(true);
    setQ("");
    setTurns((t) => [{ q: question.trim() }, ...t]);
    try {
      const a = await api.post<Answer>("/api/ask", { question: question.trim() });
      setTurns((t) => t.map((x, i) => (i === 0 ? { ...x, a } : x)));
    } catch (err) {
      setTurns((t) => t.map((x, i) => (i === 0 ? { ...x, error: errorText(err) } : x)));
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <span className="eyebrow">{me.tenant?.name} · questions about your funding</span>
        <h1>Ask</h1>
        <p className="lede">Every answer shows how it was computed and uses only data your role may see. Answers cover the last 12 months unless you say otherwise ("all time", "in 2026"). Money is shown in its own currency, never converted.</p>
      </div>
      <form className="stack" style={{ gap: 8, maxWidth: 820 }} onSubmit={(e) => void ask(q, e)}>
        <label className="label" htmlFor="ask-q">Your question</label>
        <div className="compose-row"><input id="ask-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Amount requested by country in 2027" /><button className="btn" type="submit" disabled={busy || q.trim().length < 3}>Ask</button></div>
        <div className="opts">{SUGGESTIONS.map((s) => <button key={s} type="button" className="opt" onClick={() => void ask(s)} disabled={busy}>{s}</button>)}</div>
      </form>
      <div className="stack" style={{ gap: 32 }} aria-live="polite">
        {turns.map((t, i) => <Turn key={turns.length - i} t={t} />)}
      </div>
      {lib.data ? (
        <details>
          <summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>What can be asked: {lib.data.metrics.length} measures in the metrics library</summary>
          <div style={{ borderTop: "1px solid var(--ink)", marginTop: 10 }}>
            {lib.data.metrics.map((m) => <div key={m.id} className="crow" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr)" }}><span>{m.label}</span><span className="small muted">{m.definition}</span></div>)}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function cell(v: unknown, unit?: string, currency?: string): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return unit === "money" ? fmtMoney(v, currency ?? "USD") : unit === "ratio" ? v.toFixed(2) : v.toLocaleString("en-US");
  return String(v);
}

function Turn({ t }: { t: { q: string; a?: Answer; error?: string } }) {
  const a = t.a;
  const rows = (a?.rows ?? []).map((r) => (Array.isArray(r) ? r : Object.values(r)));
  // Money is never converted: each row carries its own currency, and the amount is shown in it.
  const curIdx = a?.columns?.findIndex((c) => /^currency$/i.test(c)) ?? -1;
  return (
    <article className="stack" style={{ gap: 12, borderTop: "1px solid var(--rule)", paddingTop: 16, maxWidth: 960 }}>
      <p className="eyebrow">You asked</p>
      <p style={{ fontWeight: 500 }}>{t.q}</p>
      {t.error ? <p className="error-text">{t.error}</p> : !a ? <p className="thinking">Working it out from the metrics library…</p> : (
        <>
          <p className="serif" style={{ fontSize: 20, lineHeight: 1.35 }}>{a.answer}</p>
          {a.columns && rows.length ? (
            <div className="table-scroll">
              <table className="table">
                <thead><tr>{a.columns.map((c, i) => <th key={c} scope="col" className={i > 0 && i !== curIdx ? "num" : undefined}>{c}</th>)}</tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => (
                  <td key={j} className={j > 0 && j !== curIdx ? "num" : j === curIdx ? "mono small" : undefined}>
                    {cell(v, j === r.length - 1 ? a.metric?.unit : undefined, curIdx >= 0 ? String(r[curIdx] ?? "") || undefined : undefined)}
                  </td>
                ))}</tr>)}</tbody>
              </table>
            </div>
          ) : null}
          {a.how ? (
            <details>
              <summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>How this was computed</summary>
              <div className="detail">
                <span className="k">Measure</span><span>{a.metric?.label ? `${a.metric.label} = ` : ""}{a.how.measure}</span>
                <span className="k">Period</span><span>{a.how.period}</span>
                <span className="k">Grouped by</span><span>{a.how.groupedBy.join(", ") || "Nothing"}</span>
                <span className="k">Filters</span><span>{a.how.filters.join(", ") || "None"}</span>
                <span className="k">Your access</span><span>{a.how.access}</span>
                <span className="k">Planner</span><span>{a.how.planner}</span>
                <span className="k">Query</span><span className="mono">{a.how.sql}</span>
              </div>
            </details>
          ) : null}
        </>
      )}
    </article>
  );
}

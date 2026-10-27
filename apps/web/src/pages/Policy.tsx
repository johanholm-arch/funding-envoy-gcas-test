import { useState, type FormEvent } from "react";
import { api, errorText } from "../lib/api";
import { assistantName, useMe } from "../lib/app";
import { useDocumentTitle } from "../lib/hooks";
import type { PolicyAnswer } from "../lib/types";

interface Turn { q: string; a?: PolicyAnswer; error?: string }

export function Policy() {
  useDocumentTitle("Policy");
  const { me } = useMe();
  const fe = assistantName(me);
  const funder = me.tenant?.name ?? "the funder";
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  async function ask(e: FormEvent) {
    e.preventDefault();
    const question = q.trim();
    if (question.length < 2) return;
    setBusy(true);
    setTurns((t) => [{ q: question }, ...t]);
    setQ("");
    try {
      const a = await api.post<PolicyAnswer>("/api/policy/ask", { question });
      setTurns((t) => t.map((x, i) => (i === 0 ? { ...x, a } : x)));
    } catch (err) {
      setTurns((t) => t.map((x, i) => (i === 0 ? { ...x, error: errorText(err) } : x)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow">
      <div className="page-head">
        <span className="eyebrow">{funder} · grants and donations policy</span>
        <h1>Ask about the policy</h1>
        <p className="lede">Answers quote the clause they come from. {fe} doesn't predict decisions or say how much {funder} usually gives.</p>
      </div>
      <form className="stack" style={{ gap: 8 }} onSubmit={ask}>
        <label className="label" htmlFor="pq">Your question</label>
        <div className="compose-row">
          <input id="pq" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Can we include a faculty dinner in the budget?" />
          <button className="btn" type="submit" disabled={busy || q.trim().length < 2}>Ask</button>
        </div>
        <p className="hash">{me.assistant.label}</p>
      </form>
      <div className="stack" style={{ gap: 24 }} aria-live="polite">
        {turns.map((t, i) => (
          <article key={turns.length - i} className="stack" style={{ gap: 10, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
            <p className="eyebrow">You asked</p>
            <p style={{ fontWeight: 500 }}>{t.q}</p>
            {t.error ? <p className="error-text">{t.error}</p> : !t.a ? <p className="thinking">{fe} is looking in the policy…</p> : t.a.declined ? (
              <p className="bubble quiet">{t.a.answer}</p>
            ) : (
              <>
                <p>{t.a.answer}</p>
                {t.a.citations.map((c) => (
                  <div key={c.ref} className="stack" style={{ gap: 4 }}>
                    <span className="chip ok" style={{ alignSelf: "flex-start" }}>{c.ref}</span>
                    {c.quote && !t.a!.answer.includes(c.quote.slice(0, 40)) ? <blockquote className="quote">{c.quote}</blockquote> : null}
                  </div>
                ))}
              </>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

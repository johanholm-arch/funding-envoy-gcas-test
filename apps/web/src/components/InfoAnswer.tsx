import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { fmtDate, plural } from "../lib/format";
import type { InfoRequest } from "../lib/types";
import { useRequest } from "./requestCtx";
import { FilePick } from "./ui";

/** A coordinator's questions, quoted, with an answer box for each. Only these are open. */
export function InfoAnswer({ info }: { info: InfoRequest }) {
  const { act, id, upload, busy } = useRequest();
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(info.questions.map((q) => [q.id, q.answer ?? ""])));
  const [err, setErr] = useState<string>();
  const open = info.questions.filter((q) => !q.answer);

  async function send(e: FormEvent) {
    e.preventDefault();
    const filled = open.filter((q) => answers[q.id]?.trim());
    if (!filled.length) { setErr("Write an answer to at least one question. You can send the rest later."); return; }
    setErr(undefined);
    await act("info", () => api.post(`/api/requests/${id}/info/${info.id}`, { answers: filled.map((q) => ({ questionId: q.id, answer: answers[q.id]!.trim() })) }),
      filled.length === open.length ? "Answers sent" : `${plural(filled.length, "answer")} sent; ${open.length - filled.length} still open`);
  }

  return (
    <section className="panel" id="info" aria-labelledby="h-info">
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Information request · {plural(open.length, "question")} open{info.dueAt ? ` · please answer by ${fmtDate(info.dueAt)}` : ""}</span>
        <h2 id="h-info">{info.by.name} from the grants team asked</h2>
        <p className="muted small">On {fmtDate(info.at)}. Only these questions are open; the rest of your request stays as it is. When you're done, the reviewer gets a short note of what changed.</p>
      </div>
      <form className="stack" style={{ gap: 18 }} onSubmit={send}>
        {info.questions.map((q, i) => (
          <div key={q.id} className="stack" style={{ gap: 8 }}>
            <blockquote className="quote">"{q.text}"</blockquote>
            {q.answer ? (
              <p className="small"><span className="chip ok">Answered</span> {q.answer}</p>
            ) : (
              <>
                <label className="label" htmlFor={`ans-${q.id}`}>Your answer to question {i + 1}</label>
                <textarea id={`ans-${q.id}`} className="textarea" rows={3} value={answers[q.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
              </>
            )}
          </div>
        ))}
        {err ? <p className="error-text" role="alert">{err}</p> : null}
        {open.length ? (
          <div className="row">
            <button type="submit" className="btn" disabled={Boolean(busy)}>Send {open.length === 1 ? "answer" : "answers"}</button>
            <FilePick className="btn quiet" label="Attach documents" multiple onFiles={(f) => void upload(f)} disabled={Boolean(busy)} />
          </div>
        ) : null}
      </form>
    </section>
  );
}

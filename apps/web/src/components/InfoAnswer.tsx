import { useState, type FormEvent } from "react";
import { api, errorText } from "../lib/api";
import { useToast } from "../lib/app";
import { fmtDate, plural } from "../lib/format";
import type { InfoRequest } from "../lib/types";
import { useRequest } from "./requestCtx";
import { FilePick } from "./ui";

/** A coordinator's questions, quoted, with an answer box and attachments for each. Only these are open. */
export function InfoAnswer({ info }: { info: InfoRequest }) {
  const { act, id, busy, view: v, refetch } = useRequest();
  const toast = useToast();
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(info.questions.map((q) => [q.id, q.answer ?? ""])));
  const [attached, setAttached] = useState<Record<string, { id: string; name: string }[]>>({});
  const [uploading, setUploading] = useState<string>();
  const [err, setErr] = useState<string>();
  const open = info.questions.filter((q) => !q.answer);
  const docName = (docId: string) => v.documents.find((d) => d.id === docId)?.name ?? "document";

  /** Upload to the request, then attach exactly the new documents to this question. */
  async function attach(qid: string, files: File[]) {
    setUploading(qid); setErr(undefined);
    const before = new Set(v.documents.map((d) => d.id));
    try {
      await api.upload(`/api/requests/${id}/documents`, files);
      const fresh = await refetch();
      const added = (fresh?.documents ?? []).filter((d) => !before.has(d.id)).map((d) => ({ id: d.id, name: d.name }));
      setAttached((a) => ({ ...a, [qid]: [...(a[qid] ?? []), ...added] }));
      toast(added.length === 1 ? `Attached ${added[0]!.name}` : `Attached ${plural(added.length, "document")}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setUploading(undefined);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const filled = open.filter((q) => answers[q.id]?.trim() || attached[q.id]?.length);
    if (!filled.length) { setErr("Write an answer to at least one question, or attach a document to it. You can send the rest later."); return; }
    setErr(undefined);
    const ok = await act("info", () => api.post(`/api/requests/${id}/info/${info.id}`, {
      answers: filled.map((q) => ({ questionId: q.id, answer: (answers[q.id] ?? "").trim(), documentIds: attached[q.id]?.length ? attached[q.id]!.map((d) => d.id) : undefined })),
    }), filled.length === open.length ? "Answers sent" : `${plural(filled.length, "answer")} sent; ${open.length - filled.length} still open`);
    if (ok) setAttached({});
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
              <p className="small"><span className="chip ok">Answered</span> {q.answer}{q.documentIds?.length ? ` · with ${q.documentIds.map(docName).join(", ")}` : ""}</p>
            ) : (
              <>
                <label className="label" htmlFor={`ans-${q.id}`}>Your answer to question {i + 1}</label>
                <textarea id={`ans-${q.id}`} className="textarea" rows={3} value={answers[q.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
                <div className="row">
                  <FilePick className="btn small quiet" label={uploading === q.id ? "Uploading…" : "Attach documents"} multiple onFiles={(f) => void attach(q.id, f)} disabled={Boolean(busy) || Boolean(uploading)} ariaLabel={`Attach documents to question ${i + 1}`} />
                  {(attached[q.id] ?? []).map((d) => (
                    <span key={d.id} className="chip">{d.name}
                      <button type="button" className="linkbtn tiny muted" aria-label={`Don't attach ${d.name}`} onClick={() => setAttached((a) => ({ ...a, [q.id]: (a[q.id] ?? []).filter((x) => x.id !== d.id) }))}>×</button>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
        {err ? <p className="error-text" role="alert">{err}</p> : null}
        {open.length ? <div><button type="submit" className="btn" disabled={Boolean(busy) || Boolean(uploading)}>Send {open.length === 1 ? "answer" : "answers"}</button></div> : null}
      </form>
    </section>
  );
}

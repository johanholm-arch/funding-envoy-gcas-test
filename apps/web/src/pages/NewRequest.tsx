import { useState, type DragEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { assistantName, useMe } from "../lib/app";
import { useDocumentTitle } from "../lib/hooks";
import { FilePick } from "../components/ui";

export function NewRequest() {
  useDocumentTitle("New request");
  const { me } = useMe();
  const navigate = useNavigate();
  const fe = assistantName(me);
  const funder = me.tenant?.name ?? "the funder";
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<"describe" | "upload" | "form">();
  const [error, setError] = useState<{ where: string; text: string }>();

  async function describe(e: FormEvent) {
    e.preventDefault();
    if (text.trim().length < 10) {
      setError({ where: "describe", text: "Write a sentence or two about the activity first: what it is, when and where, and how much you're asking for." });
      return;
    }
    setBusy("describe");
    setError(undefined);
    try {
      const { id } = await api.post<{ id: string }>("/api/requests", { text: text.trim() });
      navigate(`/requests/${id}`);
    } catch (err) {
      setError({ where: "describe", text: errorText(err) });
      setBusy(undefined);
    }
  }

  async function upload() {
    if (!files.length) {
      setError({ where: "upload", text: "Choose at least one file to upload." });
      return;
    }
    setBusy("upload");
    setError(undefined);
    let id: string | undefined;
    try {
      id = (await api.post<{ id: string }>("/api/requests", {})).id;
      await api.upload(`/api/requests/${id}/documents`, files);
      navigate(`/requests/${id}`);
    } catch (err) {
      // The draft exists even if the upload failed; take the person there so they can retry without losing it.
      if (id) navigate(`/requests/${id}`, { state: { uploadError: errorText(err) } });
      else { setError({ where: "upload", text: errorText(err) }); setBusy(undefined); }
    }
  }

  async function form() {
    setBusy("form");
    setError(undefined);
    try {
      const { id } = await api.post<{ id: string }>("/api/requests", {});
      navigate(`/requests/${id}?view=form`);
    } catch (err) {
      setError({ where: "form", text: errorText(err) });
      setBusy(undefined);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length) setFiles((f) => [...f, ...dropped]);
  }

  return (
    <div className="page">
      <div className="page-head">
        <span className="eyebrow">New request to {funder}</span>
        <h1>Start however suits you</h1>
        <p className="lede">You can switch between these at any point. {fe} checks your request against {funder}'s policy as you go, and nothing is sent until you confirm it.</p>
      </div>

      <div className="ways">
        <form className="way" onSubmit={describe} aria-labelledby="w1">
          <h2 id="w1">Describe it</h2>
          <p className="muted small">In your own words: what the activity is, who runs it, when and where, and how much you're asking for. {fe} picks out the facts and asks only what's missing.</p>
          <label className="sr-only" htmlFor="describe">Describe the activity</label>
          <textarea id="describe" className="textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="We'd like to request $50,000 for our annual heart failure symposium in Boston, 14–15 May 2027, accredited through Beacon CME."
            aria-invalid={error?.where === "describe" || undefined} aria-describedby={error?.where === "describe" ? "err-describe" : undefined} />
          {error?.where === "describe" ? <p id="err-describe" className="error-text" role="alert">{error.text}</p> : null}
          <div><button className="btn" type="submit" disabled={Boolean(busy)}>{busy === "describe" ? "Starting…" : "Start with this description"}</button></div>
        </form>

        <section className="way" aria-labelledby="w2">
          <h2 id="w2">Upload what you have</h2>
          <p className="muted small">Prospectus, budget, request letter, tax documents. {fe} reads them, fills in what it can and shows the page or cell each value came from. You confirm every value.</p>
          <div className={`dropzone ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
            <FilePick className="btn small quiet" label="Choose files" multiple onFiles={(f) => setFiles((x) => [...x, ...f])} />
            <span className="help">or drop them here · PDF, Word, Excel, CSV · up to 25 MB each</span>
            {files.length ? (
              <ul className="filelist" aria-label="Files to upload">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="row" style={{ justifyContent: "space-between" }}>
                    <span>{f.name}</span>
                    <button type="button" className="linkbtn muted tiny" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>Remove</button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {error?.where === "upload" ? <p className="error-text" role="alert">{error.text}</p> : null}
          <div><button className="btn" type="button" onClick={() => void upload()} disabled={Boolean(busy)}>{busy === "upload" ? `Uploading ${files.length}…` : files.length ? `Upload ${files.length} and start` : "Upload and start"}</button></div>
        </section>

        <section className="way" aria-labelledby="w3">
          <h2 id="w3">Use a form</h2>
          <p className="muted small">Answer the questions yourself, section by section. Pick the request type first; the form then shows only what applies to it in your country.</p>
          {error?.where === "form" ? <p className="error-text" role="alert">{error.text}</p> : null}
          <div><button className="btn quiet" type="button" onClick={() => void form()} disabled={Boolean(busy)}>{busy === "form" ? "Opening…" : "Open the form"}</button></div>
        </section>
      </div>

      <div className="stack" style={{ gap: 2 }}>
        <p className="muted small">{fe} is an assistant. It cites {funder}'s policy, never predicts a decision, and cannot submit, sign or make statements for you.</p>
        <p className="hash">{me.assistant.label}</p>
      </div>
    </div>
  );
}

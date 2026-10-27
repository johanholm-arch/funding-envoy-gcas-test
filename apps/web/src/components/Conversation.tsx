import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { assistantName, useMe } from "../lib/app";
import { useMediaQuery } from "../lib/hooks";
import { fmtWhen } from "../lib/format";
import { fieldByKey } from "../lib/request";
import type { Ask, Message } from "../lib/types";
import { useRequest } from "./requestCtx";
import { FieldInput, FilePick, isEmpty } from "./ui";

export function Conversation() {
  const { me } = useMe();
  const { view: v, id, editable, act, busy, upload } = useRequest();
  const fe = assistantName(me);
  const funder = me.tenant?.name ?? "the funder";
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ text?: string; files?: string[] }>();
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messages = v.messages.filter((m) => m.channel === "requestor");
  const phone = useMediaQuery("(max-width: 899px)");
  const [showAll, setShowAll] = useState(false);
  // On a phone the conversation is question-at-a-time: the latest exchange, with the history one tap away.
  const visibleFrom = (activeId?: string) => {
    const i = activeId ? messages.findIndex((m) => m.id === activeId) : -1;
    return Math.max(0, Math.min(messages.length - 2, i >= 0 ? i : messages.length));
  };

  // The open question comes from the API (nextAsk) once the type is confirmed. Its controls sit on the
  // assistant's latest message asking it; if no message carries it, it is shown on its own at the end.
  // Before the type is confirmed, the open question is the type question in the latest message.
  const active = useMemo(() => {
    if (v.nextAsk) {
      const qid = v.nextAsk.questionId;
      const m = [...messages].reverse().find((x) => x.author.type === "agent" && x.data.ask?.questionId === qid);
      return { id: m?.id, ask: v.nextAsk };
    }
    if (v.request.typeConfirmed) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.author.type === "person") return undefined;
      if (m.author.type === "agent" && m.data.ask?.kind === "type") return { id: m.id, ask: m.data.ask };
    }
    return undefined;
  }, [messages, v.nextAsk, v.request.typeConfirmed]);

  const visible = phone && !showAll ? messages.slice(visibleFrom(active?.id)) : messages;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (phone && !showAll) window.scrollTo({ top: 0 });
  }, [messages.length, pending, phone, showAll]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t) return;
    setPending({ text: t });
    setText("");
    const ok = await act("message", () => api.post(`/api/requests/${id}/messages`, { text: t }));
    if (!ok) setText(t);
    setPending(undefined);
    inputRef.current?.focus();
  }

  async function attach(files: File[]) {
    setPending({ files: files.map((f) => f.name) });
    await upload(files);
    setPending(undefined);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const placeholder = active?.ask.kind === "field" ? "Your answer…" : "Ask about the policy…";

  return (
    <aside className="rail" id="rail" aria-label={`${fe} conversation`}>
      <div className="rail-head">
        <div className="who-line">
          <span className="dot" aria-hidden="true" />
          <strong>{fe}</strong>
          <span className="chip">Assistant</span>
        </div>
        <p className="muted tiny">Reads your documents, checks {funder}'s policy, never decides funding. Everything it proposes is marked until you confirm it.</p>
        <p className="hash">{me.assistant.label}</p>
      </div>

      <div className="rail-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions" tabIndex={0} aria-label="Conversation">
        {visible.length < messages.length ? (
          <button type="button" className="linkbtn small" onClick={() => setShowAll(true)}>Show the whole conversation ({messages.length - visible.length} earlier)</button>
        ) : null}
        {visible.map((m) => (
          <Bubble key={m.id} m={m} fe={fe} active={active?.id === m.id ? active.ask : undefined} />
        ))}
        {active && !active.id && editable ? (
          <div className="bubble">
            <span className="eyebrow who">{fe} · open question</span>
            <p className="pre ask-text">{active.ask.text}</p>
            <AskControls ask={active.ask} />
          </div>
        ) : null}
        {pending ? (
          <>
            {pending.text ? <div className="bubble me pending"><span className="eyebrow who">You · sending</span><p>{pending.text}</p></div> : null}
            <p className="thinking">{pending.files ? `${fe} is reading ${pending.files.join(", ")}…` : `${fe} is reading your message…`}</p>
          </>
        ) : busy?.startsWith("upload") ? <p className="thinking">{fe} is reading the upload…</p> : null}
        {!editable ? <ClosedNote /> : null}
      </div>

      {editable ? (
        <form className="rail-compose" onSubmit={send}>
          <label htmlFor="say" className="eyebrow">Tell {fe} or ask about the policy</label>
          <div className="compose-row">
            <FilePick className="btn quiet attach" label="+" ariaLabel="Attach files" title="Attach files" multiple onFiles={(f) => void attach(f)} disabled={Boolean(pending)} />
            <textarea id="say" ref={inputRef} className="textarea" rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={placeholder} aria-describedby="say-help" />
            <button className="btn" type="submit" disabled={!text.trim() || Boolean(pending)}>Send</button>
          </div>
          <p id="say-help" className="muted tiny">Answers quote {funder}'s policy. {fe} won't predict a decision.</p>
        </form>
      ) : null}
    </aside>
  );
}

function ClosedNote() {
  const { view: v } = useRequest();
  if (v.request.status === "draft" || v.request.status === "info-requested") return null;
  return <p className="muted small">This request has been submitted. When the grants team needs anything, it appears here and on your start page.</p>;
}

function Bubble({ m, fe, active }: { m: Message; fe: string; active?: Ask }) {
  const mine = m.author.type === "person";
  const [openCite, setOpenCite] = useState<number>();
  if (m.data.declined) {
    return (
      <div className="bubble quiet">
        <span className="eyebrow who">{fe} · {fmtWhen(m.createdAt)} · outside what I can answer</span>
        <p>{m.body}</p>
      </div>
    );
  }
  const paras = m.body.split(/\n\s*\n/);
  const askText = m.data.ask?.text;
  return (
    <div className={`bubble ${mine ? "me" : ""}`}>
      <span className="eyebrow who">{mine ? "You" : m.author.type === "agent" ? fe : m.author.name} · {fmtWhen(m.createdAt)}</span>
      {paras.map((p, i) => (
        <p key={i} className={`pre ${askText && i === paras.length - 1 && p.trim() === askText.trim() ? "ask-text" : ""}`}>{p}</p>
      ))}
      {m.data.citations?.length ? (
        <div className="stack" style={{ gap: 6 }}>
          <div className="chips">
            {m.data.citations.map((c, i) => (
              <button key={i} type="button" className="chip ok" aria-expanded={openCite === i} onClick={() => setOpenCite(openCite === i ? undefined : i)}>{c.ref}</button>
            ))}
          </div>
          {openCite !== undefined && m.data.citations[openCite]?.quote ? <p className="quote cite-quote">{m.data.citations[openCite]!.quote}</p> : null}
        </div>
      ) : null}
      {active ? <AskControls ask={active} /> : null}
    </div>
  );
}

function AskControls({ ask }: { ask: Ask }) {
  const { view: v, id, act, busy, pick, goTo } = useRequest();
  const [yesFor, setYesFor] = useState<string>();
  const [detail, setDetail] = useState("");
  const [value, setValue] = useState<unknown>("");
  const [err, setErr] = useState<string>();
  const choose = (optionId: string, note?: string) =>
    act(`choice:${optionId}`, () => api.post(`/api/requests/${id}/choice`, { questionId: ask.questionId, optionId, note }));

  if (ask.kind === "ready") return <div><Link to={`/requests/${id}/review`} className="btn small">Review and submit</Link></div>;
  if (ask.kind === "attestations") return <div><button type="button" className="btn small" onClick={() => goTo("statements")}>Go to your statements</button></div>;

  if (ask.kind === "field" && ask.fieldKey && !ask.options?.length) {
    const f = fieldByKey(v, ask.fieldKey);
    // Text answers go through the composer; choices and dates get a control here.
    if (!f || !["enum", "boolean", "date", "datetime"].includes(f.kind)) return null;
    const save = async () => {
      if (isEmpty(value)) { setErr(`Choose ${f.label.toLowerCase()} first.`); return; }
      setErr(undefined);
      await act("field", () => api.post(`/api/requests/${id}/fields`, { changes: [{ key: f.key, value }] }));
    };
    return (
      <div className="stack" style={{ gap: 8 }}>
        <label className="sr-only" htmlFor={`ask-${f.key}`}>{f.label}</label>
        <FieldInput field={f} value={value} onChange={setValue} id={`ask-${f.key}`} />
        {err ? <p className="error-text">{err}</p> : null}
        <div><button type="button" className="btn small" onClick={() => void save()} disabled={Boolean(busy)}>Save answer</button></div>
      </div>
    );
  }

  const options = ask.options ?? [];
  if (!options.length) return null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="opts" role="group" aria-label="Choose an answer">
        {options.map((o) => {
          const onClick = () => {
            if (ask.kind === "coi" && o.id === "yes") { setYesFor(ask.questionId); return; }
            if (o.id === "upload" && ask.kind === "budget") { pick("budget"); return; }
            if (o.id.startsWith("upload:")) { pick(o.id.slice(7)); return; }
            if (o.id.startsWith("attest:") || o.id.startsWith("answer:")) { goTo(o.id.startsWith("attest:") ? `att-${o.id.slice(7)}` : "doc-top"); return; }
            void choose(o.id);
          };
          return <button key={o.id} type="button" className="opt" aria-pressed={yesFor === ask.questionId && o.id === "yes"} disabled={Boolean(busy)} onClick={onClick}>{o.label}</button>;
        })}
      </div>
      {yesFor ? (
        <form className="stack" style={{ gap: 6 }} onSubmit={(e) => {
          e.preventDefault();
          if (!detail.trim()) { setErr("Give the details of a yes in your own words. They're recorded as yours."); return; }
          setErr(undefined);
          void choose("yes", detail.trim());
        }}>
          <label className="label" htmlFor="coi-detail">Details, in your own words</label>
          <textarea id="coi-detail" className="textarea" rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} aria-invalid={Boolean(err) || undefined} autoFocus />
          {err ? <p className="error-text" role="alert">{err}</p> : null}
          <div className="row"><button type="submit" className="btn small" disabled={Boolean(busy)}>Record my answer</button><button type="button" className="btn small quiet" onClick={() => setYesFor(undefined)}>Cancel</button></div>
        </form>
      ) : null}
    </div>
  );
}

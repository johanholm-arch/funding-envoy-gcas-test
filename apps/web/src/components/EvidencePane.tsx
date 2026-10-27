import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useResource } from "../lib/hooks";
import type { DocumentPages, Provenance } from "../lib/types";

export interface EvidenceTarget {
  source: Provenance;
  /** What the evidence is for, e.g. the check statement or the field label. */
  title?: string;
  why?: string;
}

/** The quoted page, with the quote highlighted. Docked on wide screens, a dialog on narrow ones. */
export function EvidencePane({ target, onClose, docked }: { target: EvidenceTarget; onClose: () => void; docked: boolean }) {
  const src = target.source;
  const pages = useResource<DocumentPages>(src.documentId ? `/api/documents/${src.documentId}/pages` : undefined);
  const [page, setPage] = useState(src.page ?? 1);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPage(src.page ?? 1), [src.documentId, src.page, src.quote, src.cell]);
  useEffect(() => closeRef.current?.focus(), [target]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    const m = bodyRef.current?.querySelector("mark");
    m?.scrollIntoView({ block: "center" });
  }, [pages.data, page]);

  const total = pages.data?.pages.length ?? 0;
  const text = pages.data?.pages[page - 1] ?? "";
  const isCsv = /\.csv$/i.test(pages.data?.name ?? src.documentName ?? "") || /^[^\n]*,[^\n]*\n/.test(text) && text.split("\n").every((l) => !l || l.includes(","));
  const showsQuote = page === (src.page ?? 1);

  const pane = (
    <aside className="evidence" aria-label="Evidence" role={docked ? "complementary" : "dialog"} aria-modal={docked ? undefined : true}>
      <div className="evidence-head">
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <span className="eyebrow">Evidence{target.title ? ` · ${target.title}` : ""}</span>
          <strong style={{ overflowWrap: "anywhere" }}>{pages.data?.name ?? src.documentName ?? "Document"}{total > 1 ? ` · page ${page} of ${total}` : ""}</strong>
        </div>
        <button ref={closeRef} type="button" className="btn small quiet" onClick={onClose}>Close</button>
      </div>
      <div className="evidence-body" ref={bodyRef}>
        {pages.error ? <p className="error-text">{pages.error.message}</p> : null}
        {pages.loading ? <p className="muted small">Opening the document…</p> : null}
        {pages.data && !text ? <p className="muted">This document has no readable text, so there is nothing to highlight. Open the original file instead.</p> : null}
        {text ? (isCsv ? <CsvPage text={text} cell={showsQuote ? src.cell : undefined} quote={showsQuote ? src.quote : undefined} /> : <TextPage text={text} quote={showsQuote ? src.quote : undefined} />) : null}
        {showsQuote && src.quote && text && !containsQuote(text, src.quote) && !src.cell ? (
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow">Quoted</span>
            <p className="quote">{src.quote}</p>
          </div>
        ) : null}
        {target.why ? (
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow">Why it matters</span>
            <p className="small muted">{target.why}</p>
          </div>
        ) : null}
        {total > 1 ? (
          <nav className="pager" aria-label="Pages">
            <button type="button" className="btn small quiet" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous page</button>
            <button type="button" className="btn small quiet" disabled={page >= total} onClick={() => setPage((p) => p + 1)}>Next page</button>
          </nav>
        ) : null}
        {src.documentId ? <a className="small" href={`/api/documents/${src.documentId}/file`} target="_blank" rel="noreferrer">Open the original file</a> : null}
      </div>
    </aside>
  );
  if (docked) return pane;
  return (
    <div className="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {pane}
    </div>
  );
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
function containsQuote(text: string, quote: string): boolean {
  return norm(text).includes(norm(quote));
}

/** Split text around the quote (whitespace-insensitive), so it can be wrapped in <mark>. */
function highlight(text: string, quote: string | undefined): ReactNode {
  if (!quote) return text;
  const q = quote.trim();
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx >= 0) return <>{text.slice(0, idx)}<mark>{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</>;
  // Tolerate line breaks inside the quote.
  const pattern = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const m = new RegExp(pattern, "i").exec(text);
  if (m) return <>{text.slice(0, m.index)}<mark>{m[0]}</mark>{text.slice(m.index + m[0].length)}</>;
  return text;
}

function TextPage({ text, quote }: { text: string; quote?: string }) {
  const blocks = useMemo(() => text.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b && !/^=== Page \d+ ===$/.test(b)), [text]);
  // When the quote spans a whole block, highlight inside that block; otherwise in whichever block contains it.
  return (
    <div className="evidence-page">
      {blocks.map((b, i) => {
        const heading = /^#{1,6}\s/.test(b);
        const clean = b.replace(/^#{1,6}\s+/, "");
        const has = quote ? norm(clean).includes(norm(quote)) : false;
        return <p key={i} className={heading ? "md-h" : undefined} style={{ whiteSpace: "pre-line" }}>{has ? highlight(clean, quote) : clean}</p>;
      })}
    </div>
  );
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

function CsvPage({ text, cell, quote }: { text: string; cell?: string; quote?: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  const target = cell ? /^([A-Z]+)(\d+)$/.exec(cell) : null;
  const col = target ? target[1]!.charCodeAt(0) - 65 : -1;
  const rowIdx = target ? Number(target[2]) - 1 : -1;
  const quoteRow = !target && quote ? rows.findIndex((r) => norm(r.join(", ")).includes(norm(quote).split(",")[0]!)) : -1;
  const [head, ...body] = rows;
  return (
    <div className="table-scroll">
      <table className="table" style={{ fontSize: 12.5 }}>
        {head ? <thead><tr>{head.map((h, i) => <th key={i} scope="col" className={/amount|total/i.test(h) ? "num" : undefined}>{h}</th>)}</tr></thead> : null}
        <tbody>
          {body.map((r, ri) => {
            const isRow = ri + 1 === rowIdx || ri + 1 === quoteRow;
            return (
              <tr key={ri} aria-current={isRow || undefined}>
                {r.map((c, ci) => {
                  const isCell = isRow && (col < 0 || ci === col || ci === 1);
                  const numeric = /^-?\d+(\.\d+)?$/.test(c.trim());
                  return <td key={ci} className={numeric ? "num" : undefined}>{isCell ? <mark>{c}</mark> : c}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

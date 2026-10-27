import type { ReactNode } from "react";

/** Just enough Markdown for generated agreements: headings, **bold**, numbered clauses, paragraphs. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { out.push(<h3 key={i} className="md-h">{inline(h[2]!)}</h3>); return; }
    const li = /^(\d+)\.\s+(.*)$/.exec(line);
    if (li) { out.push(<p key={i} className="md-li"><span className="mono muted">{li[1]}.</span><span>{inline(li[2]!)}</span></p>); return; }
    out.push(<p key={i}>{inline(line)}</p>);
  });
  return <div className="md">{out}</div>;
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

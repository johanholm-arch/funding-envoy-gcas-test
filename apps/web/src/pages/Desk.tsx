import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useDocumentTitle, useMediaQuery, useResource } from "../lib/hooks";
import type { Desk, DeskItem } from "../lib/types";
import { Brief, type BriefHandle } from "../components/Brief";
import { EvidencePane, type EvidenceTarget } from "../components/EvidencePane";

const GROUPS: { key: "needsYou" | "assistant" | "waiting"; title: string; empty: string }[] = [
  { key: "needsYou", title: "Needs you", empty: "Nothing needs you. FundingEnvoy will put requests here when only a person can act." },
  { key: "assistant", title: "FundingEnvoy is handling", empty: "Nothing in hand." },
  { key: "waiting", title: "Waiting on others", empty: "Nothing waiting." },
];

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable));
}

export function DeskPage() {
  useDocumentTitle("Desk");
  const { id } = useParams();
  const navigate = useNavigate();
  const desk = useResource<Desk>("/api/desk");
  const [q, setQ] = useState("");
  const [evidence, setEvidence] = useState<EvidenceTarget>();
  const searchRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef<BriefHandle>(null);
  const wide = useMediaQuery("(min-width: 1280px)");
  const phone = useMediaQuery("(max-width: 899px)");
  const docked = Boolean(evidence) && wide;

  const filter = (x: DeskItem) => !q || `${x.title} ${x.organization} ${x.ref} ${x.subtype ?? ""}`.toLowerCase().includes(q.toLowerCase());
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: (desk.data?.[g.key] ?? []).filter(filter) })), [desk.data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Open the first request that needs a person, so the desk leads with the next thing.
  useEffect(() => {
    if (!id && !phone && flat[0]) navigate(`/desk/${flat[0].id}`, { replace: true });
  }, [id, phone, flat, navigate]);
  useEffect(() => setEvidence(undefined), [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" && !typing(e)) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (typing(e)) { if (e.key === "Escape") (e.target as HTMLElement).blur(); return; }
      const idx = flat.findIndex((x) => x.id === id);
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        e.preventDefault();
        const next = flat[Math.max(0, Math.min(flat.length - 1, idx + (k === "j" ? 1 : -1)))] ?? flat[0];
        if (next) {
          navigate(`/desk/${next.id}`);
          window.setTimeout(() => document.getElementById(`q-${next.id}`)?.focus({ preventScroll: false }), 0);
        }
      } else if (k === "a") { e.preventDefault(); briefRef.current?.focusAccept(); }
      else if (k === "i") { e.preventDefault(); briefRef.current?.openInfo(); }
      else if (k === "d") { e.preventDefault(); briefRef.current?.focusDecline(); }
      else if (k === "e") { e.preventDefault(); briefRef.current?.openFirstEvidence(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, id, navigate]);

  return (
    <div className={`desk ${docked ? "with-evidence" : ""}`} data-view={id ? "brief" : "queue"}>
      <nav className="queue" aria-label="Queue">
        <div className="queue-search">
          <label htmlFor="find" className="sr-only">Find a request, organization or reference</label>
          <input id="find" ref={searchRef} className="input small" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a request, organization, reference" />
          <span className="kbd" aria-hidden="true">/</span>
        </div>
        <div className="queue-scroll">
          {desk.error ? <p className="queue-empty error-text">{desk.error.message}</p> : null}
          {desk.loading ? <p className="queue-empty">Loading the queue…</p> : null}
          {desk.data ? groups.map((g) => (
            <section key={g.key} className="queue-group" aria-labelledby={`g-${g.key}`}>
              <h2 id={`g-${g.key}`}>{g.title} <span className="count">{g.items.length}</span></h2>
              {g.key === "needsYou" && g.items.length ? <p className="queue-empty" style={{ paddingTop: 0 }}>Sorted by what only a person can do</p> : null}
              {!g.items.length ? <p className="queue-empty">{q ? "No match." : g.empty}</p> : null}
              {g.items.map((x) => (
                <Link key={x.id} id={`q-${x.id}`} to={`/desk/${x.id}`} className="qrow" aria-current={x.id === id ? "true" : undefined}>
                  <span className="top"><span className="t">{x.title}</span><span className="mono small">{x.amountLabel}</span></span>
                  <span className="m">{x.organization}{x.subtype ? ` · ${x.subtype}` : ""} · {x.ageDays === 0 ? "today" : `${x.ageDays}d`}</span>
                  <span className="m" style={{ color: "var(--ink-2)" }}>{x.line.charAt(0).toUpperCase() + x.line.slice(1)}</span>
                  <span className="chips">
                    {x.forJudgement ? <span className="chip you">{x.forJudgement} for your judgement</span> : null}
                    {x.passed ? <span className="chip ok">{x.passed} passed</span> : null}
                  </span>
                </Link>
              ))}
            </section>
          )) : null}
        </div>
        <div className="queue-keys" aria-label="Keyboard shortcuts">
          <span><span className="kbd">J</span><span className="kbd">K</span> move</span>
          <span><span className="kbd">A</span> accept</span>
          <span><span className="kbd">I</span> info request</span>
          <span><span className="kbd">D</span> decline</span>
          <span><span className="kbd">E</span> evidence</span>
        </div>
      </nav>
      <div className="brief" id="brief">
        {id ? (
          <>
            {phone ? <p style={{ marginBottom: 16 }}><Link to="/desk">Back to the queue</Link></p> : null}
            <Brief ref={briefRef} id={id} onEvidence={setEvidence} onChanged={() => void desk.refetch()} />
          </>
        ) : desk.data && !flat.length ? (
          <div className="brief-inner"><h1>Nothing on the desk</h1><p className="lede">New submissions appear here as soon as FundingEnvoy has checked them.</p></div>
        ) : null}
      </div>
      {evidence ? <EvidencePane target={evidence} onClose={() => setEvidence(undefined)} docked={docked} /> : null}
    </div>
  );
}

import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { assistantName, hasRole, useMe } from "../lib/app";
import { describe } from "../lib/actions";
import { fmtDate, fmtWhen, plural, shortHash } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import type { AuditEvent, ChainVerification, RequestPayload, Trail } from "../lib/types";

type Filter = "all" | "people" | "agent" | "system";

export function TrailPage() {
  const { id = "" } = useParams();
  const { me } = useMe();
  const fe = assistantName(me);
  const trail = useResource<Trail>(`/api/requests/${id}/trail`);
  const req = useResource<RequestPayload>(`/api/requests/${id}`);
  const [filter, setFilter] = useState<Filter>("all");
  const [find, setFind] = useState("");
  const [verify, setVerify] = useState<ChainVerification | { error: string }>();
  const [verifying, setVerifying] = useState(false);
  const title = (req.data?.request.fields.title?.value as string | undefined) ?? req.data?.request.title ?? "Request";
  useDocumentTitle(`${title} · trail`);
  const canVerify = hasRole(me, "compliance-auditor", "process-owner", "coordinator");
  const requestor = me.user.kind === "requestor";

  const fieldLabel = useMemo(() => {
    const m = new Map((req.data?.subtype?.fields ?? []).map((f) => [f.key, f.label.toLowerCase()]));
    return (k: string) => m.get(k) ?? k;
  }, [req.data]);

  const events = trail.data?.events ?? [];
  const kindOf = (e: AuditEvent): Filter => (e.actor.type === "person" ? "people" : e.actor.type === "agent" ? "agent" : "system");
  const shown = events.filter((e) => (filter === "all" || kindOf(e) === filter) && (!find || JSON.stringify([e.action, e.actor.name, e.data ?? {}, describe(e, fieldLabel)]).toLowerCase().includes(find.toLowerCase())));
  const c = trail.data?.counts;
  const first = events[0], last = events[events.length - 1];

  async function runVerify() {
    setVerifying(true);
    try { setVerify(await api.get<ChainVerification>("/api/audit/verify")); } catch (e) { setVerify({ error: errorText(e) }); } finally { setVerifying(false); }
  }

  return (
    <div className="page" style={{ maxWidth: 1160 }}>
      <div className="page-head-row">
        <div className="page-head">
          <span className="eyebrow">{req.data?.request.ref ?? ""} · every action by a person, the system or {fe}</span>
          <h1 style={{ fontSize: 34 }}>{title} · trail</h1>
          <p className="muted">
            {events.length ? `${plural(events.length, "entry", "entries")} · ${fmtDate(first!.at)} to ${fmtDate(last!.at)} · append-only · each entry hashed and chained to the one before` : trail.loading ? "Loading the trail…" : "No entries."}
          </p>
        </div>
        <div className="row">
          {requestor ? <Link to={`/requests/${id}`} className="btn quiet">Back to the request</Link> : <Link to={`/desk/${id}`} className="btn quiet">Open the brief</Link>}
          {canVerify ? <a className="btn quiet" href={`/api/requests/${id}/trail/export`}>Export for auditor</a> : null}
          {canVerify ? <button type="button" className="btn quiet" onClick={() => void runVerify()} disabled={verifying}>{verifying ? "Verifying…" : "Verify chain"}</button> : null}
        </div>
      </div>

      <div aria-live="polite">
        {verify ? ("error" in verify ? <p className="verify bad">Verification didn't run: {verify.error}</p> : verify.ok ? (
          <p className="verify ok">Chain verified at {fmtWhen(verify.verifiedAt, { seconds: true })}: all {verify.checked} entries in {me.tenant?.name ?? "the tenant"}'s chain recompute to their hashes and link in order. Head <span className="mono">{shortHash(verify.head)}</span>.</p>
        ) : (
          <p className="verify bad">The chain is broken at entry #{verify.firstBreak?.seq}: {verify.firstBreak?.reason}. {verify.checked} entries before it verify. Tell your compliance lead; do not export until it is explained.</p>
        )) : null}
      </div>

      <div className="filters" role="group" aria-label="Show">
        <span className="muted small">Show</span>
        {([["all", `All ${events.length}`], ["people", `People ${c?.people ?? 0}`], ["agent", `${fe} ${c?.agent ?? 0}`], ["system", `System and connectors ${c?.system ?? 0}`]] as [Filter, string][]).map(([k, label]) => (
          <button key={k} type="button" className="filt" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
        ))}
        <span className="spacer" />
        <label htmlFor="find-ev" className="muted small">Find</label>
        <input id="find-ev" className="input small" style={{ width: 240, maxWidth: "100%" }} value={find} onChange={(e) => setFind(e.target.value)} placeholder="field, document, rule, person" />
      </div>

      {trail.error ? <p className="error-text">{trail.error.message}</p> : null}

      <section aria-label="Entries">
        <div className="ev head eyebrow"><span>When</span><span>Who</span><span>What</span></div>
        {shown.map((e) => <Entry key={e.id} e={e} fe={fe} fieldLabel={fieldLabel} />)}
        {trail.data && !shown.length ? <p className="muted small" style={{ padding: "16px 0" }}>No entries match.</p> : null}
      </section>
      <p className="muted small">Retention: ten years after closure. Exports carry their own verification report.</p>
    </div>
  );
}

function Entry({ e, fe, fieldLabel }: { e: AuditEvent; fe: string; fieldLabel: (k: string) => string }) {
  const { what, detail } = describe(e, fieldLabel);
  const chip = e.actor.type === "person" ? "person" : e.actor.type === "agent" ? "ai" : "sys";
  return (
    <div className="ev">
      <span className="t">{fmtWhen(e.at, { seconds: true, alwaysDate: true })}</span>
      <span><span className={`chip ${chip}`} title={e.actor.name}>{e.actor.type === "agent" ? fe : e.actor.name}</span></span>
      <span>
        <div className="w">{what}</div>
        {detail ? <div className="d">{detail}</div> : null}
        {e.ai ? (
          <details>
            <summary>How {e.actor.type === "agent" ? fe : "the platform"} did this</summary>
            <div className="detail">
              <span className="k">Provider · model</span><span className="mono">{e.ai.provider} · {e.ai.model}</span>
              <span className="k">Prompt set</span><span className="mono">{e.ai.promptVersion}</span>
              {e.ai.gate ? (<><span className="k">Gate</span><span>Stage {e.ai.gate.stage} · level {e.ai.gate.level} · {e.ai.gate.outcome === "applied" ? "applied" : e.ai.gate.outcome === "proposed" ? "proposed, waiting for a person" : "held for a person"}</span></>) : null}
              <span className="k">Inputs</span><span className="mono">{e.ai.inputHashes.length ? e.ai.inputHashes.join(" · ") : "none recorded"}</span>
              <span className="k">Output</span><span className="mono">{e.ai.outputHash || "none recorded"}</span>
              {e.ai.humanDecision ? (<><span className="k">Human outcome</span><span>{e.ai.humanDecision.decision} by {e.ai.humanDecision.by.name}{e.ai.humanDecision.reason ? ` · "${e.ai.humanDecision.reason}"` : ""}</span></>) : null}
              {e.ai.latencyMs !== undefined ? (<><span className="k">Latency</span><span className="mono">{e.ai.latencyMs} ms</span></>) : null}
            </div>
          </details>
        ) : null}
        <div className="hash" style={{ marginTop: 4 }}>#{e.seq} · hash {shortHash(e.hash)} · prev {shortHash(e.prevHash)}</div>
      </span>
    </div>
  );
}

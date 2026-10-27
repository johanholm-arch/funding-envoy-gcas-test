import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { hasRole, useMe } from "../lib/app";
import { fmtWhen, shortHash } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import type { ChainVerification, Desk } from "../lib/types";

/** Pick a request to read its trail, and verify the tenant's chain. */
export function AuditIndex() {
  useDocumentTitle("Audit");
  const { me } = useMe();
  const desk = useResource<Desk>("/api/desk");
  const [verify, setVerify] = useState<ChainVerification | { error: string }>();
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const all = desk.data ? [...desk.data.needsYou, ...desk.data.assistant, ...desk.data.waiting, ...desk.data.done] : [];
  const items = all.filter((x) => !q || `${x.title} ${x.organization} ${x.ref}`.toLowerCase().includes(q.toLowerCase()));
  const canVerify = hasRole(me, "compliance-auditor", "process-owner", "coordinator");

  return (
    <div className="page">
      <div className="page-head-row">
        <div className="page-head">
          <span className="eyebrow">{me.tenant?.name} · audit trail</span>
          <h1>Trails</h1>
          <p className="lede">Every action on every request, by a person, the system or the assistant, hashed and chained. Choose a request to read its trail.</p>
        </div>
        {canVerify ? <button type="button" className="btn quiet" disabled={busy} onClick={async () => { setBusy(true); try { setVerify(await api.get<ChainVerification>("/api/audit/verify")); } catch (e) { setVerify({ error: errorText(e) }); } finally { setBusy(false); } }}>{busy ? "Verifying…" : "Verify chain"}</button> : null}
      </div>
      <div aria-live="polite">
        {verify ? ("error" in verify ? <p className="verify bad">Verification didn't run: {verify.error}</p> : verify.ok
          ? <p className="verify ok">Chain verified at {fmtWhen(verify.verifiedAt, { seconds: true })}: all {verify.checked} entries recompute to their hashes and link in order. Head <span className="mono">{shortHash(verify.head)}</span>.</p>
          : <p className="verify bad">The chain is broken at entry #{verify.firstBreak?.seq}: {verify.firstBreak?.reason}.</p>) : null}
      </div>
      <div>
        <label className="label" htmlFor="aq">Find a request</label>
        <input id="aq" className="input" style={{ maxWidth: 420 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, organization or reference" />
      </div>
      {desk.error ? <p className="error-text">{desk.error.message}</p> : null}
      <div className="list">
        {items.map((x) => (
          <Link key={x.id} to={`/audit/${x.id}`} className="lrow">
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <span className="lrow-title">{x.title}</span>
              <span className="lrow-meta">{x.organization} · {x.stageName}</span>
            </div>
            <div className="lrow-side"><span className="mono">{x.amountLabel}</span><span className="hash">{x.ref}</span></div>
          </Link>
        ))}
        {desk.data && !items.length ? <p className="muted small" style={{ padding: "14px 0" }}>{q ? "No match." : "No submitted requests yet."}</p> : null}
      </div>
    </div>
  );
}

// The simulated Salesforce org, as a grants coordinator would see it there: the requests FundingEnvoy wrote, their
// files and comments, the organizations, and the platform events the org published. The grants team can act on a
// request the way they would in Salesforce (ask for information, approve, decline), and FundingEnvoy hears about it.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { hasRole, useMe, useToast } from "../lib/app";
import { fmtDate, fmtWhen } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";

interface SfActor { id: string; name: string; via: "portal" | "integration" | "salesforce" }
interface Rec { id: string; object: string; fields: Record<string, unknown>; createdBy: SfActor; modifiedBy: SfActor; createdAt: string; modifiedAt: string }
interface Console {
  connected: boolean; active: boolean; myDomain?: string;
  statusValues?: { infoRequested: string; approved: string; declined: string; submitted: string };
  objects: { name: string; label: string; fields: { name: string; label: string; type: string }[] }[];
  requests: (Rec & { ref?: string; account?: string; files: Rec[]; comments: Rec[] })[];
  accounts: { id: string; name: string; taxId?: string; createdBy: SfActor; createdAt: string; fromFundingEnvoy: boolean }[];
  events: { replayId: number; uuid: string; at: string; processed: boolean; payload: { Kind__c: string; Status__c?: string; Body__c?: string; Changed_By__c: SfActor; Request_Id__c: string } }[];
  cursor: number;
}

const VIA: Record<SfActor["via"], string> = { portal: "portal user, written by FundingEnvoy", integration: "integration user", salesforce: "in Salesforce" };
const money = (n: unknown, cur: unknown) => typeof n === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency: String(cur ?? "USD"), maximumFractionDigits: 0 }).format(n) : "";

export function SalesforceSim() {
  useDocumentTitle("Salesforce (simulated)");
  const { me } = useMe();
  const c = useResource<Console>("/api/salesforce-sim");
  const [tab, setTab] = useState<"requests" | "accounts" | "events">("requests");
  const [sel, setSel] = useState<string>();
  const data = c.data;
  const rec = data?.requests.find((r) => r.id === sel) ?? data?.requests[0];
  const reqLabels = new Map(data?.objects.find((o) => o.name === "gx__Request__c")?.fields.map((f) => [f.name, f.label]) ?? []);

  return (
    <div className="sfsim">
      <div className="sfsim-band">
        <div className="sfsim-band-inner">
          <span className="sfsim-logo" aria-hidden>☁</span>
          <span><strong style={{ fontWeight: 600 }}>Salesforce</strong> · Grants Exchange</span>
          <span className="chip warn">Simulated org</span>
          {data?.myDomain ? <span className="mono small sfsim-domain">{data.myDomain}</span> : null}
        </div>
      </div>
      <div className="page" style={{ maxWidth: 1180, paddingTop: 24 }}>
        <p className="small muted">This stands in for the funder's Salesforce org so the connection can be shown without one. FundingEnvoy writes requests here in the requestor's name; what you do here comes back to FundingEnvoy as events. <Link to="/studio/connect">Connection settings</Link></p>
        {c.error ? <p className="error-text">{c.error.message}</p> : null}
        {data && !data.active ? <p className="setup-note">Salesforce isn't connected for this funder yet. <Link to="/studio/connect">Connect it in Studio</Link>.</p> : null}
        <div className="seg" role="tablist" aria-label="Salesforce objects">
          {(["requests", "accounts", "events"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-checked={tab === t} aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "requests" ? `Grant Requests (${data?.requests.length ?? 0})` : t === "accounts" ? `Organizations (${data?.accounts.length ?? 0})` : `Platform events (${data?.events.length ?? 0})`}
            </button>
          ))}
        </div>

        {tab === "requests" && data ? (
          data.requests.length ? (
            <div className="sfsim-split">
              <ul className="sfsim-list" aria-label="Grant requests">
                {data.requests.map((r) => (
                  <li key={r.id}>
                    <button type="button" aria-current={rec?.id === r.id ? "true" : undefined} onClick={() => setSel(r.id)}>
                      <span className="t">{String(r.fields.Name)}</span>
                      <span className="small muted">{r.account} · {money(r.fields.gx__Requested_Amount__c, r.fields.CurrencyIsoCode)}</span>
                      <span className="chips"><span className={`chip ${/Approved/.test(String(r.fields.gx__Status__c)) ? "ok" : /Information|Declined/.test(String(r.fields.gx__Status__c)) ? "warn" : "sys"}`}>{String(r.fields.gx__Status__c)}</span>{r.ref ? <span className="mono small">{r.ref}</span> : null}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {rec ? <RequestRecord rec={rec} labels={reqLabels} canAct={hasRole(me, "coordinator", "process-owner", "committee-chair", "operator")} onDone={() => void c.refetch()} statusValues={data.statusValues} /> : null}
            </div>
          ) : <p className="muted">No requests yet. When a requestor submits to this funder, the request appears here.</p>
        ) : null}

        {tab === "accounts" && data ? (
          <table className="connect-table">
            <thead><tr><th>Organization Name</th><th>Tax ID or Registration Number</th><th>Created</th></tr></thead>
            <tbody>{data.accounts.map((a) => (
              <tr key={a.id}><td>{a.name}<br /><span className="mono help">{a.id}</span></td><td className="mono small">{a.taxId ?? ""}</td><td className="small">{fmtDate(a.createdAt)} by {a.createdBy.name} ({VIA[a.createdBy.via]}){a.fromFundingEnvoy ? <span className="chip sys" style={{ marginLeft: 6 }}>Linked to FundingEnvoy</span> : null}</td></tr>
            ))}</tbody>
          </table>
        ) : null}

        {tab === "events" && data ? (
          <div className="stack" style={{ gap: 6 }}>
            <p className="small muted">Published by the org's Flow on <span className="mono">/event/FundingEnvoy_Request_Change__e</span> and read by FundingEnvoy through the Pub/Sub API. FundingEnvoy has processed everything up to replay ID {data.cursor}; events it caused itself are skipped.</p>
            <table className="connect-table">
              <thead><tr><th>Replay ID</th><th>Event</th><th>By</th><th>FundingEnvoy</th></tr></thead>
              <tbody>{data.events.map((e) => (
                <tr key={e.replayId}>
                  <td className="mono">{e.replayId}</td>
                  <td className="small">{e.payload.Kind__c === "status" ? `Status → ${e.payload.Status__c}` : `Comment: “${String(e.payload.Body__c ?? "").slice(0, 80)}”`}<br /><span className="help">{fmtWhen(e.at)}</span></td>
                  <td className="small">{e.payload.Changed_By__c?.name} <span className="help">({VIA[e.payload.Changed_By__c?.via ?? "salesforce"]})</span></td>
                  <td>{e.processed ? <span className="chip ok">{e.payload.Changed_By__c?.via === "salesforce" ? "Received" : "Skipped: its own"}</span> : <span className="chip warn">Waiting</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RequestRecord({ rec, labels, canAct, onDone, statusValues }: { rec: Console["requests"][number]; labels: Map<string, string>; canAct: boolean; onDone: () => void; statusValues?: Console["statusValues"] }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [amount, setAmount] = useState(String(rec.fields.gx__Requested_Amount__c ?? ""));
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const status = String(rec.fields.gx__Status__c);
  const open = status === statusValues?.submitted;
  async function act(action: "request-info" | "approve" | "decline" | "comment") {
    setBusy(action); setErr(undefined);
    try {
      const r = await api.post<{ processed: number }>(`/api/salesforce-sim/requests/${rec.id}/act`, { action, text: text.trim() || undefined, amount: action === "approve" ? Number(amount) : undefined });
      toast(`Saved in Salesforce. FundingEnvoy received ${r.processed} event${r.processed === 1 ? "" : "s"}.`);
      setText(""); onDone();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(undefined); }
  }
  const shown = Object.entries(rec.fields).filter(([k, v]) => v !== null && v !== "" && k !== "gx__Review_Summary__c");
  return (
    <article className="sfsim-record" aria-labelledby="sf-rec-title">
      <header className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Grant Request · <span className="mono">{rec.id}</span></span>
        <h2 id="sf-rec-title" style={{ fontSize: 22 }}>{String(rec.fields.Name)}</h2>
        <p className="small">Created {fmtWhen(rec.createdAt)} by <strong style={{ fontWeight: 600 }}>{rec.createdBy.name}</strong> ({VIA[rec.createdBy.via]}) · last modified by {rec.modifiedBy.name}</p>
      </header>
      {canAct ? (
        <section className="sfsim-actions" aria-label="Act as the grants team in Salesforce">
          <label className="label" htmlFor="sf-text">Comment to the requestor</label>
          <textarea id="sf-text" className="textarea" rows={2} style={{ minHeight: 60 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: please send the budget broken down by session." />
          <div className="row">
            <button type="button" className="btn small" disabled={Boolean(busy) || !open || !text.trim()} onClick={() => void act("request-info")}>Request more information</button>
            <button type="button" className="btn small quiet" disabled={Boolean(busy) || !text.trim()} onClick={() => void act("comment")}>Post comment only</button>
            <span className="row" style={{ gap: 4 }}><label className="sr-only" htmlFor="sf-amt">Approved amount</label><input id="sf-amt" className="input small" style={{ width: 110 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><button type="button" className="btn small quiet" disabled={Boolean(busy) || !open || !Number(amount)} onClick={() => void act("approve")}>Approve</button></span>
            <button type="button" className="btn small quiet danger" disabled={Boolean(busy) || !open} onClick={() => void act("decline")}>Decline</button>
          </div>
          {!open ? <p className="help">Status is “{status}”. Decisions and information requests are available while it is “{statusValues?.submitted}”.</p> : null}
          {err ? <p className="error-text" role="alert">{err}</p> : null}
        </section>
      ) : null}
      <section aria-label="Fields">
        <table className="connect-table">
          <tbody>{shown.map(([k, v]) => <tr key={k}><td style={{ width: "40%" }}>{labels.get(k) ?? k}<br /><span className="mono help">{k}</span></td><td className="small">{typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : String(v)}</td></tr>)}</tbody>
        </table>
        {rec.fields.gx__Review_Summary__c ? <details><summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>Pre-Submission Review Summary (written by FundingEnvoy)</summary><pre className="connect-json">{String(rec.fields.gx__Review_Summary__c)}</pre></details> : null}
      </section>
      <section aria-label="Files" className="stack" style={{ gap: 4 }}>
        <h3 className="connect-h3">Files ({rec.files.length})</h3>
        {rec.files.map((f) => <p key={f.id} className="small">{String(f.fields.PathOnClient)} <span className="chip sys">{String(f.fields.gx__Category__c ?? "Other")}</span></p>)}
      </section>
      <section aria-label="Comments" className="stack" style={{ gap: 6 }}>
        <h3 className="connect-h3">Comments ({rec.comments.length})</h3>
        {rec.comments.map((cm) => <div key={cm.id} className="sfsim-comment"><p className="small" style={{ whiteSpace: "pre-wrap" }}>{String(cm.fields.gx__Body__c)}</p><p className="help">{String(cm.fields.gx__Author_Name__c ?? cm.createdBy.name)} · {fmtWhen(cm.createdAt)} · {VIA[cm.createdBy.via]}</p></div>)}
      </section>
    </article>
  );
}

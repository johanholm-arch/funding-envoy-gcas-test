import { Link } from "react-router-dom";
import { useMe } from "../lib/app";
import { fmtDate, greeting, greetName, plural } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import type { MyRequest } from "../lib/types";

export function Home() {
  useDocumentTitle("My requests");
  const { me } = useMe();
  const list = useResource<MyRequest[]>("/api/my/requests");
  const items = list.data ?? [];
  const needs = items.filter((r) => r.needsYou);
  const rest = items.filter((r) => !r.needsYou);
  const lead = !list.data ? "" : needs.length
    ? `${plural(needs.length, "request needs", "requests need")} you.`
    : items.length ? "Nothing needs you right now. We'll tell you when something does." : "You have no requests yet.";

  return (
    <div className="page">
      <div className="page-head-row">
        <div className="page-head">
          <span className="eyebrow">{me.organization?.name}</span>
          <h1>{greeting()}, {greetName(me.user.name)}.</h1>
          {lead ? <p className="lede">{lead}</p> : null}
        </div>
      </div>

      {list.error ? <p className="error-text">{list.error.message}</p> : null}

      {needs.length ? (
        <section aria-labelledby="h-needs" className="stack" style={{ gap: 8 }}>
          <h2 id="h-needs">Needs you <span className="count">{needs.length}</span></h2>
          <div className="list">
            {needs.map((r) => (
              <Link key={r.id} to={`/requests/${r.id}`} className="lrow">
                <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span className="lrow-title">{r.title}</span>
                  <span className="lrow-meta" style={{ color: "var(--ink)" }}>{r.action ?? r.plain}{r.due ? ` · by ${fmtDate(r.due)}` : ""}</span>
                  <span className="lrow-meta">{r.status === "draft" ? `Started · last saved ${fmtDate(r.updatedAt)}` : r.plain}</span>
                </div>
                <div className="lrow-side">
                  <span className="mono">{r.amountLabel}</span>
                  <span className={`chip ${r.due ? "warn" : "you"}`}>{r.due ? `Due ${fmtDate(r.due)}` : r.status === "draft" ? "Continue" : "Open"}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {rest.length ? (
        <section aria-labelledby="h-rest" className="stack" style={{ gap: 8 }}>
          <h2 id="h-rest">{needs.length ? "Everything else" : "Your requests"} <span className="count">{rest.length}</span></h2>
          <div className="list">
            {rest.map((r) => (
              <Link key={r.id} to={`/requests/${r.id}`} className="lrow">
                <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span className="lrow-title">{r.title}</span>
                  <span className="lrow-meta" style={{ color: "var(--ink)" }}>{r.plain}</span>
                </div>
                <div className="lrow-side">
                  <span className="mono">{r.amountLabel}</span>
                  <span className="hash">{r.ref}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {list.data && !items.length ? (
        <div className="panel calm" style={{ maxWidth: 640 }}>
          <p>Describe your activity in your own words, upload the documents you have, or fill in a form. FundingEnvoy checks it against {me.tenant?.name ?? "the funder"}'s policy as you go, and nothing is sent until you confirm.</p>
          <div><Link to="/requests/new" className="btn">Start a request</Link></div>
        </div>
      ) : null}
    </div>
  );
}

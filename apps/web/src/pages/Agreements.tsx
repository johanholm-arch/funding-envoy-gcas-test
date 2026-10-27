import { useEffect, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMe } from "../lib/app";
import { fmtDate, fmtMoney } from "../lib/format";
import { useDocumentTitle, useMediaQuery, useResource } from "../lib/hooks";
import type { Desk, DeskItem, PaymentListRow, RequestPayload } from "../lib/types";
import { AgreementPanel, PaymentPanel } from "../components/Downstream";

export function Agreements() {
  useDocumentTitle("Agreements and payments");
  const { me } = useMe();
  const { id } = useParams();
  const navigate = useNavigate();
  const phone = useMediaQuery("(max-width: 899px)");
  const desk = useResource<Desk>("/api/desk");
  const canSeePayments = me.user.roles.some((r) => ["finance", "coordinator", "tax", "compliance-auditor"].includes(r));
  const pays = useResource<PaymentListRow[]>(canSeePayments ? "/api/payments" : undefined);
  const all: DeskItem[] = desk.data ? [...desk.data.needsYou, ...desk.data.assistant, ...desk.data.waiting] : [];
  const agreements = all.filter((x) => x.stage === "agreement");
  const payments = all.filter((x) => x.stage === "payment");
  const paid = useMemo(() => (pays.data ?? []).filter((p) => p.status === "paid"), [pays.data]);
  const first = [...agreements, ...payments][0];
  const finance = me.user.roles.some((r) => r === "finance" || r === "tax");

  useEffect(() => {
    if (!id && !phone) {
      const pick = finance ? payments[0] ?? agreements[0] : agreements[0] ?? payments[0];
      if (pick) navigate(`/agreements/${pick.id}`, { replace: true });
    }
  }, [id, phone, finance, payments, agreements, navigate]);

  const row = (x: DeskItem) => (
    <Link key={x.id} to={`/agreements/${x.id}`} className="qrow" aria-current={x.id === id ? "true" : undefined}>
      <span className="top"><span className="t">{x.title}</span><span className="mono small">{x.amountLabel}</span></span>
      <span className="m">{x.organization}</span>
      <span className="m" style={{ color: "var(--ink-2)" }}>{x.line.charAt(0).toUpperCase() + x.line.slice(1)}</span>
    </Link>
  );

  return (
    <div className="desk" data-view={id ? "brief" : "queue"}>
      <nav className="queue" aria-label="Agreements and payments">
        <div className="queue-scroll">
          {desk.error ? <p className="queue-empty error-text">{desk.error.message}</p> : null}
          <section className="queue-group" aria-labelledby="g-agr">
            <h2 id="g-agr">Agreements <span className="count">{agreements.length}</span></h2>
            {desk.data && !agreements.length ? <p className="queue-empty">No agreements in progress.</p> : null}
            {agreements.map(row)}
          </section>
          <section className="queue-group" aria-labelledby="g-pay">
            <h2 id="g-pay">Payments <span className="count">{payments.length}</span></h2>
            {desk.data && !payments.length ? <p className="queue-empty">No payments waiting for release.</p> : null}
            {payments.map(row)}
          </section>
          {paid.length ? (
            <section className="queue-group" aria-labelledby="g-paid">
              <h2 id="g-paid">Paid <span className="count">{paid.length}</span></h2>
              {paid.map((p) => (
                <Link key={p.id} to={`/agreements/${p.request_id}`} className="qrow" aria-current={p.request_id === id ? "true" : undefined}>
                  <span className="top"><span className="t">{p.title ?? p.ref}</span><span className="mono small">{fmtMoney(p.amount, p.currency)}</span></span>
                  <span className="m">{p.org} · paid {p.paid_at ? fmtDate(p.paid_at) : ""}</span>
                </Link>
              ))}
            </section>
          ) : null}
        </div>
      </nav>
      <div className="brief">
        {id ? <Detail id={id} phone={phone} onChanged={() => { void desk.refetch(); void pays.refetch(); }} /> : desk.data && !first ? (
          <div className="brief-inner"><h1>Nothing to sign or pay</h1><p className="lede">After a funding decision, FundingEnvoy drafts the agreement from the clause library. It appears here for legal to send, and moves to payment once both sides have signed.</p></div>
        ) : null}
      </div>
    </div>
  );
}

function Detail({ id, phone, onChanged }: { id: string; phone: boolean; onChanged: () => void }) {
  const r = useResource<RequestPayload>(`/api/requests/${id}`);
  const title = (r.data?.request.fields.title?.value as string | undefined) ?? r.data?.request.title;
  const stage = r.data?.request.stage;
  return (
    <div className="brief-inner">
      {phone ? <p><Link to="/agreements">Back to the list</Link></p> : null}
      <header className="stack" style={{ gap: 8 }}>
        <span className="eyebrow">{r.data?.request.ref} · {r.data?.stage.name}</span>
        <h1 style={{ fontSize: 34 }}>{title ?? "Request"}</h1>
        {r.data ? <p className="muted">{r.data.organization.legalName}{r.data.request.decision ? ` · ${r.data.request.decision.outcome.replace(/-/g, " ")} ${fmtMoney(r.data.request.decision.amount, (r.data.request.fields["amount.currency"]?.value as string) ?? "USD")} on ${fmtDate(r.data.request.decision.at)}` : ""} · <Link to={`/desk/${id}`}>Brief</Link> · <Link to={`/audit/${id}`}>Trail</Link></p> : null}
      </header>
      <AgreementPanel id={id} onChanged={() => { void r.refetch(); onChanged(); }} />
      {stage && stage !== "agreement" ? <PaymentPanel id={id} onChanged={() => { void r.refetch(); onChanged(); }} /> : null}
    </div>
  );
}

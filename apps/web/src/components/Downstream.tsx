import { useState, type FormEvent } from "react";
import { api, ApiError, errorText } from "../lib/api";
import { hasRole, useMe, useToast } from "../lib/app";
import { fmtDate, fmtMoney, fmtTime, humanize, plural } from "../lib/format";
import { useResource } from "../lib/hooks";
import { Markdown } from "../lib/markdown";
import type { AgreementView, PaymentDetail, RequestPayload } from "../lib/types";

/** The letter of agreement: clauses checked against the packs, signatures by named people, certification. */
export function AgreementPanel({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const { me } = useMe();
  const toast = useToast();
  const a = useResource<AgreementView>(`/api/requests/${id}/agreement`);
  const [busy, setBusy] = useState<string>();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string>();
  const requestor = me.user.kind === "requestor";
  const legal = hasRole(me, "legal", "coordinator");

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key); setErr(undefined);
    try { await fn(); await a.refetch(); onChanged?.(); toast(ok); return true; }
    catch (e) { setErr(errorText(e)); return false; }
    finally { setBusy(undefined); }
  }

  if (a.error && !a.data) return <p className="error-text">{a.error.message}</p>;
  const v = a.data;
  if (!v) return <p className="muted small">Opening the agreement…</p>;
  const ag = v.agreement;
  const sigs = ag?.signatures ?? [];
  const orgSide = v.sides?.organization;
  const orgSigned = sigs.some((s) => s.party === orgSide);
  const canSignHere = Boolean(v.canSign);
  const missing = v.requiredClauses.filter((c) => !c.present);

  const sentence = !ag
    ? v.stage === "agreement" ? "No agreement drafted yet." : "The agreement is drafted after the funding decision."
    : ag.status === "draft" ? `Drafted ${fmtDate(ag.created_at)} from the clause library; not sent yet.`
    : ag.status === "sent" ? `Out for e-signature${ag.envelope_id ? ` (envelope ${ag.envelope_id})` : ""}. ${sigs.length ? `Signed by ${sigs.map((s) => s.name).join(" and ")}; waiting for the other side.` : "Neither side has signed yet."}`
    : `Signed by both sides${v.certificationRequired ? ag.certifiedAt ? `, certified ${fmtDate(ag.certifiedAt)}` : "; final-signatory certification is still needed before payment" : ""}.`;

  async function sign(e: FormEvent) {
    e.preventDefault();
    if (name.trim().toLowerCase() !== me.user.name.trim().toLowerCase()) { setErr(`Type your full name exactly as "${me.user.name}" to sign.`); return; }
    await run("sign", () => api.post(`/api/requests/${id}/agreement/sign`, { typedName: name.trim() }), "Signed");
  }

  return (
    <section className="stack" style={{ gap: 18 }} aria-labelledby="h-agr">
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">Letter of agreement{ag ? ` · ${ag.template_id}` : ""}</span>
        <h2 id="h-agr">Agreement</h2>
        <p className="status-line">{sentence}</p>
      </div>

      {v.requiredClauses.length ? (
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Clauses the rules require · {v.requiredClauses.length - missing.length} of {v.requiredClauses.length} present</span>
          {v.requiredClauses.map((c) => (
            <div key={c.id} className="crow" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
              <span>{c.label}{c.basis?.ref ? <span className="note-basis"> · {c.basis.ref}</span> : null}</span>
              <span className={`chip ${c.present ? "ok" : ag ? "block" : ""}`}>{c.present ? "In the text" : ag ? "Missing" : "Will be included"}</span>
            </div>
          ))}
        </div>
      ) : null}

      {ag ? <div className="doc-paper"><Markdown text={ag.body} /></div> : null}

      {ag ? (
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Signatures</span>
          {v.sides ? [v.sides.organization, v.sides.company].map((side) => {
            const sg = sigs.find((x) => x.party === side);
            return <p key={side} className="small">{side}: {sg ? <>signed by <strong>{sg.name}</strong>, {fmtDate(sg.at)} {fmtTime(sg.at)} · typed name, recorded with its meaning</> : <span className="muted">{ag.status === "draft" ? "not sent yet" : "waiting"}{side === v.sides!.company ? " · signed by Legal" : v.signer ? ` · ${v.signer.name}, ${v.signer.title}` : ""}</span>}</p>;
          }) : sigs.map((sg) => <p key={sg.party} className="small">{sg.party}: signed by <strong>{sg.name}</strong>, {fmtDate(sg.at)} {fmtTime(sg.at)}</p>)}
          {v.certificationRequired ? <p className="small">{ag.certifiedAt ? `Certified by the final signatory, ${fmtDate(ag.certifiedAt)}.` : "UK: the final medical signatory certifies the agreement before payment (ABPI Clause 8.3)."}</p> : null}
        </div>
      ) : null}

      {canSignHere ? (
        <form className="panel" onSubmit={sign}>
          <span className="eyebrow">Locked to a person · your typed name is your signature</span>
          <p>By signing you agree to the terms above on behalf of {v.mySide}.</p>
          <div className="sign-row">
            <div className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
              <label className="label" htmlFor="sign-name">Type your full name to sign</label>
              <input id="sign-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={me.user.name} autoComplete="off" spellCheck={false} />
            </div>
            <button type="submit" className="btn" disabled={Boolean(busy)}>Sign the agreement</button>
          </div>
        </form>
      ) : requestor && ag?.status === "sent" && !orgSigned ? (
        <p className="small">Only your authorized signer{v.signer ? `, ${v.signer.name},` : ""} can sign. {v.signer ? `A signing link was sent to ${v.signer.email}.` : ""}</p>
      ) : null}

      {!requestor ? (
        <div className="row">
          {!ag && v.stage === "agreement" && legal ? <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void run("draft", () => api.post(`/api/requests/${id}/agreement`), "Agreement drafted")}>Draft the agreement</button> : null}
          {ag?.status === "draft" && legal ? <button type="button" className="btn" disabled={Boolean(busy) || missing.length > 0} onClick={() => void run("send", () => api.post(`/api/requests/${id}/agreement/send`), "Sent for signature")}>Send for signature</button> : null}
          {ag && v.certificationRequired && !ag.certifiedAt && hasRole(me, "medical-reviewer", "legal") ? <button type="button" className="btn quiet" disabled={Boolean(busy)} onClick={() => void run("certify", () => api.post(`/api/requests/${id}/agreement/certify`), "Certified")}>Certify as final signatory</button> : null}
          {ag && ["signed", "certified"].includes(ag.status) && v.stage === "agreement" && hasRole(me, "legal") ? <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void run("complete", () => api.post(`/api/requests/${id}/act`, { outcome: "complete" }), "Agreement executed; payment is next")}>Mark the agreement executed</button> : null}
        </div>
      ) : null}
      {err ? <p className="error-text" role="alert">{err}</p> : null}
    </section>
  );
}

/** Payment: the classification Finance confirms, the pre-payment gate, and the release by a named person. */
export function PaymentPanel({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const { me } = useMe();
  const toast = useToast();
  const p = useResource<PaymentDetail>(`/api/requests/${id}/payment`);
  const req = useResource<RequestPayload>(`/api/requests/${id}`);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [nature, setNature] = useState<string>();
  const [category, setCategory] = useState<string>();
  const finance = hasRole(me, "finance");
  const canClassify = hasRole(me, "finance", "tax");

  if (p.error?.status === 403) return null;
  if (p.error && !p.data) return <p className="error-text">{p.error.message}</p>;
  if (!p.data) return <p className="muted small">Opening the payment…</p>;
  const d = p.data;
  if (!d.payments.length && !d.transfers.length) return null;

  const f = req.data?.request.fields ?? {};
  const nat = f["tov.natureOfPayment"], cat = f["tov.disclosureCategory"];
  const natV = nature ?? String(nat?.value ?? ""), catV = category ?? String(cat?.value ?? "");
  const unconfirmed = [nat, cat].some((x) => x?.status === "proposed");
  const passed = d.gate.checks.filter((c) => c.status === "pass").length;

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key); setErr(undefined);
    try { await fn(); await Promise.all([p.refetch(), req.refetch()]); onChanged?.(); toast(ok); }
    catch (e) {
      if (e instanceof ApiError && e.status === 403 && key === "release") setErr("Only Finance can release a payment. You can see it here, but the release has to be made by a named person in Finance.");
      else setErr(errorText(e));
    } finally { setBusy(undefined); }
  }

  return (
    <section className="stack" style={{ gap: 18 }} aria-labelledby="h-pay">
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">Payment · gate G6 · payee is the organization</span>
        <h2 id="h-pay">Payment</h2>
      </div>

      {nat || cat ? (
        <form className="panel calm" onSubmit={(e) => { e.preventDefault(); void run("classify", () => api.post(`/api/requests/${id}/payment/classify`, { natureOfPayment: natV, disclosureCategory: catV }), "Classification confirmed"); }}>
          <div className="section-head">
            <h3>Transfer-of-value classification</h3>
            <span className={`chip ${unconfirmed ? "proposed" : "ok"}`}>{unconfirmed ? "Proposed by FundingEnvoy" : `Confirmed by ${nat?.confirmedBy?.name ?? "Finance"}`}</span>
          </div>
          <p className="muted small">Decides how this payment is reported in each disclosure. Finance confirms it before release.</p>
          <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
            <div className="stack" style={{ gap: 4, flex: "1 1 220px" }}>
              <label className="label" htmlFor="tov-n">Nature of payment</label>
              <input id="tov-n" className="input" value={natV} onChange={(e) => setNature(e.target.value)} disabled={!canClassify} />
              {nat?.source.note ? <span className="help">{nat.source.note}</span> : null}
            </div>
            <div className="stack" style={{ gap: 4, flex: "1 1 280px" }}>
              <label className="label" htmlFor="tov-c">Disclosure category</label>
              <input id="tov-c" className="input" value={catV} onChange={(e) => setCategory(e.target.value)} disabled={!canClassify} />
              {cat?.source.note ? <span className="help">{cat.source.note}</span> : null}
            </div>
          </div>
          {canClassify ? <div><button type="submit" className={`btn ${unconfirmed ? "" : "quiet"} small`} disabled={Boolean(busy)}>{unconfirmed ? "Confirm classification" : "Save changes"}</button></div> : null}
        </form>
      ) : null}

      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Pre-payment gate</span>
        {d.gate.blocking.length ? (
          <ul className="stack" style={{ gap: 4, paddingLeft: 18 }}>{d.gate.blocking.map((b) => <li key={b.ruleId} className="error-text">{b.text}</li>)}</ul>
        ) : <p className="small">{plural(passed, "check")} pass, including fresh screening, the signed agreement and the payee. {unconfirmed ? "The classification still needs Finance's confirmation." : "Nothing blocks the release."}</p>}
      </div>

      <div className="table-scroll">
        <table className="table">
          <thead><tr><th scope="col">Milestone</th><th scope="col" className="num">Amount</th><th scope="col">Booking</th><th scope="col">ERP</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {d.payments.map((x) => (
              <tr key={x.id}>
                <td>{x.milestone}. {x.label}<div className="help">Payee: {x.payee.organization} · vendor {x.payee.vendorId} · bank details on file in the ERP, never shown here</div></td>
                <td className="num">{fmtMoney(x.amount, x.currency)}</td>
                <td className="small">GL {x.gl_account}<div className="help">{x.tax_class ? humanize(x.tax_class) : ""}</div></td>
                <td className="mono tiny">{x.erp_refs.purchaseOrder ? `PO ${x.erp_refs.purchaseOrder}` : ""}{x.erp_refs.paymentRun ? <div>{x.erp_refs.paymentRun} · {x.erp_refs.document}</div> : null}</td>
                <td>
                  {x.status === "paid" ? <span className="chip ok">Paid {x.paid_at ? fmtDate(x.paid_at) : ""}</span> : (
                    <button type="button" className="btn small" disabled={Boolean(busy) || unconfirmed || d.gate.blocking.length > 0}
                      title={!finance ? "Only Finance can release" : undefined}
                      onClick={() => void run("release", () => api.post(`/api/requests/${id}/payments/${x.id}/release`), `Released ${fmtMoney(x.amount, x.currency)}`)}>Release payment</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!finance && d.payments.some((x) => x.status !== "paid") ? <p className="muted small">Release is locked to a named person in Finance.</p> : null}
      {err ? <p className="error-text" role="alert">{err}</p> : null}

      {d.transfers.length ? (
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Transfers of value recorded for disclosure</span>
          {d.transfers.map((t, i) => <p key={i} className="small">{t.regime} · {t.category} · {fmtMoney(t.amount, t.currency)} · period {t.period} · {t.state}</p>)}
        </div>
      ) : d.payments.some((x) => x.status === "paid") ? <p className="small muted">No disclosure regime applies to this payment (for example, a grant to an accredited provider is not reportable to Open Payments).</p> : null}
    </section>
  );
}

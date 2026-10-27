import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { hasRole, useMe, useToast } from "../lib/app";
import { fmtMoney, plural } from "../lib/format";
import { useDocumentTitle, useMediaQuery, useResource } from "../lib/hooks";
import type { Brief as BriefData, CommitteeMember, Desk } from "../lib/types";
import { Brief } from "../components/Brief";
import { EvidencePane, type EvidenceTarget } from "../components/EvidencePane";

/** The committee's agenda: one pack per request (judgement items, recommendation, checks) and the decision form. */
export function Committee() {
  const { me } = useMe();
  const words = me.tenant?.words?.committee ?? "Committee";
  useDocumentTitle(words);
  const { id } = useParams();
  const navigate = useNavigate();
  const desk = useResource<Desk>("/api/desk");
  const [evidence, setEvidence] = useState<EvidenceTarget>();
  const wide = useMediaQuery("(min-width: 1280px)");
  const phone = useMediaQuery("(max-width: 899px)");
  const all = desk.data ? [...desk.data.needsYou, ...desk.data.assistant, ...desk.data.waiting] : [];
  const agenda = all.filter((x) => x.stage === "committee");
  const decided = (desk.data?.done ?? []).filter((x) => x.status === "declined").concat(all.filter((x) => ["agreement", "payment"].includes(x.stage))).slice(0, 8);

  useEffect(() => { if (!id && !phone && agenda[0]) navigate(`/committee/${agenda[0].id}`, { replace: true }); }, [id, phone, agenda, navigate]);
  useEffect(() => setEvidence(undefined), [id]);
  const docked = Boolean(evidence) && wide;

  return (
    <div className={`desk ${docked ? "with-evidence" : ""}`} data-view={id ? "brief" : "queue"}>
      <nav className="queue" aria-label="Agenda">
        <div className="queue-scroll">
          <section className="queue-group" aria-labelledby="g-agenda">
            <h2 id="g-agenda">Agenda <span className="count">{agenda.length}</span></h2>
            {desk.error ? <p className="queue-empty error-text">{desk.error.message}</p> : null}
            {desk.data && !agenda.length ? <p className="queue-empty">Nothing is waiting for a decision. Requests arrive here after review.</p> : null}
            {agenda.map((x) => (
              <Link key={x.id} to={`/committee/${x.id}`} className="qrow" aria-current={x.id === id ? "true" : undefined}>
                <span className="top"><span className="t">{x.title}</span><span className="mono small">{x.amountLabel}</span></span>
                <span className="m">{x.organization}{x.subtype ? ` · ${x.subtype}` : ""}</span>
                <span className="chips">{x.forJudgement ? <span className="chip you">{x.forJudgement} for discussion</span> : null}<span className="chip ok">{x.passed} passed</span></span>
              </Link>
            ))}
          </section>
          {decided.length ? (
            <section className="queue-group" aria-labelledby="g-decided">
              <h2 id="g-decided">Recently decided <span className="count">{decided.length}</span></h2>
              {decided.map((x) => (
                <Link key={x.id} to={`/committee/${x.id}`} className="qrow" aria-current={x.id === id ? "true" : undefined}>
                  <span className="top"><span className="t">{x.title}</span><span className="mono small">{x.amountLabel}</span></span>
                  <span className="m">{x.organization} · {x.stageName}</span>
                </Link>
              ))}
            </section>
          ) : null}
        </div>
      </nav>
      <div className="brief">
        {id ? (
          <>
            {phone ? <p style={{ marginBottom: 16 }}><Link to="/committee">Back to the agenda</Link></p> : null}
            <Brief id={id} mode="committee" onEvidence={setEvidence} onChanged={() => void desk.refetch()}>
              {(b, refetch) => <DecisionForm b={b} onDone={async () => { await refetch(); await desk.refetch(); }} />}
            </Brief>
          </>
        ) : desk.data && !agenda.length ? (
          <div className="brief-inner"><span className="eyebrow">{words}</span><h1>No decisions waiting</h1><p className="lede">Each request comes here as a one-page pack once review is complete: the items for discussion first, then the recommendation and every check with its evidence.</p></div>
        ) : null}
      </div>
      {evidence ? <EvidencePane target={evidence} onClose={() => setEvidence(undefined)} docked={docked} /> : null}
    </div>
  );
}

type Outcome = "approve" | "approve-with-conditions" | "decline" | "defer";
type Vote = "for" | "against" | "abstain";

function DecisionForm({ b, onDone }: { b: BriefData; onDone: () => Promise<void> }) {
  const { me } = useMe();
  const toast = useToast();
  const member = hasRole(me, "committee-member", "committee-chair");
  const waiting = b.request.stage === "committee";
  const currency = (b.request.fields["amount.currency"]?.value as string | undefined) ?? "USD";
  const requested = Number(b.request.fields["amount.requested"]?.value ?? 0);
  const membersRes = useResource<CommitteeMember[]>(member && waiting ? "/api/committee/members" : undefined);
  const members = membersRes.data ?? [];

  const [outcome, setOutcome] = useState<Outcome>();
  const [amount, setAmount] = useState(String(requested || ""));
  const [conditions, setConditions] = useState("");
  const [rationale, setRationale] = useState("");
  const [votes, setVotes] = useState<Record<string, Vote | undefined>>({});
  const [recused, setRecused] = useState<Record<string, string | undefined>>({});
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const judged = b.judgement.filter((j) => j.decided?.note).map((j) => j.decided!.note!);
    if (judged.length && !conditions) setConditions(judged.join(" "));
  }, [b.judgement]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!waiting) return null; // the brief's header states any decision
  if (!member) {
    return <p className="muted small">Only a named committee member records the funding decision, with the votes, any recusals and a rationale. FundingEnvoy cannot.</p>;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!outcome) { setErr("Choose the outcome."); return; }
    if (!rationale.trim()) { setErr("Write the rationale. It is recorded with your name and goes to the requestor if the request is declined."); return; }
    if (outcome === "approve-with-conditions" && !conditions.trim()) { setErr("State the condition."); return; }
    const amt = Number(amount);
    if ((outcome === "approve" || outcome === "approve-with-conditions") && (!Number.isFinite(amt) || amt <= 0)) { setErr("Enter the approved amount."); return; }
    const recusals = Object.entries(recused).filter(([, r]) => r !== undefined).map(([memberId, reason]) => ({ memberId, reason: reason?.trim() || "Declared a conflict" }));
    if (recusals.some((r) => r.reason === "Declared a conflict" && !recused[r.memberId]?.trim())) { setErr("Give a reason for each recusal."); return; }
    setErr(undefined);
    setBusy(true);
    try {
      await api.post(`/api/requests/${b.request.id}/decision`, {
        outcome, amount: outcome.startsWith("approve") ? amt : undefined, conditions: outcome === "approve-with-conditions" ? conditions.trim() : undefined, rationale: rationale.trim(),
        votes: Object.entries(votes).filter(([m, v]) => v && recused[m] === undefined).map(([memberId, vote]) => ({ memberId, vote })),
        recusals,
      });
      toast("Decision recorded");
      await onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  const tally = (v: Vote) => Object.entries(votes).filter(([m, x]) => x === v && recused[m] === undefined).length;
  const OUTCOMES: [Outcome, string][] = [["approve", "Approve"], ["approve-with-conditions", "Approve with conditions"], ["decline", "Decline"], ["defer", "Defer"]];
  return (
    <form className="panel" onSubmit={submit} aria-labelledby="h-decide">
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Locked to a person · recorded with your name</span>
        <h2 id="h-decide">Record the committee's decision</h2>
        <p className="muted small">The decision, votes and recusals go on the record exactly as entered. The requestor is told the outcome, and the reason if it is declined.</p>
      </div>
      <fieldset className="fieldset">
        <legend className="label">Outcome</legend>
        <div className="seg" role="group" aria-label="Outcome">
          {OUTCOMES.map(([k, label]) => <button key={k} type="button" aria-pressed={outcome === k} onClick={() => setOutcome(k)}>{label}</button>)}
        </div>
      </fieldset>
      {outcome?.startsWith("approve") ? (
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <div className="stack" style={{ gap: 4, flex: "0 1 220px" }}>
            <label className="label" htmlFor="d-amount">Approved amount ({currency})</label>
            <input id="d-amount" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span className="help">Requested {fmtMoney(requested, currency)}</span>
          </div>
          {outcome === "approve-with-conditions" ? (
            <div className="stack" style={{ gap: 4, flex: "1 1 320px" }}>
              <label className="label" htmlFor="d-cond">Condition</label>
              <textarea id="d-cond" className="textarea" rows={2} style={{ minHeight: 64 }} value={conditions} onChange={(e) => setConditions(e.target.value)} />
              <span className="help">Written into the letter of agreement.</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="stack" style={{ gap: 4 }}>
        <label className="label" htmlFor="d-why">Rationale</label>
        <textarea id="d-why" className="textarea" rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Educational need, independence, budget and the items discussed" />
      </div>
      <fieldset className="fieldset">
        <legend className="label">Votes and recusals · {tally("for")} for, {tally("against")} against, {tally("abstain")} abstaining{Object.values(recused).filter((x) => x !== undefined).length ? `, ${plural(Object.values(recused).filter((x) => x !== undefined).length, "recusal")}` : ""}</legend>
        {membersRes.error ? <p className="error-text">{membersRes.error.message}</p> : null}
        <div className="members">
          {members.map((m) => {
            const isRecused = recused[m.id] !== undefined;
            return (
              <div key={m.id} className="member">
                <span className="who"><span>{m.name}{m.id === me.user.id ? " (you)" : ""}</span><span className="muted tiny">{m.title}</span></span>
                <span className="seg" role="group" aria-label={`Vote of ${m.name}`}>
                  {(["for", "against", "abstain"] as Vote[]).map((v) => (
                    <button key={v} type="button" disabled={isRecused} aria-pressed={votes[m.id] === v} onClick={() => setVotes((x) => ({ ...x, [m.id]: x[m.id] === v ? undefined : v }))}>{v === "for" ? "For" : v === "against" ? "Against" : "Abstain"}</button>
                  ))}
                </span>
                <span className="row" style={{ flexWrap: "nowrap" }}>
                  <label className="check small" style={{ flex: "0 0 auto" }}>
                    <input type="checkbox" checked={isRecused} onChange={(e) => setRecused((x) => ({ ...x, [m.id]: e.target.checked ? "" : undefined }))} />
                    <span>Recused</span>
                  </label>
                  {isRecused ? <input className="input small" aria-label={`Reason ${m.name} is recused`} placeholder="Reason" value={recused[m.id] ?? ""} onChange={(e) => setRecused((x) => ({ ...x, [m.id]: e.target.value }))} /> : null}
                </span>
              </div>
            );
          })}
        </div>
        <p className="help" style={{ marginTop: 6 }}>A recused member cannot vote.</p>
      </fieldset>
      {err ? <p className="error-text" role="alert">{err}</p> : null}
      <div><button type="submit" className="btn" disabled={busy}>{busy ? "Recording…" : "Record the decision"}</button></div>
    </form>
  );
}

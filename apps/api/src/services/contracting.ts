// Agreements, payments and transfers of value.
// Connectors (e-signature, ERP) run in simulated mode in the demo; their calls are recorded in the trail as
// connector actions with the payload a live connector would send, so swapping in DocuSign or SAP changes the
// adapter, not the workflow.
import { randomUUID } from "node:crypto";
import type { Actor, ClauseRequirement, DisclosureRegime, RequestState } from "@fe/core";
import { assertPersonForLockedAction, assertSeparationOfDuties, buildFacts, evaluate, formatDate, formatMoney, summarize, transition } from "@fe/core";
import { many, one, type Tx } from "@fe/db";
import { actorOf, asUser, HttpError, type SessionUser } from "../auth.ts";
import { addMessage, loadRequest, record, runChecks, saveState, setField, tenantSettings, type Loaded } from "./requests.ts";
import { createTask } from "./workflow.ts";
import { rescreen } from "./screening.ts";

export const ESIGN: Actor = { type: "connector", id: "esign-sim", name: "E-signature (simulated DocuSign)" };
export const ERP: Actor = { type: "connector", id: "erp-sim", name: "ERP (simulated SAP S/4HANA)" };

interface AgreementRow { id: string; template_id: string; clauses: ClauseRequirement[]; body: string; status: string; envelope_id: string | null; signatures: { party: string; name: string; at: string; userId?: string }[]; certified_by: string | null; certified_at: Date | null; created_at: Date }

function requiredClauses(l: Loaded): ClauseRequirement[] {
  const facts = buildFacts({ ...l.ctx, request: l.state });
  const selected = new Set(l.cfg.rulebookRaw.packs.map((p) => p.id));
  const out: ClauseRequirement[] = [];
  for (const p of l.cfg.packs.filter((x) => selected.has(x.id))) for (const c of p.clauses) if (evaluate(c.requiredWhen, facts)) out.push(c);
  return out;
}

export function certificationRequired(l: Loaded): boolean {
  return l.state.country === "GB";
}

export async function currentAgreement(tx: Tx, requestId: string): Promise<AgreementRow | undefined> {
  return one<AgreementRow>(tx, "select * from agreements where request_id = $1 and status <> 'void' order by created_at desc limit 1", [requestId]);
}

function snapshot(a: AgreementRow): NonNullable<RequestState["agreement"]> {
  return { templateId: a.template_id, signatures: a.signatures.map(({ party, name, at }) => ({ party, name, at })), certifiedAt: a.certified_at?.toISOString(), clauseIds: a.clauses.map((c) => c.id) };
}

/** Draft the letter of agreement from the applicable clause library. Allowed for the assistant at level 3 and above. */
export async function draftAgreement(tx: Tx, l: Loaded, by: Actor): Promise<AgreementRow> {
  const existing = await currentAgreement(tx, l.row.id);
  if (existing) return existing;
  const s = await tenantSettings(tx, l.row.tenant_id);
  const entity = (s.legalEntities as Record<string, string> | undefined)?.[l.state.country] ?? "Halden Pharma";
  const clauses = requiredClauses(l);
  const amount = l.state.decision?.amount ?? (l.state.fields["amount.requested"]?.value as number);
  const cur = (l.state.fields["amount.currency"]?.value as string) ?? "USD";
  const signer = l.org.signers[0];
  const templateId = `halden-${l.state.country.toLowerCase()}-${l.state.family ?? "grant"}-v1`;
  const body = [
    `# Letter of agreement · ${l.row.ref}`,
    `Between **${entity}** ("the Company") and **${l.org.legalName}** ("the Organization").`,
    "",
    `**Support:** ${formatMoney(amount, cur)} for "${String(l.state.fields.title?.value ?? "the activity")}"${l.state.fields["activity.startDate"] ? `, ${formatDate(l.state.fields["activity.startDate"].value)} to ${formatDate(l.state.fields["activity.endDate"]?.value)}` : ""}.`,
    l.state.decision?.conditions ? `**Condition set by the committee:** ${l.state.decision.conditions}` : "",
    `**Authorized signer for the Organization:** ${signer ? `${signer.name}, ${signer.title}` : "to be named"}.`,
    "",
    ...clauses.map((c, i) => `${i + 1}. **${c.label}.** ${c.text}`),
  ].filter((x) => x !== "").join("\n");
  const row = await one<AgreementRow>(tx, "insert into agreements (tenant_id, request_id, template_id, clauses, body, status) values ($1,$2,$3,$4,$5,'draft') returning *",
    [l.row.tenant_id, l.row.id, templateId, JSON.stringify(clauses), body]);
  await record(tx, { tenantId: l.row.tenant_id, actor: by, entity: { type: "request", id: l.row.id }, action: "agreement.drafted", data: { requestId: l.row.id, agreementId: row!.id, templateId, clauses: clauses.map((c) => c.id) },
    ...(by.type === "agent" ? { ai: { provider: "platform", model: "clause-library", promptVersion: "n/a", inputHashes: [], outputHash: "", gate: { stage: "agreement", level: 3, outcome: "held-for-person" } } } : {}) });
  await saveState(tx, l, { agreement: snapshot(row!) });
  return row!;
}

/** The party a person may sign for: the organization's authorized signer, or Legal for the company. */
async function sideFor(tx: Tx, u: SessionUser, l: Loaded): Promise<string | undefined> {
  if (u.kind === "requestor") return u.roles.includes("org-admin") ? l.org.legalName : undefined;
  if (!u.roles.includes("legal")) return undefined;
  return ((await tenantSettings(tx, l.row.tenant_id)).legalEntities as Record<string, string> | undefined)?.[l.state.country] ?? "Company";
}

export async function agreementView(u: SessionUser, requestId: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const a = await currentAgreement(tx, requestId);
    const req = requiredClauses(l);
    const present = new Set((a?.clauses ?? []).map((c) => c.id));
    const mySide = await sideFor(tx, u, l);
    const canSign = Boolean(a && a.status === "sent" && mySide && !a.signatures.some((s) => s.party === mySide));
    return {
      mySide, canSign,
      sides: { organization: l.org.legalName, company: ((await tenantSettings(tx, l.row.tenant_id)).legalEntities as Record<string, string> | undefined)?.[l.state.country] ?? "Company" },
      agreement: a ? { ...a, certifiedAt: a.certified_at?.toISOString() } : undefined,
      requiredClauses: req.map((c) => ({ id: c.id, label: c.label, basis: c.basis, present: present.has(c.id) })),
      certificationRequired: certificationRequired(l), signer: l.org.signers[0], stage: l.state.stage,
    };
  });
}

export async function createAgreement(u: SessionUser, requestId: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    if (l.state.stage !== "agreement") throw new HttpError(409, "An agreement is drafted after the funding decision.");
    return draftAgreement(tx, l, actorOf(u));
  });
}

export async function sendAgreement(u: SessionUser, requestId: string) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const a = await currentAgreement(tx, requestId) ?? await draftAgreement(tx, l, actorOf(u));
    if (a.status !== "draft") throw new HttpError(409, "This agreement has already been sent.");
    const missing = requiredClauses(l).filter((c) => !a.clauses.some((x) => x.id === c.id));
    if (missing.length) throw new HttpError(409, `The agreement is missing required clauses: ${missing.map((c) => c.label).join(", ")}. Regenerate it before sending.`);
    const envelopeId = `sim-env-${randomUUID().slice(0, 8)}`;
    const signer = l.org.signers[0];
    await tx.query("update agreements set status = 'sent', envelope_id = $2 where id = $1", [a.id, envelopeId]);
    await record(tx, { tenantId: l.row.tenant_id, actor: actorOf(u), entity: { type: "request", id: l.row.id }, action: "agreement.sent", data: { requestId: l.row.id, agreementId: a.id } });
    await record(tx, { tenantId: l.row.tenant_id, actor: ESIGN, entity: { type: "request", id: l.row.id }, action: "connector.esign.envelope-created", data: { requestId: l.row.id, envelopeId, recipients: [{ role: "Organization", name: signer?.name, email: signer?.email }, { role: "Company", name: u.name }], simulated: true } });
    if (signer) await tx.query("insert into outbox (tenant_id, to_email, subject, body) values ($1,$2,$3,$4)", [l.row.tenant_id, signer.email, `Please sign: agreement for ${l.row.ref}`, `Signing link (demo): /requests/${l.row.id}/agreement`]);
    const s = await tenantSettings(tx, l.row.tenant_id);
    await addMessage(tx, l, { type: "agent", id: "fundingenvoy", name: (s.words as { assistantName?: string })?.assistantName ?? "FundingEnvoy" },
      `The letter of agreement is out for e-signature${signer ? ` to ${signer.name}` : ""}. It has to be signed by both sides before the activity starts.`, { agreement: a.id });
  });
}

/** A signature is a locked action: a named person of the right side signs. */
export async function signAgreement(u: SessionUser, requestId: string, typedName: string) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const a = await currentAgreement(tx, requestId);
    if (!a || a.status !== "sent") throw new HttpError(409, "There is no agreement waiting for signature.");
    const me = actorOf(u);
    try { assertPersonForLockedAction("sign-agreement", me); } catch (e) { throw new HttpError(403, (e as Error).message); }
    if (typedName.trim().toLowerCase() !== u.name.trim().toLowerCase()) throw new HttpError(400, `Type your full name exactly as "${u.name}" to sign.`);
    const side = await sideFor(tx, u, l);
    if (!side) throw new HttpError(403, u.kind === "requestor" ? "Only the organization's authorized signer can sign." : "The company's signature is given by Legal.");
    if (a.signatures.some((s) => s.party === side)) throw new HttpError(409, `${side} has already signed.`);
    const at = new Date().toISOString();
    const signatures = [...a.signatures, { party: side, name: u.name, at, userId: u.id }];
    const complete = signatures.length >= 2;
    await tx.query("update agreements set signatures = $2, status = $3 where id = $1", [a.id, JSON.stringify(signatures), complete ? "signed" : "sent"]);
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "agreement.signed", data: { requestId: l.row.id, agreementId: a.id, party: side, typedName, meaning: "I agree to the terms of this agreement on behalf of the party named." } });
    if (complete) await record(tx, { tenantId: l.row.tenant_id, actor: ESIGN, entity: { type: "request", id: l.row.id }, action: "connector.esign.envelope-completed", data: { requestId: l.row.id, envelopeId: a.envelope_id, simulated: true } });
    const updated = (await currentAgreement(tx, requestId))!;
    await saveState(tx, l, { agreement: snapshot(updated) });
    if (complete) {
      const needCert = certificationRequired(l) && !updated.certified_at;
      await createTask(tx, l, "agreement", needCert ? `${l.row.ref}: certify the agreement (final signatory)` : `${l.row.ref}: agreement signed by both sides; mark executed`, needCert ? "medical-reviewer" : "legal");
    }
  });
}

export async function certifyAgreement(u: SessionUser, requestId: string) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const a = await currentAgreement(tx, requestId);
    if (!a) throw new HttpError(409, "There is no agreement to certify.");
    if (!(u.attributes.finalSignatory === true)) throw new HttpError(403, "Only a named final signatory can certify (ABPI Clause 8.3).");
    if (a.certified_at) throw new HttpError(409, "Already certified.");
    await tx.query("update agreements set certified_by = $2, certified_at = now(), status = case when status = 'signed' then 'certified' else status end where id = $1", [a.id, u.id]);
    await record(tx, { tenantId: l.row.tenant_id, actor: actorOf(u), entity: { type: "request", id: l.row.id }, action: "agreement.certified", data: { requestId: l.row.id, agreementId: a.id, clauses: a.clauses.map((c) => c.id), meaning: "I certify that this agreement complies with the Code." } });
    await saveState(tx, l, { agreement: snapshot((await currentAgreement(tx, requestId))!) });
  });
}

// ─── Payment ────────────────────────────────────────────────────────────────

interface PaymentRow { id: string; milestone: number; label: string; amount: number; currency: string; status: string; gl_account: string | null; tax_class: string | null; payee: Record<string, unknown>; erp_refs: Record<string, unknown>; released_by: string | null; released_at: Date | null; paid_at: Date | null }

/** On entering the payment stage: payment schedule, vendor and purchase order prepared in the ERP. */
export async function preparePayment(tx: Tx, l: Loaded): Promise<void> {
  const existing = await one<{ n: number }>(tx, "select count(*)::int as n from payments where request_id = $1", [l.row.id]);
  if (existing?.n) return;
  const amount = l.state.decision?.amount ?? (l.state.fields["amount.requested"]?.value as number);
  const cur = (l.state.fields["amount.currency"]?.value as string) ?? "USD";
  const vendorId = `V${(l.org.identifiers.ein ?? l.org.identifiers.charityNumber ?? l.org.identifiers.siren ?? l.org.id).replace(/\D/g, "").slice(-7).padStart(7, "0")}`;
  const po = `45${String(Date.now()).slice(-8)}`;
  const gl = l.state.family === "charitable" ? "650200 Charitable contributions" : "650100 Educational grants";
  const taxClass = l.state.family === "charitable" ? "charitable-contribution" : "business-expense-grant";
  const payee = { organization: l.org.legalName, vendorId, verifiedAccount: "On file in ERP vendor master (never shown here)" };
  await tx.query("insert into payments (tenant_id, request_id, milestone, label, amount, currency, status, gl_account, tax_class, payee, erp_refs) values ($1,$2,1,'On execution of the agreement',$3,$4,'ready',$5,$6,$7,$8)",
    [l.row.tenant_id, l.row.id, amount, cur, gl, taxClass, JSON.stringify(payee), JSON.stringify({ vendorId, purchaseOrder: po })]);
  await record(tx, { tenantId: l.row.tenant_id, actor: ERP, entity: { type: "request", id: l.row.id }, action: "connector.erp.vendor-matched", data: { requestId: l.row.id, vendorId, by: "tax identifier", simulated: true } });
  await record(tx, { tenantId: l.row.tenant_id, actor: ERP, entity: { type: "request", id: l.row.id }, action: "connector.erp.po-created", data: { requestId: l.row.id, purchaseOrder: po, amount, currency: cur, glAccount: gl, simulated: true } });
  // Gate G6: propose the transfer-of-value classification from the catalogue; Finance confirms it before release.
  const nature = l.state.family === "charitable" ? "charitable-contribution" : l.org.type === "teaching-hospital" ? "grant" : "grant-to-organization";
  const regimes = Object.entries(l.subtype?.disclosureCategory ?? {}).map(([k, v]) => `${k}: ${v}`).join("; ") || "donations-grants-hco";
  const fe: Actor = { type: "agent", id: "fundingenvoy", name: "FundingEnvoy" };
  l.state = setField(setField(l.state, "tov.natureOfPayment", { value: nature, status: "proposed", source: { kind: "derived", note: "From the request type and recipient type" }, proposedBy: fe }, fe),
    "tov.disclosureCategory", { value: regimes, status: "proposed", source: { kind: "derived", note: "From the catalogue's disclosure mapping" }, proposedBy: fe }, fe);
  await saveState(tx, l);
  await record(tx, { tenantId: l.row.tenant_id, actor: fe, entity: { type: "request", id: l.row.id }, action: "assistant.tov-proposed", data: { requestId: l.row.id, natureOfPayment: nature, disclosureCategory: regimes },
    ai: { provider: "platform", model: "catalogue-mapping", promptVersion: "n/a", inputHashes: [], outputHash: "", gate: { stage: "payment", level: 2, outcome: "proposed" } } });
  await createTask(tx, l, "payment", `${l.row.ref}: confirm the transfer-of-value classification and release ${formatMoney(amount, cur)}`, "finance");
}

export async function classifyTransfer(u: SessionUser, requestId: string, input: { natureOfPayment: string; disclosureCategory: string }) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const me = actorOf(u);
    for (const [k, v] of [["tov.natureOfPayment", input.natureOfPayment], ["tov.disclosureCategory", input.disclosureCategory]] as const) {
      const cur = l.state.fields[k];
      const changed = cur && cur.value !== v;
      l.state = setField(l.state, k, { value: v, status: changed ? "changed" : "confirmed", source: cur?.source ?? { kind: "form" } }, me, changed ? "Finance reclassified" : undefined);
    }
    await saveState(tx, l);
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "tov.classified", data: { requestId: l.row.id, ...input } });
  });
}

export async function paymentGate(tx: Tx, l: Loaded) {
  await rescreen(tx, l.row.tenant_id, l.row.org_id, "pre-payment", l.row.id);
  const fresh = await loadRequest(tx, l.row.id);
  const checks = runChecks(fresh, "pre-payment");
  const blocking = checks.filter((c) => (c.status === "fail" || c.status === "pending") && c.severity === "block");
  return { checks, blocking, l: fresh };
}

export async function releasePayment(u: SessionUser, requestId: string, paymentId: string) {
  await asUser(u, async (tx) => {
    const l0 = await loadRequest(tx, requestId);
    const me = actorOf(u);
    const stage = l0.cfg.workflow.stages.find((s) => s.id === l0.state.stage);
    const outcome = stage?.outcomes.find((o) => o.locked === "release-payment");
    if (!stage || !outcome) throw new HttpError(409, "This request is not waiting for payment.");
    const routedBy = await one<{ actor: { id: string } }>(tx, "select actor from events where tenant_id = $1 and request_id = $2 and action = 'stage.advanced' and data->>'from' = 'triage' and actor->>'type' = 'person' order by seq desc limit 1", [l0.row.tenant_id, requestId]);
    try {
      assertPersonForLockedAction("release-payment", me, outcome.actorRoles);
      assertSeparationOfDuties("release-payment", me, { routedBy: routedBy?.actor.id, requestedBy: l0.row.requestor_id });
    } catch (e) { throw new HttpError(403, (e as Error).message, "gate"); }
    const { blocking, checks, l } = await paymentGate(tx, l0);
    const unconfirmed = ["tov.natureOfPayment", "tov.disclosureCategory"].filter((k) => l.state.fields[k]?.status === "proposed");
    if (unconfirmed.length) throw new HttpError(409, "Confirm the transfer-of-value classification before releasing payment.", "payment-gate");
    if (blocking.length) throw new HttpError(409, `Payment is blocked: ${blocking.map((c) => c.message).join(" ")}`, "payment-gate");
    const p = await one<PaymentRow>(tx, "select * from payments where id = $1 and request_id = $2", [paymentId, requestId]);
    if (!p || p.status !== "ready") throw new HttpError(409, "This payment is not ready for release.");
    const now = new Date().toISOString();
    await tx.query("update payments set status = 'paid', released_by = $2, released_at = now(), paid_at = now(), erp_refs = erp_refs || $3 where id = $1", [p.id, u.id, JSON.stringify({ paymentRun: `F110-${now.slice(0, 10)}`, document: `51${String(Date.now()).slice(-8)}` })]);
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "payment.released", data: { requestId: l.row.id, paymentId: p.id, amount: p.amount, currency: p.currency, glAccount: p.gl_account, taxClass: p.tax_class, gate: checks.filter((c) => c.status === "pass").map((c) => c.ruleId) } });
    await record(tx, { tenantId: l.row.tenant_id, actor: ERP, entity: { type: "request", id: l.row.id }, action: "connector.erp.paid", data: { requestId: l.row.id, paymentId: p.id, simulated: true } });
    const regimes = await recordTransfers(tx, l, p);
    const t = transition({ wf: l.cfg.workflow, currentStageId: stage.id, outcomeId: outcome.id, actor: me, facts: buildFacts({ ...l.ctx, request: l.state }) });
    await saveState(tx, l, { stage: t.to, status: t.status });
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "stage.advanced", data: { requestId: l.row.id, from: t.from, to: t.to, outcome: outcome.id, transfersOfValue: regimes } });
    await tx.query("update tasks set status = 'done', completed_at = now() where request_id = $1 and kind = 'payment' and status = 'open'", [l.row.id]);
  });
}

/** Record the transfer of value for every disclosure regime that applies, at the time of payment (SOP 9.2). */
async function recordTransfers(tx: Tx, l: Loaded, p: PaymentRow): Promise<string[]> {
  const facts = buildFacts({ ...l.ctx, request: l.state });
  const selected = new Set(l.cfg.rulebookRaw.packs.map((x) => x.id));
  const regimes: DisclosureRegime[] = l.cfg.packs.filter((x) => selected.has(x.id)).flatMap((x) => x.disclosures).filter((d) => evaluate(d.appliesWhen, facts));
  const out: string[] = [];
  for (const r of regimes) {
    let category = l.subtype?.disclosureCategory?.[r.id] ?? "donations-grants";
    if (r.id === "open-payments") {
      const teaching = l.org.type === "teaching-hospital";
      if (!teaching) continue; // CME provider or non-covered recipient: not reportable (42 CFR 403.904, indirect-payment test)
      category = l.state.family === "charitable" ? "charitable-contribution" : "grant";
    }
    const period = r.id === "transparence-sante" ? `${p.paid_at?.toISOString().slice(0, 4) ?? new Date().getUTCFullYear()}-H${new Date().getUTCMonth() < 6 ? 1 : 2}` : String(new Date().getUTCFullYear());
    await tx.query("insert into transfers_of_value (tenant_id, request_id, payment_id, regime, category, recipient, amount, currency, period, data) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [l.row.tenant_id, l.row.id, p.id, r.id, category, JSON.stringify({ name: l.org.legalName, type: l.org.type, country: l.org.country, identifiers: l.org.identifiers, address: l.org.address }), p.amount, p.currency, period, JSON.stringify({ ref: l.row.ref, subtype: l.state.subtype, title: l.state.fields.title?.value })]);
    out.push(r.id);
  }
  return out;
}

export async function paymentsList(u: SessionUser) {
  return asUser(u, async (tx) => many<PaymentRow & { ref: string; title: string | null; org: string; request_id: string }>(tx, `
    select p.*, r.ref, r.title, o.legal_name as org, r.id as request_id from payments p join requests r on r.id = p.request_id join organizations o on o.id = r.org_id
    where p.tenant_id = $1 order by p.created_at desc`, [u.tenantId]));
}

export async function paymentDetail(u: SessionUser, requestId: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const payments = await many<PaymentRow>(tx, "select * from payments where request_id = $1 order by milestone", [requestId]);
    const checks = runChecks(l, "pre-payment").filter((c) => c.status !== "na");
    const s = summarize(checks);
    return { payments, gate: { blocking: s.mustFix.map((c) => ({ ruleId: c.ruleId, text: c.message })), checks }, transfers: await many(tx, "select regime, category, amount, currency, period, state from transfers_of_value where request_id = $1", [requestId]) };
  });
}

// ─── Reconciliation and outcomes ────────────────────────────────────────────

export async function submitReconciliation(u: SessionUser, requestId: string, input: { actualTotal: number; attendees?: number; unusedFunds: number; notes?: string; outcomesSummary?: string }) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    if (!["reconciliation", "outcomes"].includes(l.state.stage)) throw new HttpError(409, "Reconciliation opens after payment.");
    const rec = { ...input, by: actorOf(u), at: new Date().toISOString() };
    const key = l.state.stage === "outcomes" ? "outcomes.report" : "reconciliation.report";
    l.state = { ...l.state, fields: { ...l.state.fields, [key]: { value: rec, status: "confirmed", source: { kind: "form" }, confirmedBy: actorOf(u), confirmedAt: rec.at } } };
    await saveState(tx, l);
    await record(tx, { tenantId: l.row.tenant_id, actor: actorOf(u), entity: { type: "request", id: l.row.id }, action: l.state.stage === "outcomes" ? "outcomes.submitted" : "reconciliation.submitted", data: { requestId: l.row.id, ...input } });
    await createTask(tx, l, l.state.stage, `${l.row.ref}: review the ${l.state.stage === "outcomes" ? "outcomes report" : "reconciliation"}`, "coordinator");
  });
}

/** Steps the assistant takes on entering downstream stages, at its level. */
export async function onEnterStage(tx: Tx, l: Loaded): Promise<void> {
  if (l.state.stage === "agreement") {
    const s = await tenantSettings(tx, l.row.tenant_id);
    const fe: Actor = { type: "agent", id: "fundingenvoy", name: (s.words as { assistantName?: string })?.assistantName ?? "FundingEnvoy" };
    await draftAgreement(tx, l, fe);
    await createTask(tx, l, "agreement", `${l.row.ref}: review the drafted agreement and send for signature`, "legal");
  }
  if (l.state.stage === "payment") await preparePayment(tx, l);
}

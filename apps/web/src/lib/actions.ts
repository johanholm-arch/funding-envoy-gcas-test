import type { AuditEvent } from "./types";
import { fmtMoney, humanize, plural } from "./format";

type D = Record<string, unknown>;
const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** Audit action ids as sentences, with the details a reader needs. */
export function describe(e: AuditEvent, fieldLabel: (k: string) => string = (k) => k): { what: string; detail?: string } {
  const d = (e.data ?? {}) as D;
  const fv = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : typeof v === "object" ? JSON.stringify(v) : s(v));
  switch (e.action) {
    case "request.started": return { what: `Started a request (draft ${s(d.ref)})`, detail: d.versions ? `Rulebook v${s((d.versions as D).rulebook)} · workflow v${s((d.versions as D).workflow)} · catalogue v${s((d.versions as D).catalogue)}` : undefined };
    case "request.submitted": return { what: `Submitted as ${s(d.ref)}`, detail: `Confirmation shown and accepted · ${s(d.from)} → ${s(d.to)}${list(d.flags).length ? ` · submitted with ${plural(list(d.flags).length, "flag")} (${list(d.flags).join(", ")})` : ""}` };
    case "request.type-confirmed": return { what: "Confirmed the request type", detail: humanize(s(d.subtype)) };
    case "message.sent": return { what: "Wrote to the assistant", detail: `${s(d.chars)} characters · the text is kept with the request` };
    case "document.uploaded": return { what: `Uploaded ${s(d.name)}`, detail: `${humanize(s(d.type))} · ${plural(Number(d.pages ?? 0), "page")} · sha256 …${s(d.sha256).slice(-6)}` };
    case "field.answered": return { what: `Answered ${fieldLabel(s(d.key))}`, detail: fv(d.value) };
    case "field.set": return { what: `Set ${fieldLabel(s(d.key))}`, detail: fv(d.value) };
    case "field.changed": return { what: `Changed ${fieldLabel(s(d.key))}${d.previous !== undefined ? ` from ${fv(d.previous)}` : ""} to ${fv(d.value)}`, detail: d.reason ? `Reason typed: "${s(d.reason)}" · previous value kept` : "Previous value kept" };
    case "field.confirmed": return { what: `Confirmed ${fieldLabel(s(d.key))}`, detail: fv(d.value) };
    case "field.confirmed-all": return { what: `Confirmed ${plural(list(d.keys).length, "proposed value")}`, detail: list(d.keys).map(fieldLabel).join(", ") };
    case "budget.line-removed": return { what: `Removed budget line ${s((d.line as D)?.line)}`, detail: `${s((d.line as D)?.description)} · ${fv((d.line as D)?.amount)}` };
    case "coi.answered": return { what: `Answered conflict-of-interest question ${s(d.questionId).replace("coi-", "")}: ${s(d.answer)}`, detail: d.detail ? `"${s(d.detail)}"` : "Recorded as the requestor's own answer" };
    case "attestation.made": return { what: `Made the statement "${humanize(s(d.attestation))}"`, detail: `${d.typedName ? `Typed "${s(d.typedName)}"` : "Ticked"} · wording version ${s(d.version)} · recorded verbatim, not editable` };
    case "flag.acknowledged": return { what: `Chose to ${s(d.choice) === "keep-and-explain" ? "keep and explain" : "submit with the flag"} on ${s(d.ruleId)}`, detail: d.note ? `Note: "${s(d.note)}"` : undefined };
    case "screening.run": return { what: `Screened the organization against ${plural(list((d.lists as D[] | undefined)?.map((x) => x.list)).length, "list")}`, detail: `${((d.lists as D[] | undefined) ?? []).map((x) => `${s(x.list)} ${s(x.version)}: ${s(x.result)}`).join(" · ")} · reason: ${s(d.reason)}${d.simulated ? " · simulated lists" : ""}` };
    case "stage.advanced": return { what: `Moved from ${humanize(s(d.from))} to ${humanize(s(d.to))}`, detail: [d.outcome ? `Outcome: ${humanize(s(d.outcome))}` : "", d.reason ? `Reason: "${s(d.reason)}"` : "", d.reviewingGroup ? `Group: ${s((d.reviewingGroup as D).label)}` : "", list(d.skipped).length ? `Skipped: ${list(d.skipped).map(humanize).join(", ")}` : ""].filter(Boolean).join(" · ") || undefined };
    case "triage.proposed": return { what: `Proposed routing to ${humanize(s(d.group))}`, detail: `Rule ${s(d.rule)} · held for a person to confirm` };
    case "triage.applied": return { what: `Routed to ${humanize(s(d.group))}`, detail: `Rule ${s(d.rule)} · applied within the assistant's level; a coordinator can change it` };
    case "judgement.recorded": return { what: `Judged ${s(d.ruleId)}: ${humanize(s(d.decision))}`, detail: d.note ? `Note: "${s(d.note)}"` : undefined };
    case "info.requested": return { what: `Requested information (${plural(list(d.questions).length, "question")})`, detail: `${list(d.questions).map((q) => `"${q}"`).join(" ")}${d.dueAt ? ` · due ${s(d.dueAt)}` : ""}` };
    case "info.answered": return { what: "Answered the information request", detail: ((d.answers as D[] | undefined) ?? []).map((a) => `"${s(a.answer)}"`).join(" ") };
    case "info.partially-answered": return { what: "Answered part of the information request", detail: ((d.answers as D[] | undefined) ?? []).map((a) => `"${s(a.answer)}"`).join(" ") };
    case "decision.recorded": return { what: `Recorded the funding decision: ${humanize(s(d.outcome))}${d.amount ? ` ${fmtMoney(d.amount)}` : ""}`, detail: [`Rationale: "${s(d.rationale)}"`, d.conditions ? `Condition: ${s(d.conditions)}` : "", list((d.votes as D[] | undefined)?.map((v) => `${s(v.name ?? v.memberId)} ${s(v.vote)}`)).length ? `Votes: ${((d.votes as D[]) ?? []).map((v) => `${s(v.name ?? v.memberId)} ${s(v.vote)}`).join(", ")}` : "", ((d.recusals as D[] | undefined) ?? []).length ? `Recused: ${((d.recusals as D[]) ?? []).map((r) => `${s(r.name ?? r.memberId)} (${s(r.reason)})`).join(", ")}` : ""].filter(Boolean).join(" · ") };
    case "agreement.drafted": return { what: "Drafted the letter of agreement", detail: `Template ${s(d.templateId)} · ${plural(list(d.clauses).length, "required clause")}` };
    case "agreement.sent": return { what: "Sent the agreement for signature" };
    case "agreement.signed": return { what: `Signed the agreement for ${s(d.party)}`, detail: `Typed "${s(d.typedName)}" · meaning: ${s(d.meaning)}` };
    case "agreement.certified": return { what: "Certified the agreement as final signatory", detail: s(d.meaning) };
    case "payment.released": return { what: `Released payment of ${fmtMoney(d.amount, s(d.currency) || "USD")}`, detail: `GL ${s(d.glAccount)} · tax class ${humanize(s(d.taxClass))} · pre-payment gate passed (${list(d.gate).length} checks)` };
    case "tov.classified": return { what: "Confirmed the transfer-of-value classification", detail: `${humanize(s(d.natureOfPayment))} · ${s(d.disclosureCategory)}` };
    case "reconciliation.submitted": return { what: "Sent the reconciliation", detail: `Spent ${fv(d.actualTotal)} · unused ${fv(d.unusedFunds)}${d.attendees ? ` · ${s(d.attendees)} attended` : ""}` };
    case "outcomes.submitted": return { what: "Sent the outcomes report", detail: s(d.outcomesSummary) };
    case "disclosure.submitted": return { what: `Submitted the ${s(d.regime)} disclosure for ${s(d.period)}`, detail: `${s(d.records)} records` };
    case "connector.esign.envelope-created": return { what: "E-signature envelope created", detail: `Envelope ${s(d.envelopeId)}${d.simulated ? " · simulated" : ""}` };
    case "connector.esign.envelope-completed": return { what: "E-signature envelope completed", detail: `Envelope ${s(d.envelopeId)}${d.simulated ? " · simulated" : ""}` };
    case "connector.erp.vendor-matched": return { what: `Vendor matched in the ERP (${s(d.vendorId)})`, detail: `By ${s(d.by)}${d.simulated ? " · simulated" : ""}` };
    case "connector.erp.po-created": return { what: `Purchase order ${s(d.purchaseOrder)} created`, detail: `${fv(d.amount)} ${s(d.currency)} · GL ${s(d.glAccount)}${d.simulated ? " · simulated" : ""}` };
    case "connector.erp.paid": return { what: "Payment confirmed by the ERP", detail: d.simulated ? "Simulated" : undefined };
    case "assistant.read-message": return { what: `Read the requestor's message and recorded ${plural(list(d.keys).length, "value")}`, detail: list(d.keys).map(fieldLabel).join(", ") };
    case "assistant.classified": return { what: `Suggested the request type: ${humanize(s(d.subtype))}`, detail: list(d.reasons).length ? `Reasons: ${list(d.reasons).join("; ")}` : "Asked the requestor to confirm" };
    case "assistant.classified-document": return { what: `Recognised ${s(d.name)} as ${humanize(s(d.type))}`, detail: s(d.reason) || undefined };
    case "assistant.extracted": return { what: `Proposed ${plural(Number(d.proposed ?? 0), "value")} from ${plural(list(d.documentIds).length, "document")}`, detail: `All marked "proposed" until confirmed${Number(d.budgetLines) ? ` · read ${s(d.budgetLines)} budget lines` : ""}${list(d.conflicts).length ? ` · documents disagree on ${list(d.conflicts).map(fieldLabel).join(", ")}` : ""}` };
    case "assistant.policy-answer": return { what: d.declined ? "Declined a question outside the policy" : "Answered a policy question", detail: `"${s(d.question)}"${list(d.citations).length ? ` · cited ${list(d.citations).join(", ")}` : ""}` };
    case "assistant.declined": return { what: "Declined to answer", detail: `Reason: ${humanize(s(d.reason))}` };
    case "assistant.review-summary": return { what: "Attached the pre-submission review summary", detail: `${s(d.checks)} checks · ${s(d.passed)} passed · ${s(d.forReviewer)} for a person` };
    case "assistant.what-changed": return { what: "Wrote the \"what changed\" note for the reviewer", detail: s(d.note) };
    case "assistant.completeness-checked": return { what: "Checked completeness", detail: `${s(d.passed)} checks passed · held for a person to confirm` };
    case "assistant.tov-proposed": return { what: "Proposed the transfer-of-value classification", detail: `${humanize(s(d.natureOfPayment))} · ${s(d.disclosureCategory)} · Finance confirms before release` };
    default: return { what: humanize(e.action.replace(/\./g, " ")), detail: e.data ? Object.entries(e.data).filter(([k]) => k !== "requestId").map(([k, v]) => `${k}: ${fv(v)}`).join(" · ") : undefined };
  }
}

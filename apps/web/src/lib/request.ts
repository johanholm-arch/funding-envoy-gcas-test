import type { ActionHint, CheckResult, FieldDef, RequestStatus, RequestView } from "./types";
import { fmtDate } from "./format";

const COUNTRIES: Record<string, string> = { US: "United States", GB: "United Kingdom", FR: "France", DE: "Germany", BE: "Belgium", NL: "Netherlands", KR: "Korea", IN: "India", CN: "China" };
export const countryName = (c: string) => COUNTRIES[c] ?? c;

const ORG_TYPES: Record<string, string> = {
  association: "Association or society", hospital: "Hospital", "teaching-hospital": "Teaching hospital", university: "University",
  "patient-organization": "Patient organization", charity: "Charity", "accredited-provider": "Accredited education provider",
  "medical-education-company": "Medical education company", government: "Government body", individual: "Individual",
};
export const orgTypeName = (t: string) => ORG_TYPES[t] ?? t;

/** A plain-language status sentence, with dates. */
export function statusSentence(v: RequestView): string {
  const r = v.request;
  const weeks = v.subtype?.typicalDecisionWeeks;
  const sub = r.submittedAt ? fmtDate(r.submittedAt) : undefined;
  const map: Partial<Record<RequestStatus, string>> = {
    draft: "Draft. Nothing has been sent.",
    submitted: `Submitted${sub ? ` on ${sub}` : ""}. A coordinator will pick it up shortly.`,
    "in-review": `Being reviewed (${v.stage.name.toLowerCase()} since ${fmtDate(v.stage.enteredAt)}).${weeks ? ` Decisions for this type usually take ${weeks[0]} to ${weeks[1]} weeks${sub ? ` from ${sub}` : ""}.` : ""}`,
    "info-requested": "The grants team has a question for you. Only their questions are open; the rest of your request stays as it is.",
    committee: `With the committee for a decision, since ${fmtDate(v.stage.enteredAt)}.`,
    approved: "Approved.",
    agreement: "Approved. The letter of agreement is being prepared or is out for signature.",
    payment: "Agreement signed. Payment is being released.",
    active: "Funded. The activity is under way.",
    reconciliation: "Reconciliation is due: tell the funder how the funds were used.",
    outcomes: "The outcomes report is due.",
    declined: `Not funded${r.decidedAt ? ` (decided ${fmtDate(r.decidedAt)})` : ""}.${r.decision?.rationale ? ` Reason recorded: ${r.decision.rationale}` : ""}`,
    closed: "Closed.",
    withdrawn: "Withdrawn.",
  };
  return map[r.status] ?? v.stage.name;
}

export function isEditable(v: RequestView, requestor: boolean): boolean {
  return requestor && (v.request.status === "draft" || v.request.status === "info-requested");
}

/** Replace field keys and document types in rulebook messages with their labels. */
export function labelize(text: string, v: Pick<RequestView, "subtype" | "documentRequirements">): string {
  const names = new Map<string, string>();
  // Only code-like ids (dotted, hyphenated, camelCase, w9); plain words such as "budget" already read as words.
  const codeLike = (k: string) => /[.\-A-Z]|\d/.test(k);
  for (const f of v.subtype?.fields ?? []) if (codeLike(f.key)) names.set(f.key, f.label.toLowerCase());
  for (const d of v.documentRequirements) if (codeLike(d.type)) names.set(d.type, shortDocLabel(d.label).toLowerCase());
  if (!names.size) return text;
  const keys = [...names.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // One pass, so a replacement is never replaced again.
  const re = new RegExp(`(?<![\\w.-])(${keys.join("|")})(?![\\w-]|\\.\\w)`, "g");
  return text.replace(re, (k) => names.get(k) ?? k);
}

export function shortDocLabel(label: string): string {
  return label.replace(/\s*\(.*?\)\s*/g, " ").replace(/,.*$/, "").trim();
}

export function docLabel(type: string, v: Pick<RequestView, "documentRequirements">): string {
  if (type === "other") return "Other supporting document";
  return v.documentRequirements.find((d) => d.type === type)?.label ?? type.replace(/-/g, " ");
}

/** Action hints the requestor's screen can carry out today. Others are left out rather than shown broken. */
export function supportedHint(h: ActionHint, requestor: boolean): boolean {
  const [verb] = h.id.split(":");
  if (!requestor) return false;
  return ["attest", "answer", "upload", "submit-with-flag", "keep-and-explain", "remove", "change"].includes(verb ?? "") && h.id !== "change:subtype-x";
}

export function isStatementCheck(c: CheckResult): boolean {
  return c.actions.length > 0 && c.actions.every((a) => a.id.startsWith("attest:"));
}

export function budgetLineOf(c: CheckResult): number | undefined {
  for (const e of c.evidence) {
    const m = /^Line (\d+)/.exec(e.label);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export function flaggedLines(checks: CheckResult[]): Map<number, CheckResult> {
  const m = new Map<number, CheckResult>();
  for (const c of checks) {
    if (c.status === "pass" || c.status === "na") continue;
    for (const e of c.evidence) {
      const x = /^Line (\d+)/.exec(e.label);
      if (x) m.set(Number(x[1]), c);
    }
  }
  return m;
}

export function fieldByKey(v: RequestView, key: string): FieldDef | undefined {
  return v.subtype?.fields.find((f) => f.key === key);
}

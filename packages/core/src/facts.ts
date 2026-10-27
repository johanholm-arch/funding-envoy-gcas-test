import type { Facts } from "./conditions.ts";
import type { Catalogue, DocumentRef, Organization, RequestState, Subtype } from "./types.ts";
import { toNumber } from "./money.ts";

/** A document as the rule engine sees it: reference plus optional extracted text per page and a date. */
export interface EvalDocument extends DocumentRef {
  pagesText?: string[];
  dated?: string; // ISO date the document is dated / issued
}

export interface AgreementSnapshot {
  templateId: string;
  signatures: { party: string; name: string; at: string }[];
  certifiedAt?: string;
  clauseIds: string[];
}

export interface EvalContext {
  request: RequestState;
  organization: Organization;
  catalogue: Catalogue;
  subtype?: Subtype;
  documents: EvalDocument[];
  today: string; // ISO date; injectable so tests are deterministic
  openRequestsAmount?: number; // requested + pending + approved for this org in this calendar year, excluding this request
  parameters?: Record<string, unknown>;
  agreement?: AgreementSnapshot;
  teachingHospitalIds?: string[]; // identifiers on the CMS teaching hospital list for the programme year
  productNames?: string[]; // the tenant's product names, for "no medicine name" rules
}

export function fieldValue(req: RequestState, key: string): unknown {
  return req.fields[key]?.value;
}

export function budgetTotal(req: RequestState): number {
  return req.budget.reduce((s, l) => s + (toNumber(l.amount) ?? 0), 0);
}

export function requestedAmount(req: RequestState): number | undefined {
  return toNumber(fieldValue(req, "amount.requested"));
}

/** Build the flat fact map used by conditions and rule scopes. */
export function buildFacts(ctx: EvalContext): Facts {
  const { request: r, organization: o } = ctx;
  const f: Facts = {
    family: r.family,
    subtype: r.subtype,
    country: r.country,
    typeConfirmed: r.typeConfirmed,
    status: r.status,
    stage: r.stage,
    "org.type": o.type,
    "org.country": o.country,
    "org.governmentControlled": o.governmentControlled,
    "org.annualRevenue": o.annualRevenue?.amount,
    "org.taxStatus": o.taxStatus?.status,
    "org.accredited": Boolean(o.accreditation),
    amount: requestedAmount(r),
    currency: (fieldValue(r, "amount.currency") as string | undefined) ?? o.annualRevenue?.currency,
    "budget.total": r.budget.length ? budgetTotal(r) : undefined,
    "budget.lines": r.budget.length,
    "coi.anyYes": Object.values(r.coi).some((a) => a.answer === "yes"),
    "screening.anyMatch": o.screening.some((s) => s.result !== "clear" && s.adjudication?.outcome !== "false-positive"),
    today: ctx.today,
  };
  for (const [k, v] of Object.entries(r.fields)) f[`field.${k}`] = v.value;
  for (const d of ctx.documents) f[`docs.${d.type}`] = true;
  for (const [k, v] of Object.entries(ctx.parameters ?? {})) f[`param.${k}`] = v;
  for (const a of Object.keys(r.attestations)) f[`attested.${a}`] = true;
  return f;
}

/** Resolve a field reference used inside a CheckSpec: bare field key, or a known fact name. */
export function resolveRef(ref: string, facts: Facts): unknown {
  if (ref in facts) return facts[ref];
  return facts[`field.${ref}`];
}

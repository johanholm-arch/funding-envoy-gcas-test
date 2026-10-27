// FundingEnvoy domain contracts. Pure types; no runtime code.
// Every other package builds against these. Change them deliberately.

export type Uuid = string;
export type IsoDateTime = string; // 2026-10-27T14:32:00Z
export type IsoDate = string; // 2026-10-27
export type CountryCode = string; // ISO 3166-1 alpha-2, e.g. "US", "GB", "FR"
export type CurrencyCode = string; // ISO 4217

// ─── People and roles ────────────────────────────────────────────────────────

export type Role =
  | "requestor"
  | "org-admin"
  | "coordinator"
  | "medical-reviewer"
  | "compliance-reviewer"
  | "legal"
  | "committee-member"
  | "committee-chair"
  | "finance"
  | "tax"
  | "compliance-auditor"
  | "process-owner"
  | "operator"
  | "sales"; // exists only so the platform can prove sales is locked out (gate G2)

export interface Actor {
  type: "person" | "agent" | "system" | "connector";
  id: string;
  name: string;
  roles?: Role[];
}

// ─── Conditions (a small JSON predicate language used by rules, catalogue and workflow) ─

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: string; op: CompareOp; value?: unknown }
  | { always: true };

export type CompareOp =
  | "eq" | "ne" | "in" | "nin" | "gt" | "gte" | "lt" | "lte"
  | "exists" | "missing" | "contains" | "truthy" | "falsy";

// ─── Provenance and field values ─────────────────────────────────────────────

export type ProvenanceKind = "document" | "message" | "passport" | "form" | "derived" | "system";

export interface Provenance {
  kind: ProvenanceKind;
  documentId?: Uuid;
  documentName?: string;
  page?: number;
  paragraph?: number;
  cell?: string; // e.g. "B14"
  quote?: string; // exact text the value was read from
  messageId?: Uuid;
  note?: string;
}

export type FieldStatus = "proposed" | "confirmed" | "changed";

export interface FieldValue<T = unknown> {
  value: T;
  status: FieldStatus;
  source: Provenance;
  proposedBy?: Actor;
  confirmedBy?: Actor;
  confirmedAt?: IsoDateTime;
  previous?: { value: unknown; changedAt: IsoDateTime; reason?: string }[];
}

// ─── Catalogue ───────────────────────────────────────────────────────────────

export type FieldKind =
  | "text" | "longtext" | "number" | "money" | "date" | "datetime"
  | "enum" | "multienum" | "boolean" | "audience" | "list";

export interface FieldDef {
  key: string; // dotted keys allowed, e.g. "activity.startDate"
  label: string;
  kind: FieldKind;
  section: string; // section id in the catalogue
  options?: string[];
  required?: boolean;
  requiredWhen?: Condition;
  visibleWhen?: Condition;
  help?: string;
  extractable?: boolean; // the assistant may propose a value from documents
  basis?: string; // why it is asked, e.g. "ACCME Standard 4"
}

export interface DocumentRequirement {
  type: string; // e.g. "request-letter", "prospectus", "budget", "w9", "nonprofit-proof", "financial-statement"
  label: string;
  required?: boolean;
  requiredWhen?: Condition;
  accept: string[]; // mime types or extensions
  fromPassport?: boolean; // may be reused from the organization passport
  maxAgeMonths?: number;
  help?: string;
}

export interface AttestationDef {
  id: string; // e.g. "accuracy", "anti-discrimination", "independence", "non-direction", "not-conditioned"
  label: string;
  text: string; // verbatim statement the requestor types or ticks
  version: string; // wording version; recorded with the attestation
  mode: "type" | "tick"; // "type" means the requestor types their name to confirm
  requiredWhen?: Condition;
  basis?: string;
}

export interface CoiQuestion {
  id: string;
  text: string;
  help?: string;
  ifYes?: string; // what a "yes" triggers, shown to the requestor
}

export type SalesRule = "none" | "input-no-control" | "influence-controls";
export type PayeeRule = "organization" | "accredited-provider" | "institution";

export interface Subtype {
  id: string; // e.g. "ime-accredited"
  family: string; // e.g. "education"
  name: string;
  description: string;
  distinguishers: string[]; // questions or facts that tell it apart from its neighbours
  sections: { id: string; label: string }[];
  fields: FieldDef[];
  documents: DocumentRequirement[];
  attestations: string[]; // AttestationDef ids
  coi: string[]; // CoiQuestion ids
  salesRule: SalesRule;
  payeeRule: PayeeRule;
  reviewingGroupRule: string; // routing rule id
  countries?: CountryCode[]; // omitted = all
  disclosureCategory?: Record<string, string>; // regime → category, e.g. { efpia: "donations-grants", openPayments: "grant" }
  typicalDecisionWeeks?: [number, number];
}

export interface Catalogue {
  version: number;
  families: { id: string; name: string; description: string }[];
  subtypes: Subtype[];
  attestations: AttestationDef[];
  coiQuestions: CoiQuestion[];
}

// ─── Rules ───────────────────────────────────────────────────────────────────

export type Severity = "block" | "warn" | "judge" | "inform";
export type RuleLayer = "law" | "code" | "accreditation" | "policy" | "sop" | "practice" | "platform";

export interface RuleBasis {
  layer: RuleLayer;
  ref: string; // short label shown in UI, e.g. "Policy 5.2", "ACCME 4.2", "ABPI 23.2"
  citation?: string; // longer citation
  url?: string;
  verified?: boolean; // pack values: verified against the primary text?
  verificationNote?: string;
}

export type CheckSpec =
  | { kind: "fieldsPresent"; fields: string[] }
  | { kind: "documentsPresent"; types: string[]; maxAgeMonths?: number }
  | { kind: "attestationsComplete"; ids?: string[] } // omitted ids = all required for the subtype
  | { kind: "coiComplete" }
  | { kind: "coiAllNo" } // any "yes" → this check fails (route to compliance)
  | { kind: "leadTime"; dateField: string; minDays: number | string; from?: "today" | "submittedAt" } // string = "param.<key>"
  | { kind: "ratioMax"; numerator: string[]; denominator: string; max: number | string; includeOpenRequests?: boolean }
  | { kind: "equalsWithin"; a: string; b: string; tolerance?: number }
  | { kind: "budgetLines"; blockCategories: string[]; judgeCategories?: string[]; keywords?: Record<string, string[]>; maxOverheadPct?: number }
  | { kind: "screeningClear"; lists: string[]; maxAgeDays?: number }
  | { kind: "recipientIsOrganization" }
  | { kind: "datesConsistent"; fields: string[] } // same value across documents/fields
  | { kind: "documentQuote"; documentType: string; mustContainAny: string[]; mustNotContainAny?: string[] }
  | { kind: "predicate"; condition: Condition }
  | { kind: "priorApproval"; authority: string; recordField: string; leadDays?: number }
  | { kind: "teachingHospitalMatch" }
  | { kind: "productNameAbsent"; fields: string[] }
  | { kind: "agreementBeforeStart" }
  | { kind: "amountMax"; field: string; max: number | string; currency?: string };

export interface ActionHint {
  id: string; // e.g. "upload:financial-statement", "answer:coi", "change:dates", "submit-with-flag"
  label: string;
}

export interface Rule {
  id: string; // e.g. "R-04", "US-OP-02", "CORE-G4"
  statement: string;
  basis: RuleBasis;
  scope: Condition; // facts: family, subtype, country, orgType, stage, amount...
  check: CheckSpec;
  severity: Severity;
  messages: {
    pass: string; // templates: {{amount}}, {{ratio}}, etc.
    fail: string;
    requestor?: string; // plain-language explanation for the requestor
  };
  actions?: ActionHint[];
  appliesAt?: ("draft" | "submit" | "review" | "pre-payment")[]; // default all
  source: "core" | `pack:${string}` | "tenant";
  locked?: boolean; // core gates: tenants cannot disable
}

export interface Rulebook {
  tenantId?: Uuid;
  version: number;
  status: "draft" | "published" | "retired";
  packs: { id: string; version: number }[];
  rules: Rule[];
  disabled?: string[]; // rule ids the tenant has disabled (core rules cannot be disabled)
  parameters?: Record<string, unknown>; // tenant parameters referenced by rules, e.g. revenueCap: 0.25
}

export type CheckStatus = "pass" | "fail" | "judge" | "na" | "pending";

export interface Evidence {
  label: string;
  value?: string;
  source?: Provenance;
}

export interface CheckResult {
  ruleId: string;
  statement: string;
  status: CheckStatus;
  severity: Severity;
  message: string; // rendered
  requestorMessage?: string;
  basis: RuleBasis;
  evidence: Evidence[];
  actions: ActionHint[];
  computed?: Record<string, unknown>;
  acknowledged?: { by: Actor; at: IsoDateTime; choice: string; note?: string }; // for warn: "submit with flag"
}

// ─── Packs ───────────────────────────────────────────────────────────────────

export interface Pack {
  id: string; // "core", "us", "us-states", "uk", "fr", "accredited-ce"
  name: string;
  version: number;
  effectiveFrom: IsoDate;
  jurisdiction: string; // "GLOBAL", "US", "GB", "FR"
  codeFamily?: string;
  rules: Rule[];
  parameters: PackParameter[];
  clauses: ClauseRequirement[]; // agreement clauses this pack requires
  disclosures: DisclosureRegime[];
  calendar: CalendarEntry[];
  verification: { status: "unverified" | "partial" | "verified"; checkedBy?: string; checkedAt?: IsoDate; notes: string[] };
}

export interface PackParameter {
  key: string; // "openPayments.minimumTransfer.2026"
  label: string;
  value: unknown;
  unit?: string;
  effectiveFrom?: IsoDate;
  effectiveTo?: IsoDate;
  source: string;
  verified: boolean;
}

export interface ClauseRequirement {
  id: string;
  label: string;
  text: string;
  requiredWhen: Condition;
  basis: RuleBasis;
}

export interface DisclosureRegime {
  id: string; // "open-payments", "efpia-hco", "disclosure-uk", "transparence-sante"
  name: string;
  appliesWhen: Condition;
  categoryField?: string;
  deadline: string; // human description, e.g. "30 June for prior calendar year"
  fields: string[];
}

export interface CalendarEntry {
  id: string;
  label: string;
  rule: string; // e.g. "annual:06-30", "annual:04-01", "semester:03-01,09-01", "once:2027-01-01"
  regime?: string;
  basis: RuleBasis;
}

// ─── Workflow and autonomy ───────────────────────────────────────────────────

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4; // Off, Observe, Recommend, Act with confirmation, Autonomous
export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  0: "Off", 1: "Observe", 2: "Recommend", 3: "Act with confirmation", 4: "Autonomous",
};

export type LockedAction = "decide-funding" | "attest" | "sign-agreement" | "release-payment" | "submit-disclosure";

export interface OutcomeDef {
  id: string; // "approve", "approve-with-conditions", "decline", "defer", "request-info", "route", "complete", "accept"
  label: string;
  next: string; // stage id, or "closed", "declined", "withdrawn"
  actorRoles: Role[];
  requiresReason?: boolean;
  locked?: LockedAction;
}

export interface StageDef {
  id: string;
  order: number;
  name: string;
  ownerRoles: Role[];
  status?: RequestStatus; // request status while in this stage; inferred from the id when omitted
  slaBusinessDays?: number;
  sopRefs: string[];
  assistant: { level: AutonomyLevel; maxLevel: AutonomyLevel; does: string };
  enterWhen?: Condition;
  skipWhen?: Condition;
  requiresPassing?: string[]; // rule ids that must not be failing to leave this stage
  outcomes: OutcomeDef[];
  variations?: { when: Condition; note: string; companyChoice?: boolean; patch: Partial<Pick<StageDef, "skipWhen" | "slaBusinessDays" | "ownerRoles">> }[];
}

export interface WorkflowDef {
  version: number;
  status: "draft" | "published" | "retired";
  name: string;
  source: { document: string; version: string; clauses: Record<string, string> };
  stages: StageDef[];
  signedBy?: string;
  signedAt?: IsoDateTime;
}

export interface AutonomyPolicy {
  version: number;
  profile: "standard" | "cautious" | "custom";
  overrides: { stage: string; when?: Condition; level: AutonomyLevel }[];
  confidenceFloor: number; // below this the assistant shows "no recommendation"
}

// ─── Organizations, requests and downstream records ──────────────────────────

export type OrgType =
  | "association" | "hospital" | "teaching-hospital" | "university" | "patient-organization"
  | "charity" | "accredited-provider" | "medical-education-company" | "government" | "individual";

export interface ScreeningResult {
  list: string; // "LEIE", "SAM", "OFAC-SDN", "UK-OFSI", "EU-CFSP", "IRS-TEOS", "PEP"
  listVersion: string;
  checkedAt: IsoDateTime;
  result: "clear" | "possible-match" | "match";
  score?: number;
  adjudication?: { by: Actor; at: IsoDateTime; outcome: "false-positive" | "true-match"; note: string };
}

export interface Organization {
  id: Uuid;
  legalName: string;
  type: OrgType;
  country: CountryCode;
  identifiers: Record<string, string>; // { ein: "04-1234567" } | { charityNumber } | { siren }
  governmentControlled: boolean;
  address?: string;
  website?: string;
  annualRevenue?: { amount: number; currency: CurrencyCode; fiscalYear: string; evidenceDocumentId?: Uuid };
  taxStatus?: { status: string; evidenceDocumentId?: Uuid; asOf?: IsoDate };
  officers: { name: string; title: string; isHcp?: boolean; isPublicOfficial?: boolean }[];
  signers: { name: string; title: string; email: string }[];
  screening: ScreeningResult[];
  accreditation?: { body: string; id?: string; expires?: IsoDate };
}

export interface BudgetLine {
  line: number;
  description: string;
  category: string; // "venue", "av", "faculty-honoraria", "faculty-travel", "meals", "materials", "accreditation", "outcomes", "marketing", "management-fee", "learner-travel", "entertainment", "gifts", "other"
  amount: number;
  source?: Provenance;
}

export interface AttestationRecord {
  id: string;
  version: string;
  text: string;
  typedName?: string;
  by: Actor;
  at: IsoDateTime;
}

export interface CoiAnswer {
  questionId: string;
  answer: "yes" | "no";
  detail?: string;
  by: Actor;
  at: IsoDateTime;
}

export type RequestStatus =
  | "draft" | "submitted" | "in-review" | "info-requested" | "committee" | "approved" | "declined"
  | "agreement" | "payment" | "active" | "reconciliation" | "outcomes" | "closed" | "withdrawn";

export interface DocumentRef {
  id: Uuid;
  type: string; // DocumentRequirement.type, or "other"
  name: string;
  pages?: number;
  sha256: string;
  classifiedBy?: "requestor" | "assistant";
  fromPassport?: boolean;
}

export interface RequestState {
  id: Uuid;
  tenantId: Uuid;
  ref: string; // human reference, e.g. "2026-01642-IME"
  organizationId: Uuid;
  requestorId: Uuid;
  family?: string;
  subtype?: string;
  typeConfirmed: boolean;
  country: CountryCode;
  status: RequestStatus;
  stage: string; // workflow stage id
  title?: string;
  fields: Record<string, FieldValue>;
  budget: BudgetLine[];
  documents: DocumentRef[];
  attestations: Record<string, AttestationRecord>;
  coi: Record<string, CoiAnswer>;
  checks: CheckResult[];
  flags: { ruleId: string; choice: string; note?: string; by: Actor; at: IsoDateTime }[];
  versions: { rulebook: number; workflow: number; catalogue: number; packs: Record<string, number> };
  createdAt: IsoDateTime;
  submittedAt?: IsoDateTime;
  decidedAt?: IsoDateTime;
  closedAt?: IsoDateTime;
  reviewingGroup?: { id: string; label: string; by: "assistant" | "person"; confidence?: number; rule?: string };
  judgements?: Record<string, { decision: string; note?: string; by: Actor; at: IsoDateTime }>; // reviewer decisions on "judge" items
  infoRequests?: InfoRequest[];
  decision?: { outcome: "approve" | "approve-with-conditions" | "decline" | "defer"; amount?: number; conditions?: string; rationale: string; by: Actor; at: IsoDateTime };
  agreement?: AgreementSnapshot;
  reviewSummary?: { generatedAt: IsoDateTime; rulebookVersion: number; markdown: string };
}

export interface InfoRequest {
  id: string;
  by: Actor;
  at: IsoDateTime;
  status: "open" | "answered" | "closed";
  questions: { id: string; text: string; answer?: string; answeredAt?: IsoDateTime; documentIds?: string[] }[];
  dueAt?: IsoDate;
  whatChanged?: string; // note written for the coordinator when the requestor finishes
}

export interface AgreementSnapshot {
  templateId: string;
  signatures: { party: string; name: string; at: string }[];
  certifiedAt?: string;
  clauseIds: string[];
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export interface AiTrace {
  provider: string; // "claude" | "demo"
  model: string;
  promptVersion: string;
  inputHashes: string[];
  outputHash: string;
  scores?: Record<string, number>;
  gate?: { stage: string; level: AutonomyLevel; outcome: "proposed" | "applied" | "held-for-person" };
  humanDecision?: { by: Actor; at: IsoDateTime; decision: "accept" | "modify" | "reject"; reason?: string };
  latencyMs?: number;
}

export interface AuditEventInput {
  tenantId: Uuid;
  actor: Actor;
  entity: { type: string; id: string };
  action: string;
  data?: Record<string, unknown>;
  ai?: AiTrace;
}

export interface AuditEvent extends AuditEventInput {
  seq: number;
  id: Uuid;
  at: IsoDateTime;
  prevHash: string;
  hash: string;
}

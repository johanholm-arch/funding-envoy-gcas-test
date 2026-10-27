// Shapes of the FundingEnvoy API as the web app reads them. Kept local so the web build does not depend
// on the runtime packages; mirrors packages/core/src/types.ts and the services in apps/api.

export type Role =
  | "requestor" | "org-admin" | "coordinator" | "medical-reviewer" | "compliance-reviewer" | "legal"
  | "committee-member" | "committee-chair" | "finance" | "tax" | "compliance-auditor" | "process-owner"
  | "operator" | "access-admin" | "sales";

export interface Actor {
  type: "person" | "agent" | "system" | "connector";
  id: string;
  name: string;
  roles?: Role[];
}

export interface Me {
  user: { id: string; name: string; title?: string; email: string; kind: "internal" | "requestor" | "operator"; roles: Role[] };
  tenant?: {
    id: string; slug: string; name: string; demo: boolean;
    brand?: { color?: string; corners?: string; logoText?: string; headingFace?: string };
    words?: { request?: string; committee?: string; assistantName?: string; reviewingTeam?: string; reconciliation?: string };
  };
  organization?: { id: string; name: string; country: string };
  assistant: { provider: string; model: string; label: string };
}

export interface Persona {
  id: string; name: string; title: string | null; kind: "internal" | "requestor" | "operator";
  roles: Role[]; tenant_id: string | null; org_id: string | null; org_name: string | null;
}

export interface Provenance {
  kind: "document" | "message" | "passport" | "form" | "derived" | "system";
  documentId?: string; documentName?: string; page?: number; paragraph?: number; cell?: string; quote?: string; messageId?: string; note?: string;
}

export interface FieldValue {
  value: unknown;
  status: "proposed" | "confirmed" | "changed";
  source: Provenance;
  proposedBy?: Actor;
  confirmedBy?: Actor;
  confirmedAt?: string;
  previous?: { value: unknown; changedAt: string; reason?: string }[];
}

export type FieldKind = "text" | "longtext" | "number" | "money" | "date" | "datetime" | "enum" | "multienum" | "boolean" | "audience" | "list";

export interface FieldDef {
  key: string; label: string; kind: FieldKind; section: string; options?: string[]; required?: boolean;
  help?: string; extractable?: boolean; basis?: string;
}

export interface DocumentRequirement {
  type: string; label: string; required?: boolean; requiredWhen?: unknown; accept: string[]; fromPassport?: boolean; maxAgeMonths?: number; help?: string;
}

export interface AttestationDef { id: string; label: string; text: string; version: string; mode: "type" | "tick"; basis?: string }
export interface CoiQuestion { id: string; text: string; help?: string; ifYes?: string }

export interface Subtype {
  id: string; family: string; name: string; description: string;
  sections: { id: string; label: string }[]; fields: FieldDef[]; documents: DocumentRequirement[];
  attestations: string[]; coi: string[]; typicalDecisionWeeks?: [number, number];
}

export type Severity = "block" | "warn" | "judge" | "inform";
export type CheckStatus = "pass" | "fail" | "judge" | "na" | "pending";

export interface RuleBasis { layer: string; ref: string; citation?: string; url?: string; verified?: boolean; verificationNote?: string }
export interface Evidence { label: string; value?: string; source?: Provenance }
export interface ActionHint { id: string; label: string }

export interface CheckResult {
  ruleId: string; statement: string; status: CheckStatus; severity: Severity; message: string; requestorMessage?: string;
  basis: RuleBasis; evidence: Evidence[]; actions: ActionHint[]; computed?: Record<string, unknown>;
  acknowledged?: { by: Actor; at: string; choice: string; note?: string };
}

export interface CheckSummary {
  mustFix: CheckResult[]; yourCall: CheckResult[]; forReviewer: CheckResult[]; pending: CheckResult[]; passed: CheckResult[]; notes: CheckResult[]; submittable: boolean;
}

export interface BudgetLine { line: number; description: string; category: string; amount: number; source?: Provenance }

export interface InfoRequest {
  id: string; by: Actor; at: string; status: "open" | "answered" | "closed"; dueAt?: string; whatChanged?: string;
  questions: { id: string; text: string; answer?: string; answeredAt?: string; documentIds?: string[] }[];
}

export type RequestStatus =
  | "draft" | "submitted" | "in-review" | "info-requested" | "committee" | "approved" | "declined"
  | "agreement" | "payment" | "active" | "reconciliation" | "outcomes" | "closed" | "withdrawn";

export interface RequestState {
  id: string; ref: string; organizationId: string; requestorId: string; family?: string; subtype?: string; typeConfirmed: boolean;
  country: string; status: RequestStatus; stage: string; title?: string; fields: Record<string, FieldValue>; budget: BudgetLine[];
  attestations: Record<string, { id: string; version: string; text: string; typedName?: string; by: Actor; at: string }>;
  coi: Record<string, { questionId: string; answer: "yes" | "no"; detail?: string; by: Actor; at: string }>;
  flags: { ruleId: string; choice: string; note?: string; by: Actor; at: string }[];
  versions: { rulebook: number; workflow: number; catalogue: number; packs: Record<string, number> };
  createdAt: string; submittedAt?: string; decidedAt?: string;
  reviewingGroup?: { id: string; label: string; by: "assistant" | "person"; confidence?: number; rule?: string };
  judgements?: Record<string, { decision: string; note?: string; by: Actor; at: string }>;
  infoRequests?: InfoRequest[];
  decision?: { outcome: string; amount?: number; conditions?: string; rationale: string; by: Actor; at: string };
}

export interface Organization {
  id: string; legalName: string; type: string; country: string; identifiers: Record<string, string>;
  address?: string; website?: string;
  annualRevenue?: { amount: number; currency: string; fiscalYear: string };
  taxStatus?: { status: string; asOf?: string };
  officers: { name: string; title: string }[];
  signers: { name: string; title: string; email: string }[];
  screening: { list: string; listVersion: string; checkedAt: string; result: string }[];
}

export interface DocumentEntry {
  id: string; type: string; name: string; sha256: string; pages?: number; dated?: string;
  classifiedBy?: "assistant" | "requestor"; fromPassport?: boolean; covers: string[];
}

export interface Section { id: string; label: string; fields: (FieldDef & { current?: FieldValue })[] }

export interface Ask {
  kind: "type" | "budget" | "coi" | "field" | "document" | "flag" | "attestations" | "ready" | "conflict";
  questionId: string; text: string; options?: { id: string; label: string }[]; fieldKey?: string; ruleId?: string;
}

export interface Message {
  id: string; author: Actor; body: string; channel: "requestor" | "internal"; createdAt: string;
  data: {
    ask?: Ask; intro?: boolean; declined?: string; policyAnswer?: boolean; citations?: { ref: string; quote?: string }[];
    choice?: { questionId: string; optionId: string }; extracted?: { applied: number; documentIds: string[] };
    submitted?: boolean; infoRequest?: string; decision?: string; whatChanged?: string;
  };
}

export interface RequestView {
  request: RequestState;
  organization: Organization;
  subtype?: Subtype;
  sections: Section[];
  checks: CheckResult[];
  summary: CheckSummary;
  progress: { answered: number; total: number; missing: FieldDef[]; documentsPresent: number; documentsRequired: number; missingDocs: string[] };
  documents: DocumentEntry[];
  stage: { id: string; name: string; enteredAt: string };
  catalogue: { subtypes: { id: string; name: string; family: string }[]; attestations: AttestationDef[]; coiQuestions: CoiQuestion[] };
  documentRequirements: DocumentRequirement[];
}

export interface Readiness { canSubmit: boolean; blockers: { ruleId: string; message: string }[] }

export interface RequestPayload extends RequestView {
  messages: Message[];
  /** The assistant's current question, while a draft has a confirmed type. */
  nextAsk?: Ask;
  /** Whether the request can be submitted now; computed without side effects. */
  readiness?: Readiness;
}

export interface Preview extends RequestView {
  canSubmit: boolean;
  blockers: { ruleId: string; text: string }[];
  flagsForReviewer: { ruleId: string; text: string; note?: string }[];
  whatHappensNext: { id: string; name: string; owner: Role[]; slaBusinessDays?: number }[];
}

export interface MyRequest {
  id: string; ref: string; title: string; status: RequestStatus; stage: string; stageName?: string; amountLabel: string;
  plain: string; needsYou: boolean; action?: string; due?: string; updatedAt: string;
}

export interface DeskItem {
  id: string; ref: string; title: string; organization: string; subtype?: string; country: string; amount?: number; currency?: string; amountLabel: string;
  stage: string; stageName: string; status: string; submittedAt?: string; ageDays: number; forJudgement: number; passed: number; reviewingGroup?: string;
  line: string; tasks: { kind: string; title: string; due?: string }[];
}

export interface Desk {
  needsYou: DeskItem[]; assistant: DeskItem[]; waiting: DeskItem[]; done: DeskItem[];
  counts: { needsYou: number; assistant: number; waiting: number };
}

export interface JudgementItem {
  ruleId: string; title: string; text: string; basis: RuleBasis; evidence: Evidence[];
  decided?: { decision: string; note?: string; by: Actor; at: string };
  options: { id: string; label: string }[];
}

export interface Brief extends RequestView {
  judgement: JudgementItem[];
  recommendation?: { text: string; basis: string; level: number; levelLabel: string };
  actions: { id: string; label: string; requiresReason: boolean; locked?: string }[];
  reviewingGroup?: RequestState["reviewingGroup"];
  summaryCounts: { passed: number; forYou: number; total: number };
  assistantActivity: { actions: number; extractions: number; documentsClassified: number; proposedFields: number };
  infoRequests: InfoRequest[];
  decision?: RequestState["decision"];
  reviewSummary?: { generatedAt: string; rulebookVersion: number; markdown: string };
  groups: { id: string; label: string }[];
  requestor?: { id: string; name: string; title?: string };
  submittedBy?: string;
  submittedAt?: string;
}

export interface CommitteeMember { id: string; name: string; title?: string | null; roles: Role[] }

export interface AiTrace {
  provider: string; model: string; promptVersion: string; inputHashes: string[]; outputHash: string;
  scores?: Record<string, number>; latencyMs?: number;
  gate?: { stage: string; level: number; outcome: "proposed" | "applied" | "held-for-person" };
  humanDecision?: { by: Actor; at: string; decision: string; reason?: string };
}

export interface AuditEvent {
  seq: number; id: string; at: string; actor: Actor; entity: { type: string; id: string }; action: string;
  data?: Record<string, unknown>; ai?: AiTrace; prevHash: string; hash: string;
}

export interface Trail { events: AuditEvent[]; counts: { people: number; agent: number; system: number } }

export interface ChainVerification { ok: boolean; checked: number; head?: string; firstBreak?: { seq: number; reason: string }; verifiedAt: string }

export interface DocumentPages { name: string; type: string; pages: string[] }

export interface PolicyAnswer { answer: string; citations: { ref: string; quote?: string }[]; declined?: string }

// ─── Downstream: agreement, payment, disclosure ───

export interface AgreementView {
  agreement?: {
    id: string; template_id: string; status: "draft" | "sent" | "signed" | "certified" | "executed" | "void" | string; body: string;
    clauses: { id: string; label: string; text: string }[]; envelope_id: string | null;
    signatures: { party: string; name: string; at: string }[]; certified_by: string | null; certifiedAt?: string; created_at: string;
  };
  requiredClauses: { id: string; label: string; basis?: RuleBasis; present: boolean }[];
  certificationRequired: boolean;
  signer?: { name: string; title: string; email: string };
  stage: string;
  /** The legal name of the side the current person signs for, if any. */
  mySide?: string;
  canSign?: boolean;
  sides?: { organization: string; company: string };
}

export interface PaymentRow {
  id: string; milestone: number; label: string; amount: number; currency: string; status: "ready" | "paid" | string;
  gl_account: string | null; tax_class: string | null; payee: { organization?: string; vendorId?: string; verifiedAccount?: string };
  erp_refs: { vendorId?: string; purchaseOrder?: string; paymentRun?: string; document?: string }; released_at: string | null; paid_at: string | null;
}
export interface PaymentListRow extends PaymentRow { ref: string; title: string | null; org: string; request_id: string }
export interface PaymentDetail {
  payments: PaymentRow[];
  gate: { blocking: { ruleId: string; text: string }[]; checks: CheckResult[] };
  transfers: { regime: string; category: string; amount: number; currency: string; period: string; state: string }[];
}

export interface DisclosureRegimeStatus {
  id: string; name: string; deadline: string; nextDue?: string; periods: string[]; records: number; total: number; currency?: string; totalLabel: string;
  unmatched: { id: string; recipient: string; needs: string; ref?: string }[]; submitted: number;
  status: "nothing-to-report" | "needs-attention" | "submitted" | "ready";
}
export interface CalendarItem { id: string; label: string; pack: string; next: string; rule: string; basis: RuleBasis }

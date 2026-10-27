// The request ledger: loading a request with everything needed to evaluate it, re-running checks,
// persisting the projection and recording events. Every write here goes through `record`.
import type { Actor, AuditEventInput, CheckResult, EvalContext, EvalDocument, FieldDef, FieldValue, Organization, RequestState, Subtype } from "@fe/core";
import { buildFacts, evaluate, evaluateRules, isoDate, requestedAmount, sortChecks, summarize, type Phase } from "@fe/core";
import { appendEvent, many, one, type Tx } from "@fe/db";
import { tenantConfig, type TenantConfig } from "../config.ts";
import { HttpError } from "../auth.ts";

export interface RequestRow {
  id: string; tenant_id: string; ref: string; org_id: string; requestor_id: string; family: string | null; subtype: string | null;
  country: string; status: string; stage: string; stage_entered_at: Date; title: string | null; amount: number | null; currency: string | null;
  state: RequestState; versions: RequestState["versions"]; created_at: Date; updated_at: Date; submitted_at: Date | null;
}

export interface Loaded {
  row: RequestRow;
  state: RequestState;
  org: Organization;
  cfg: TenantConfig;
  subtype?: Subtype;
  docs: EvalDocument[];
  ctx: EvalContext;
}

export function today(): string {
  return process.env.FE_TODAY ?? isoDate(new Date());
}

export async function record(tx: Tx, input: AuditEventInput) {
  return appendEvent(tx, input);
}

export async function loadOrganization(tx: Tx, orgId: string): Promise<Organization> {
  const row = await one<{ id: string; legal_name: string; type: string; country: string; identifiers: Record<string, string>; data: Partial<Organization> }>(tx,
    "select id, legal_name, type, country, identifiers, data from organizations where id = $1", [orgId]);
  if (!row) throw new HttpError(404, "Organization not found.");
  return {
    officers: [], signers: [], screening: [], governmentControlled: false, ...row.data,
    id: row.id, legalName: row.legal_name, type: row.type as Organization["type"], country: row.country, identifiers: row.identifiers,
  };
}

export async function loadDocs(tx: Tx, requestId: string, orgId: string): Promise<EvalDocument[]> {
  const rows = await many<{ id: string; type: string; name: string; sha256: string; page_count: number | null; pages_text: string[] | null; dated: string | null; classified_by: string | null; tenant_id: string | null; covers: string[] }>(tx,
    `select id, type, name, sha256, page_count, pages_text, dated, classified_by, tenant_id, covers from documents
     where request_id = $1 or (tenant_id is null and org_id = $2 and request_id is null) order by created_at`, [requestId, orgId]);
  return rows.flatMap((d) => {
    const base = { id: d.id, name: d.name, sha256: d.sha256, pages: d.page_count ?? undefined, pagesText: d.pages_text ?? undefined, dated: d.dated ?? undefined, classifiedBy: (d.classified_by as "assistant" | "requestor" | undefined) ?? undefined, fromPassport: d.tenant_id === null };
    // A document that also covers another requirement is evaluated once per type it satisfies.
    return [{ ...base, type: d.type }, ...(d.covers ?? []).map((t) => ({ ...base, type: t, alsoCovers: true }))];
  });
}

/** Sum of other open or approved requests for this organization in the activity's calendar year (revenue cap). */
export async function openAmount(tx: Tx, tenantId: string, orgId: string, excludeId: string): Promise<number> {
  const r = await one<{ total: number | null }>(tx,
    `select coalesce(sum(amount), 0) as total from requests where tenant_id = $1 and org_id = $2 and id <> $3
     and status not in ('draft','declined','withdrawn') and date_part('year', coalesce(submitted_at, created_at)) = date_part('year', now())`,
    [tenantId, orgId, excludeId]);
  return r?.total ?? 0;
}

export async function loadRequest(tx: Tx, requestId: string): Promise<Loaded> {
  const row = await one<RequestRow>(tx, "select * from requests where id = $1", [requestId]);
  if (!row) throw new HttpError(404, "Request not found.");
  const cfg = await tenantConfig(tx, row.tenant_id, row.versions);
  const org = await loadOrganization(tx, row.org_id);
  const docs = await loadDocs(tx, row.id, row.org_id);
  const state: RequestState = { ...row.state, documents: docs.map(({ pagesText: _p, dated: _d, ...d }) => d) };
  const subtype = cfg.catalogue.subtypes.find((s) => s.id === state.subtype);
  const ctx: EvalContext = {
    request: state, organization: org, catalogue: cfg.catalogue, subtype, documents: docs, today: today(),
    openRequestsAmount: await openAmount(tx, row.tenant_id, row.org_id, row.id),
    parameters: cfg.rulebook.parameters, productNames: ((await tenantSettings(tx, row.tenant_id)).productNames as string[] | undefined) ?? [],
    teachingHospitalIds: [],
    agreement: state.agreement,
  };
  return { row, state, org, cfg, subtype, docs, ctx };
}

export async function tenantSettings(tx: Tx, tenantId: string): Promise<Record<string, unknown>> {
  const t = await one<{ settings: Record<string, unknown> }>(tx, "select settings from tenants where id = $1", [tenantId]);
  return t?.settings ?? {};
}

export function runChecks(l: Loaded, phase: Phase = "draft"): CheckResult[] {
  const prevAck = new Map(l.state.flags.map((f) => [f.ruleId, f]));
  const routing = new Set(((l.cfg.rulebook.parameters.triage as { ruleId: string }[] | undefined) ?? []).map((t) => t.ruleId));
  const checks = evaluateRules(l.cfg.rulebook.rules.filter((r) => !routing.has(r.id)), { ...l.ctx, request: l.state }, { phase });
  return sortChecks(checks.map((c) => {
    const f = prevAck.get(c.ruleId);
    return f && c.status !== "pass" ? { ...c, acknowledged: { by: f.by, at: f.at, choice: f.choice, note: f.note } } : c;
  }));
}

/** Fields that apply to this request: the subtype's fields, or the union across subtypes until the type is known. */
export function fieldsFor(cfg: TenantConfig, subtype?: Subtype): FieldDef[] {
  if (subtype) return subtype.fields;
  const seen = new Map<string, FieldDef>();
  for (const s of cfg.catalogue.subtypes) for (const f of s.fields) if (!seen.has(f.key)) seen.set(f.key, f);
  return [...seen.values()];
}

export function requiredProgress(l: Loaded): { answered: number; total: number; missing: FieldDef[]; documentsPresent: number; documentsRequired: number; missingDocs: string[] } {
  const facts = buildFacts({ ...l.ctx, request: l.state });
  const fields = (l.subtype?.fields ?? []).filter((f) => evaluate(f.visibleWhen, facts) && (f.required || (f.requiredWhen && evaluate(f.requiredWhen, facts))));
  const has = (k: string) => {
    const v = l.state.fields[k]?.value;
    return v !== undefined && v !== null && v !== "";
  };
  const missing = fields.filter((f) => !has(f.key));
  const docsReq = (l.subtype?.documents ?? []).filter((d) => d.required || (d.requiredWhen && evaluate(d.requiredWhen, facts)));
  const present = new Set(l.docs.map((d) => d.type));
  const missingDocs = docsReq.filter((d) => !present.has(d.type)).map((d) => d.type);
  return { answered: fields.length - missing.length, total: fields.length, missing, documentsPresent: docsReq.length - missingDocs.length, documentsRequired: docsReq.length, missingDocs };
}

export async function saveState(tx: Tx, l: Loaded, patch: Partial<RequestState> = {}): Promise<RequestState> {
  const state: RequestState = { ...l.state, ...patch };
  const title = (state.fields.title?.value as string | undefined) ?? state.title ?? null;
  const amount = requestedAmount(state) ?? null;
  const currency = (state.fields["amount.currency"]?.value as string | undefined) ?? (amount !== null ? "USD" : null);
  const { documents: _d, ...persist } = state;
  await tx.query(
    `update requests set state = $2, title = $3, amount = $4, currency = $5, family = $6, subtype = $7, status = $8,
       stage = $9, ref = $10, country = $11, updated_at = now(), submitted_at = $12,
       stage_entered_at = case when stage <> $9 then now() else stage_entered_at end
     where id = $1`,
    [l.row.id, { ...persist, title: title ?? undefined, documents: [] }, title, amount, currency, state.family ?? null, state.subtype ?? null, state.status, state.stage, state.ref, state.country, state.submittedAt ?? null],
  );
  l.state = state;
  return state;
}

export function setField(state: RequestState, key: string, fv: FieldValue, actor: Actor, reason?: string): RequestState {
  const prev = state.fields[key];
  const previous = prev && JSON.stringify(prev.value) !== JSON.stringify(fv.value)
    ? [...(prev.previous ?? []), { value: prev.value, changedAt: new Date().toISOString(), reason }]
    : prev?.previous;
  return { ...state, fields: { ...state.fields, [key]: { ...fv, previous, ...(fv.status !== "proposed" ? { confirmedBy: actor, confirmedAt: new Date().toISOString() } : {}) } } };
}

export interface RequestView {
  request: RequestState & { ref: string };
  organization: Organization;
  subtype?: Subtype;
  sections: { id: string; label: string; fields: (FieldDef & { current?: FieldValue })[] }[];
  checks: CheckResult[];
  summary: ReturnType<typeof summarize>;
  progress: ReturnType<typeof requiredProgress>;
  documents: Loaded["docs"];
  versions: RequestState["versions"];
  stage: { id: string; name: string; enteredAt: string };
  catalogue: { subtypes: { id: string; name: string; family: string }[]; attestations: TenantConfig["catalogue"]["attestations"]; coiQuestions: TenantConfig["catalogue"]["coiQuestions"] };
  documentRequirements: Subtype["documents"];
}

export function view(l: Loaded, checks = l.state.checks): RequestView {
  const facts = buildFacts({ ...l.ctx, request: l.state });
  const sections = (l.subtype?.sections ?? []).map((s) => ({
    ...s,
    fields: l.subtype!.fields.filter((f) => f.section === s.id && evaluate(f.visibleWhen, facts)).map((f) => ({ ...f, required: Boolean(f.required || (f.requiredWhen && evaluate(f.requiredWhen, facts))), current: l.state.fields[f.key] })),
  }));
  const stage = l.cfg.workflow.stages.find((s) => s.id === l.state.stage);
  return {
    request: { ...l.state, ref: l.row.ref },
    organization: l.org,
    subtype: l.subtype,
    sections,
    checks,
    summary: summarize(checks),
    progress: requiredProgress(l),
    documents: dedupeDocs(l.docs),
    versions: l.state.versions,
    stage: { id: l.state.stage, name: stage?.name ?? l.state.stage, enteredAt: l.row.stage_entered_at.toISOString() },
    catalogue: { subtypes: l.cfg.catalogue.subtypes.map((s) => ({ id: s.id, name: s.name, family: s.family })), attestations: l.cfg.catalogue.attestations, coiQuestions: l.cfg.catalogue.coiQuestions },
    documentRequirements: l.subtype?.documents ?? [],
  };
}

/** One entry per file, listing any other requirements it also satisfies. */
export function dedupeDocs(docs: Loaded["docs"]): (Omit<Loaded["docs"][number], "pagesText"> & { covers: string[] })[] {
  const byId = new Map<string, Omit<Loaded["docs"][number], "pagesText"> & { covers: string[] }>();
  for (const d of docs) {
    const { pagesText: _p, ...rest } = d;
    const cur = byId.get(d.id);
    if (!cur) byId.set(d.id, { ...rest, covers: [] });
    else cur.covers.push(d.type);
  }
  return [...byId.values()];
}

export async function addMessage(tx: Tx, l: { row: { id: string; tenant_id: string } }, author: Actor, body: string, data: Record<string, unknown> = {}, channel: "requestor" | "internal" = "requestor") {
  return one<{ id: string; created_at: Date }>(tx,
    "insert into messages (tenant_id, request_id, author, channel, body, data) values ($1,$2,$3,$4,$5,$6) returning id, created_at",
    [l.row.tenant_id, l.row.id, author, channel, body, data]);
}

export async function nextDraftRef(tx: Tx, tenantId: string): Promise<string> {
  const r = await one<{ n: number }>(tx, "select count(*)::int + 1 as n from requests where tenant_id = $1", [tenantId]);
  return `D-${String(r!.n + 400).padStart(4, "0")}`;
}

const SUFFIX: Record<string, string> = { education: "IME", charitable: "CHA" };
export async function finalRef(tx: Tx, tenantId: string, family?: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const r = await one<{ n: number }>(tx, "select count(*)::int as n from requests where tenant_id = $1 and ref not like 'D-%'", [tenantId]);
  return `${year}-${String(1640 + (r?.n ?? 0) + 1).padStart(5, "0")}-${SUFFIX[family ?? ""] ?? "OTH"}`;
}

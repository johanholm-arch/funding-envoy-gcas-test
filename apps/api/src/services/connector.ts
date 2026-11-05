// The Salesforce connector: FundingEnvoy in front of a funder's Salesforce grants app (option A of the integration
// plan). The process owner connects, FundingEnvoy reads how the org is built and suggests how its fields match, the
// mapping is signed and published like any other configuration, and from then on a submitted request is written to
// Salesforce at four checkpoints under the requestor's own name. Salesforce keeps the record and the decisions; its
// status changes and the coordinators' comments come back as events. Today the org is the simulated one in
// ../connectors/salesforce-sim.ts; a live org replaces those calls with REST, Composite Graph and Pub/Sub.
import type { Actor, Catalogue, ExternalRecord, InfoRequest } from "@fe/core";
import { toNumber } from "@fe/core";
import { randomUUID } from "node:crypto";
import { many, one, withContext, type Tx } from "@fe/db";
import { actorOf, asUser, HttpError, type SessionUser } from "../auth.ts";
import { configVersion } from "../config.ts";
import * as sf from "../connectors/salesforce-sim.ts";
import { addMessage, loadRequest, record, saveState, type Loaded } from "./requests.ts";
import { createDraft, updateDraft, type ValidationIssue } from "./studio.ts";

export const SF_ACTOR: Actor = { type: "connector", id: "salesforce-sim", name: "Salesforce connector (simulated)" };
const SYSTEM = "salesforce";

export interface ConnectorConfig {
  system: "salesforce";
  mode: "simulated" | "live";
  enabled: boolean;
  connection: { myDomain: string; siteUrl: string; apiVersion: string };
  snapshotHash?: string;
  objects: { organization: string; request: string; document: string; comment: string };
  /** Fields FundingEnvoy fills itself (links, status, attestation, summary), not from the requestor's answers. */
  systemFields: {
    requestOrganization: string; requestRequestor: string; requestStatus: string; requestExternalId: string; requestSubmittedAt: string;
    requestAttestedBy: string; requestReviewSummary: string; organizationTaxId: string; organizationCountry: string; organizationExternalId: string;
    documentCategory: string; documentExternalId: string; commentRequest: string; commentBody: string; commentVisible: string; commentAuthor: string;
  };
  statusValues: { draft: string; submitted: string; infoRequested: string; approved: string; declined: string; closed: string };
  fields: { fe: string; sf: string }[];
  values: Record<string, Record<string, string>>;
  documents: Record<string, string>;
  matching: { identifiers: boolean; byName: boolean };
  checkpoints: { organization: boolean; draft: boolean; documents: boolean; submit: boolean };
  events: { status: boolean; comments: boolean };
}

interface FeField { key: string; label: string; kind: string; options?: { value: string; label: string }[]; required: boolean }
interface Snapshot { hash: string; body: ReturnType<typeof sf.describeOrg>; read_by: string; read_at: Date }

function requireOwner(u: SessionUser, edit = false) {
  const roles = edit ? ["process-owner", "operator"] : ["process-owner", "operator", "compliance-auditor", "coordinator"];
  if (!u.roles.some((r) => roles.includes(r)) && u.kind !== "operator") throw new HttpError(403, edit ? "Only the process owner can change the Salesforce connection." : "This is for the funder's grants team.");
  if (!u.tenantId) throw new HttpError(400, "Choose a funder first.", "no-tenant");
}

// ─── What FundingEnvoy has to offer the mapping ──────────────────────────────

function feFields(cat: Catalogue): FeField[] {
  const out = new Map<string, FeField>();
  out.set("request.family", { key: "request.family", label: "Grant family", kind: "enum", required: true, options: cat.families.map((x) => ({ value: x.id, label: x.name })) });
  out.set("request.subtype", { key: "request.subtype", label: "Grant type", kind: "enum", required: true, options: cat.subtypes.map((x) => ({ value: x.id, label: x.name })) });
  for (const s of cat.subtypes) for (const fd of s.fields) {
    const cur = out.get(fd.key);
    if (cur) { cur.required ||= Boolean(fd.required); continue; }
    out.set(fd.key, { key: fd.key, label: fd.label, kind: fd.kind, required: Boolean(fd.required), options: fd.options?.map((o) => ({ value: o, label: o })) });
  }
  return [...out.values()];
}

function feDocTypes(cat: Catalogue): { type: string; label: string }[] {
  const m = new Map<string, string>();
  for (const s of cat.subtypes) for (const d of s.documents) if (!m.has(d.type)) m.set(d.type, d.label);
  return [...m].map(([type, label]) => ({ type, label }));
}

// ─── Suggestions: how FundingEnvoy's fields and values match the org's ───────

const STOP = new Set(["the", "of", "or", "and", "a", "an", "is", "you", "your", "will", "how", "where", "for", "are", "to", "gx", "c", "id", "mainly", "by", "what", "be", "in", "on"]);
const HINTS: Record<string, string[]> = {
  "title": ["name", "title"], "amount.requested": ["requested", "amount"], "amount.currency": ["currency", "isocode"], "activity.startDate": ["start"], "activity.endDate": ["end"],
  "activity.location": ["location", "venue"], "activity.format": ["format"], "audience.geography": ["geographic", "coverage"], "purpose": ["purpose"], "therapeuticArea": ["therapeutic"],
  "provider.name": ["education", "provider"], "provider.accredited": ["accredited"], "audience.expected": ["expected", "learners"], "outcomes.level": ["outcomes", "level"],
  "learningObjectives": ["learning", "objectives"], "programmeDescription": ["programme", "description"], "request.family": ["family"], "request.subtype": ["grant", "type"],
};
const SYN: Record<string, string[]> = { "person": ["live", "person"], "enduring": ["enduring", "material"], "fr": ["france"], "uk": ["uk"], "us": ["us"], "coi": ["conflict", "interest"], "w9": ["w", "9"], "prospectus": ["agenda", "prospectus"], "nonprofit": ["non", "profit"], "registration": ["registration"], "charitable": ["charitable", "contribution"], "education": ["education", "ime"], "moore": ["moore"] };

function tokens(s: string): string[] {
  const raw = s.replace(/__c$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t));
  return [...new Set(raw.flatMap((t) => SYN[t] ?? [t]))];
}
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function jaccard(a: string[], b: string[]) {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter ? inter / new Set([...A, ...B]).size : 0;
}
const KIND_FITS: Record<string, sf.SfType[]> = {
  text: ["string", "textarea"], longtext: ["textarea", "string"], number: ["int", "double", "currency"], money: ["currency", "double"], date: ["date", "datetime"], datetime: ["datetime", "date"],
  enum: ["picklist", "string"], multienum: ["string", "textarea"], boolean: ["boolean"], audience: ["textarea", "string"], list: ["textarea", "string"],
};

function bestValue(feValue: string, feLabel: string, picklist: string[]): { value?: string; score: number } {
  let best: { value?: string; score: number } = { score: 0 };
  for (const p of picklist) {
    const exact = compact(p) === compact(feValue) || compact(p) === compact(feLabel);
    const score = exact ? 1 : Math.max(jaccard(tokens(feValue), tokens(p)), jaccard(tokens(feLabel), tokens(p)));
    if (score > best.score) best = { value: p, score };
  }
  return best.score >= 0.34 ? best : { score: best.score };
}

export function suggestMapping(snap: Snapshot["body"], cat: Catalogue, current: Partial<ConnectorConfig> | undefined, hash: string) {
  const obj = (n: string) => snap.objects.find((o) => o.name === n)!;
  const request = obj("gx__Request__c"), doc = obj("ContentVersion");
  const fields = feFields(cat);
  const system = new Set(["Id", "gx__Account__c", "gx__Requestor__c", "gx__Status__c", "FundingEnvoy_Request_Id__c", "gx__Submitted_Date__c", "gx__Attested_By__c", "gx__Review_Summary__c", "gx__Approved_Amount__c"]);
  const targets = request.fields.filter((x) => !system.has(x.name) && !x.readOnly);
  const used = new Set<string>();
  const reasons: Record<string, string> = {};
  const mapped: { fe: string; sf: string }[] = [];
  // Strongest matches first, so one Salesforce field isn't taken by a weaker candidate.
  const cands: { fe: FeField; sf: (typeof targets)[number]; score: number }[] = [];
  for (const fe of fields) for (const t of targets) {
    if (!(KIND_FITS[fe.kind] ?? ["string"]).includes(t.type as sf.SfType)) continue;
    const a = [...tokens(fe.label), ...tokens(fe.key), ...(HINTS[fe.key] ?? [])];
    const b = [...tokens(t.label), ...tokens(t.name)];
    const hint = (HINTS[fe.key] ?? []).filter((h) => b.includes(h)).length;
    const score = jaccard(a, b) + hint * 0.25 + ((KIND_FITS[fe.kind] ?? [])[0] === t.type ? 0.05 : 0);
    if (score >= 0.3) cands.push({ fe, sf: t, score });
  }
  cands.sort((x, y) => y.score - x.score);
  const taken = new Set<string>();
  for (const c of cands) {
    if (taken.has(c.fe.key) || used.has(c.sf.name)) continue;
    taken.add(c.fe.key); used.add(c.sf.name);
    mapped.push({ fe: c.fe.key, sf: c.sf.name });
    reasons[c.fe.key] = `Label match: “${c.sf.label}”`;
  }
  const keep = current?.fields?.filter((m) => targets.some((t) => t.name === m.sf)) ;
  const finalFields = keep?.length ? keep : mapped;
  const values: Record<string, Record<string, string>> = {};
  const valueReasons: Record<string, Record<string, string>> = {};
  for (const m of finalFields) {
    const fe = fields.find((x) => x.key === m.fe), t = targets.find((x) => x.name === m.sf);
    if (!fe?.options || t?.type !== "picklist") continue;
    values[m.sf] = { ...(current?.values?.[m.sf] ?? {}) };
    valueReasons[m.sf] = {};
    for (const o of fe.options) {
      if (values[m.sf]![o.value]) continue;
      const b = bestValue(o.value, o.label, t.picklist ?? []);
      if (b.value) { values[m.sf]![o.value] = b.value; valueReasons[m.sf]![o.value] = b.score === 1 ? "Same value" : "Similar words"; }
    }
  }
  const cat2 = doc.fields.find((x) => x.name === "gx__Category__c")!.picklist!;
  const documents: Record<string, string> = { ...(current?.documents ?? {}) };
  for (const d of feDocTypes(cat)) if (!documents[d.type]) documents[d.type] = bestValue(d.type, d.label, cat2).value ?? "Other";
  const statusPick = request.fields.find((x) => x.name === "gx__Status__c")!.picklist!;
  const pick = (re: RegExp, dflt: string) => statusPick.find((p) => re.test(p)) ?? dflt;
  const config: ConnectorConfig = {
    system: "salesforce", mode: current?.mode ?? "simulated", enabled: current?.enabled ?? true,
    connection: current?.connection ?? { myDomain: snap.org.myDomain, siteUrl: `https://${snap.org.myDomain.replace(".my.salesforce.com", ".my.site.com")}/grants`, apiVersion: snap.org.apiVersion },
    snapshotHash: hash,
    objects: { organization: "Account", request: "gx__Request__c", document: "ContentVersion", comment: "gx__Comment__c" },
    systemFields: {
      requestOrganization: "gx__Account__c", requestRequestor: "gx__Requestor__c", requestStatus: "gx__Status__c", requestExternalId: "FundingEnvoy_Request_Id__c", requestSubmittedAt: "gx__Submitted_Date__c",
      requestAttestedBy: "gx__Attested_By__c", requestReviewSummary: "gx__Review_Summary__c", organizationTaxId: "gx__Tax_Id__c", organizationCountry: "gx__Country__c", organizationExternalId: "FundingEnvoy_Organization_Id__c",
      documentCategory: "gx__Category__c", documentExternalId: "FundingEnvoy_Document_Id__c", commentRequest: "gx__Request__c", commentBody: "gx__Body__c", commentVisible: "gx__Visible_To_Portal__c", commentAuthor: "gx__Author_Name__c",
    },
    statusValues: current?.statusValues ?? { draft: pick(/draft/i, "Draft"), submitted: pick(/submitted/i, "Submitted"), infoRequested: pick(/information/i, "Information Requested"), approved: pick(/approved/i, "Approved"), declined: pick(/declined|rejected/i, "Declined"), closed: pick(/closed/i, "Closed") },
    fields: finalFields, values, documents,
    matching: current?.matching ?? { identifiers: true, byName: true },
    checkpoints: { organization: true, draft: true, documents: true, submit: true, ...(current?.checkpoints ?? {}) },
    events: current?.events ?? { status: true, comments: true },
  };
  return { config, reasons, valueReasons };
}

// ─── Studio: connect, read, match, try, check ────────────────────────────────

async function latestSnapshot(tx: Tx, tenantId: string): Promise<Snapshot | undefined> {
  return one<Snapshot>(tx, "select hash, body, read_by, read_at from connector_snapshots where tenant_id = $1 and system = $2 order by read_at desc limit 1", [tenantId, SYSTEM]);
}

async function currentConfig(tx: Tx, tenantId: string) {
  const rows = await many<{ version: number; status: string; body: ConnectorConfig; signed_name: string | null; signed_at: Date | null }>(tx,
    "select version, status, body, signed_name, signed_at from config_versions where tenant_id = $1 and kind = 'connector' and status in ('draft','published') order by version desc", [tenantId]);
  return { draft: rows.find((r) => r.status === "draft"), published: rows.find((r) => r.status === "published") };
}

function defaultDomain(slug: string) {
  return `${slug.replace(/[^a-z0-9-]/g, "").slice(0, 30)}-grants.my.salesforce.com`;
}

export async function connectView(u: SessionUser) {
  requireOwner(u);
  return asUser(u, async (tx) => {
    const t = (await one<{ slug: string; name: string }>(tx, "select slug, name from tenants where id = $1", [u.tenantId]))!;
    const snap = await latestSnapshot(tx, u.tenantId!);
    const cfg = await currentConfig(tx, u.tenantId!);
    const cat = (await configVersion<Catalogue>(tx, u.tenantId!, "catalogue"))!.body;
    const body = cfg.draft?.body ?? cfg.published?.body;
    const sugg = snap ? suggestMapping(snap.body, cat, body, snap.hash) : undefined;
    const cursor = await one<{ replay_id: string; updated_at: Date }>(tx, "select replay_id, updated_at from connector_cursors where tenant_id = $1 and system = $2 and channel = $3", [u.tenantId, SYSTEM, sf.EVENT_CHANNEL]);
    const links = await many<{ entity_type: string; n: number }>(tx, "select entity_type, count(*)::int as n from connector_links where tenant_id = $1 and system = $2 group by entity_type", [u.tenantId, SYSTEM]);
    const connected = Boolean(await one(tx, "select 1 from sim_sf_records where tenant_id = $1 limit 1", [u.tenantId]));
    return {
      funder: t.name,
      defaults: { myDomain: defaultDomain(t.slug), apiVersion: sf.ORG.apiVersion },
      connected, limits: connected ? await sf.limits(tx, u.tenantId!) : undefined,
      snapshot: snap ? { hash: snap.hash, readBy: snap.read_by, readAt: snap.read_at, org: snap.body.org, objects: snap.body.objects, validationRules: snap.body.validationRules, duplicateRules: snap.body.duplicateRules, flows: snap.body.flows } : undefined,
      config: body ?? sugg?.config,
      configSource: cfg.draft ? "draft" : cfg.published ? "published" : sugg ? "suggested" : "none",
      draft: cfg.draft ? { version: cfg.draft.version } : undefined,
      published: cfg.published ? { version: cfg.published.version, signedName: cfg.published.signed_name, signedAt: cfg.published.signed_at, enabled: cfg.published.body.enabled } : undefined,
      suggestion: sugg ? { fields: sugg.config.fields, reasons: sugg.reasons, valueReasons: sugg.valueReasons, values: sugg.config.values, documents: sugg.config.documents } : undefined,
      feFields: feFields(cat), feDocTypes: feDocTypes(cat),
      health: { cursor: cursor ? Number(cursor.replay_id) : 0, cursorAt: cursor?.updated_at, links: Object.fromEntries(links.map((l) => [l.entity_type, l.n])) },
      issues: body && snap ? validateConfig(body, snap) : [],
    };
  });
}

export async function testConnection(u: SessionUser, input: { mode: "simulated" | "live"; myDomain: string }) {
  requireOwner(u, true);
  if (input.mode === "live") throw new HttpError(409, "A live connection needs the company's External Client App and network access from FundingEnvoy to its org. Neither is set up yet, so use the simulated org for now.", "live-unavailable");
  if (!/^[a-z0-9-]+\.my\.salesforce\.com$/.test(input.myDomain)) throw new HttpError(400, "My Domain looks like name.my.salesforce.com.");
  return asUser(u, async (tx) => {
    await sf.seedOrg(tx, u.tenantId!);
    await sf.countCalls(tx, u.tenantId!, 2);
    const limits = await sf.limits(tx, u.tenantId!);
    await record(tx, { tenantId: u.tenantId!, actor: SF_ACTOR, entity: { type: "connector", id: SYSTEM }, action: "connector.salesforce.connection-tested", data: { myDomain: input.myDomain, simulated: true, apiVersion: sf.ORG.apiVersion, remaining: limits.DailyApiRequests.Remaining, by: u.name } });
    return { org: { name: sf.ORG.name, edition: sf.ORG.edition, apiVersion: sf.ORG.apiVersion, myDomain: input.myDomain }, limits, identity: { integrationUser: `fundingenvoy.integration@${input.myDomain.split(".")[0]}.example`, profile: "Minimum Access – API Only Integrations", permissionSet: "FundingEnvoy Integration" } };
  });
}

export async function readOrg(u: SessionUser, myDomain?: string) {
  requireOwner(u, true);
  return asUser(u, async (tx) => {
    const t = (await one<{ slug: string }>(tx, "select slug from tenants where id = $1", [u.tenantId]))!;
    const body = sf.describeOrg(myDomain ?? defaultDomain(t.slug));
    const hash = sf.snapshotHash(body);
    const prev = await latestSnapshot(tx, u.tenantId!);
    await tx.query("insert into connector_snapshots (tenant_id, system, hash, body, read_by) values ($1,$2,$3,$4,$5) on conflict (tenant_id, system, hash) do update set read_at = now(), read_by = excluded.read_by", [u.tenantId, SYSTEM, hash, JSON.stringify(body), u.name]);
    await sf.countCalls(tx, u.tenantId!, body.objects.length + 2);
    const changes = prev && prev.hash !== hash ? diffSnapshots(prev.body, body) : [];
    await record(tx, { tenantId: u.tenantId!, actor: SF_ACTOR, entity: { type: "connector", id: SYSTEM }, action: "connector.salesforce.org-read", data: { hash, objects: body.objects.length, fields: body.objects.reduce((n, o) => n + o.fields.length, 0), validationRules: body.validationRules.length, changes, by: u.name } });
    return { hash, objects: body.objects.map((o) => ({ name: o.name, label: o.label, fields: o.fields.length })), validationRules: body.validationRules, changes };
  });
}

function diffSnapshots(a: Snapshot["body"], b: Snapshot["body"]): string[] {
  const out: string[] = [];
  for (const o of b.objects) {
    const p = a.objects.find((x) => x.name === o.name);
    if (!p) { out.push(`New object ${o.label}`); continue; }
    for (const fd of o.fields) {
      const q = p.fields.find((x) => x.name === fd.name);
      if (!q) out.push(`New field ${o.label}: ${fd.label}`);
      else for (const v of fd.picklist ?? []) if (!q.picklist?.includes(v)) out.push(`New value “${v}” in ${o.label}: ${fd.label}`);
    }
  }
  return out;
}

export async function saveConfig(u: SessionUser, body: ConnectorConfig) {
  requireOwner(u, true);
  const cfg = await asUser(u, (tx) => currentConfig(tx, u.tenantId!));
  if (cfg.draft) { await updateDraft(u, "connector", cfg.draft.version, body); return { version: cfg.draft.version }; }
  return createDraft(u, "connector", "Salesforce connection", body);
}

export function validateConfig(c: ConnectorConfig, snap: Snapshot | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (c.mode === "live") issues.push({ severity: "error", message: "A live Salesforce connection needs the company's External Client App and network access to its org. Publish with the simulated org for now." });
  if (!snap) { issues.push({ severity: "error", message: "Read the org first: the mapping needs to know its fields." }); return issues; }
  if (c.snapshotHash && c.snapshotHash !== snap.hash) issues.push({ severity: "error", message: "The org has changed since this mapping was made. Read the org again and check the matches." });
  const req = snap.body.objects.find((o) => o.name === c.objects.request);
  const doc = snap.body.objects.find((o) => o.name === c.objects.document);
  if (!req) { issues.push({ severity: "error", message: `The org has no ${c.objects.request} object.` }); return issues; }
  const sysSet = new Set(Object.values(c.systemFields));
  const seen = new Map<string, string>();
  for (const m of c.fields) {
    const t = req.fields.find((x) => x.name === m.sf);
    if (!t) { issues.push({ severity: "error", where: m.fe, message: `Salesforce has no field ${m.sf} on ${req.label}.` }); continue; }
    if (seen.has(m.sf)) issues.push({ severity: "error", where: m.fe, message: `${t.label} is matched twice (${seen.get(m.sf)} and ${m.fe}).` });
    seen.set(m.sf, m.fe);
  }
  for (const t of req.fields) {
    if (!t.required || t.readOnly || sysSet.has(t.name)) continue;
    if (!c.fields.some((m) => m.sf === t.name)) issues.push({ severity: "error", where: t.name, message: `Salesforce needs ${t.label} on every request. Match a FundingEnvoy field to it.` });
  }
  for (const m of c.fields) {
    const t = req.fields.find((x) => x.name === m.sf);
    if (t?.type !== "picklist") continue;
    const map = c.values[m.sf] ?? {};
    for (const [fv, sv] of Object.entries(map)) if (!t.picklist?.includes(sv)) issues.push({ severity: "error", where: m.sf, message: `“${sv}” is not a value of ${t.label} in Salesforce.` });
    if (!Object.keys(map).length) issues.push({ severity: "error", where: m.sf, message: `Choose which ${t.label} value each FundingEnvoy answer becomes.` });
  }
  const status = req.fields.find((x) => x.name === c.systemFields.requestStatus);
  for (const [k, v] of Object.entries(c.statusValues)) if (!status?.picklist?.includes(v)) issues.push({ severity: "error", where: k, message: `Status “${v}” doesn't exist in Salesforce.` });
  const cats = doc?.fields.find((x) => x.name === c.systemFields.documentCategory)?.picklist ?? [];
  for (const [ty, v] of Object.entries(c.documents)) if (!cats.includes(v)) issues.push({ severity: "warning", where: ty, message: `“${v}” is not a document category in Salesforce; those files will go in as Other.` });
  if (!c.checkpoints.submit) issues.push({ severity: "error", message: "The submit checkpoint can't be switched off: Salesforce has to receive the requestor's submission." });
  return issues;
}

export async function validateStored(tx: Tx, tenantId: string, body: ConnectorConfig): Promise<ValidationIssue[]> {
  const issues = validateConfig(body, await latestSnapshot(tx, tenantId));
  // Every required FundingEnvoy answer should reach Salesforce somewhere; missing ones are only a warning.
  const cat = (await configVersion<Catalogue>(tx, tenantId, "catalogue"))?.body;
  const snap = await latestSnapshot(tx, tenantId);
  const req = snap?.body.objects.find((o) => o.name === body.objects.request);
  if (cat && req) for (const m of body.fields) {
    const fe = feFields(cat).find((x) => x.key === m.fe), t = req.fields.find((x) => x.name === m.sf);
    if (!fe?.options || t?.type !== "picklist") continue;
    const missing = fe.options.filter((o) => !body.values[m.sf]?.[o.value]);
    if (missing.length) issues.push({ severity: "error", where: m.sf, message: `${t.label}: choose the Salesforce value for ${missing.map((o) => `“${o.label}”`).join(", ")} (${fe.label}).` });
  }
  if (cat) for (const fe of feFields(cat).filter((x) => x.required && !body.fields.some((m) => m.fe === x.key))) issues.push({ severity: "warning", where: fe.key, message: `${fe.label} isn't matched to a Salesforce field, so coordinators will see it only in the review summary.` });
  return issues;
}

// ─── Building what is sent ───────────────────────────────────────────────────

function feValue(l: Pick<Loaded, "state">, key: string): unknown {
  if (key === "request.family") return l.state.family;
  if (key === "request.subtype") return l.state.subtype;
  return l.state.fields[key]?.value;
}

function toSf(t: sf.SfField, raw: unknown, values: Record<string, string> | undefined, label: string): unknown {
  if (raw === undefined || raw === null || raw === "") return undefined;
  switch (t.type) {
    case "picklist": {
      const v = values?.[String(raw)] ?? (t.picklist?.includes(String(raw)) ? String(raw) : undefined);
      if (!v) throw new HttpError(409, `The Salesforce mapping has no ${t.label} value for “${String(raw)}” (${label}). Ask the process owner to finish the mapping in Studio.`, "mapping-incomplete");
      return v;
    }
    case "currency": case "double": return toNumber(raw) ?? Number(raw);
    case "int": return Math.round(toNumber(raw) ?? Number(raw));
    case "boolean": return raw === true || raw === "true" || raw === "yes";
    case "datetime": { const s = String(raw); const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T09:00:00Z` : s); return Number.isNaN(d.getTime()) ? undefined : d.toISOString(); }
    case "date": return String(raw).slice(0, 10);
    default: {
      const s = Array.isArray(raw) ? raw.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ") : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
      return s.slice(0, t.length ?? 255);
    }
  }
}

function requestPayload(c: ConnectorConfig, snap: Snapshot["body"], l: Pick<Loaded, "state">, labels: Map<string, string>) {
  const req = snap.objects.find((o) => o.name === c.objects.request)!;
  const out: Record<string, unknown> = {};
  for (const m of c.fields) {
    const t = req.fields.find((x) => x.name === m.sf) as sf.SfField | undefined;
    if (!t) continue;
    const v = toSf(t, feValue(l, m.fe), c.values[m.sf], labels.get(m.fe) ?? m.fe);
    if (v !== undefined) out[m.sf] = v;
  }
  return out;
}

function portalUser(l: Loaded, name: string): sf.SfActor {
  return { id: sf.userIdFor(`${l.row.tenant_id}:${l.row.requestor_id}`), name, via: "portal" };
}

function plainError(e: unknown, c: ConnectorConfig, snap: Snapshot["body"], fields: FeField[]): never {
  if (!(e instanceof sf.SfError)) throw e;
  const req = snap.objects.find((o) => o.name === c.objects.request);
  const where = e.fields.map((n) => {
    const m = c.fields.find((x) => x.sf === n);
    return m ? fields.find((x) => x.key === m.fe)?.label ?? m.fe : req?.fields.find((x) => x.name === n)?.label ?? n;
  });
  throw new HttpError(409, `The grants team's Salesforce didn't accept this yet: ${e.message}${where.length ? ` (${where.join(", ")})` : ""}. Nothing was submitted; fix it here and submit again.`, `salesforce:${e.errorCode}`);
}

async function link(tx: Tx, tenantId: string, type: string, id: string, obj: string, remote: string) {
  await tx.query(`insert into connector_links (tenant_id, system, entity_type, entity_id, remote_object, remote_id) values ($1,$2,$3,$4,$5,$6)
    on conflict (tenant_id, system, entity_type, entity_id) do update set remote_id = excluded.remote_id, remote_object = excluded.remote_object, synced_at = now()`, [tenantId, SYSTEM, type, id, obj, remote]);
}
async function linked(tx: Tx, tenantId: string, type: string, id: string) {
  return (await one<{ remote_id: string }>(tx, "select remote_id from connector_links where tenant_id = $1 and system = $2 and entity_type = $3 and entity_id = $4", [tenantId, SYSTEM, type, id]))?.remote_id;
}

const norm = (s: string) => s.toLowerCase().replace(/\b(the|inc|ltd|llc|association|society)\b/g, "").replace(/[^a-z0-9]/g, "");

async function matchOrganization(tx: Tx, l: Loaded, c: ConnectorConfig, by: sf.SfActor) {
  const t = l.row.tenant_id;
  const known = await linked(tx, t, "organization", l.org.id);
  if (known && await sf.get(tx, t, known)) return { id: known, how: "linked before" };
  const accounts = await sf.list(tx, t, c.objects.organization);
  const ids = Object.values(l.org.identifiers ?? {}).filter(Boolean);
  let hit = c.matching.identifiers ? accounts.find((a) => ids.includes(String(a.fields[c.systemFields.organizationTaxId] ?? ""))) : undefined;
  let how = "tax ID or registration number";
  if (!hit && c.matching.byName) { hit = accounts.find((a) => norm(String(a.fields.Name)) === norm(l.org.legalName)); how = "name"; }
  if (hit) {
    await link(tx, t, "organization", l.org.id, c.objects.organization, hit.id);
    if (!hit.fields[c.systemFields.organizationExternalId]) await sf.update(tx, t, hit.id, { [c.systemFields.organizationExternalId]: l.org.id }, by);
    return { id: hit.id, how };
  }
  const rec = await sf.insert(tx, t, c.objects.organization, {
    Name: l.org.legalName, [c.systemFields.organizationTaxId]: ids[0] ?? null,
    [c.systemFields.organizationCountry]: ["US", "GB", "FR", "DE"].includes(l.org.country) ? l.org.country : "Other",
    [c.systemFields.organizationExternalId]: l.org.id,
  }, by);
  await link(tx, t, "organization", l.org.id, c.objects.organization, rec.id);
  return { id: rec.id, how: "created" };
}

async function pushDocuments(tx: Tx, l: Loaded, c: ConnectorConfig, requestId: string, by: sf.SfActor) {
  const docs = await many<{ id: string; type: string; name: string; size: number; sha256: string }>(tx, "select id, type, name, size, sha256 from documents where request_id = $1 order by created_at", [l.row.id]);
  let sent = 0;
  for (const d of docs) {
    const existing = await sf.list(tx, l.row.tenant_id, c.objects.document, { [c.systemFields.documentExternalId]: d.id });
    if (existing[0]?.fields.Checksum === d.sha256) continue;
    await sf.upsert(tx, l.row.tenant_id, c.objects.document, c.systemFields.documentExternalId, d.id, {
      Title: d.name.replace(/\.[a-z0-9]+$/i, ""), PathOnClient: d.name, FirstPublishLocationId: requestId,
      [c.systemFields.documentCategory]: c.documents[d.type] ?? "Other", ContentSize: d.size, Checksum: d.sha256,
    }, by);
    sent++;
  }
  return { sent, total: docs.length };
}

export async function activeConnector(tx: Tx, tenantId: string) {
  const p = await configVersion<ConnectorConfig>(tx, tenantId, "connector");
  if (!p?.body.enabled) return undefined;
  const snap = await latestSnapshot(tx, tenantId);
  return snap ? { version: p.version, config: p.body, snap } : undefined;
}

/**
 * The four checkpoints, at submission: organization matched or created, request saved as a draft, documents
 * attached, then submitted. Runs inside the submission's transaction, so if Salesforce refuses, nothing is
 * submitted anywhere. With a live org these become REST calls queued through the outbox.
 */
export async function pushSubmission(tx: Tx, l: Loaded, requestor: string, attestedBy: string): Promise<ExternalRecord | undefined> {
  const a = await activeConnector(tx, l.row.tenant_id);
  if (!a) return undefined;
  const { config: c, snap } = a;
  const t = l.row.tenant_id;
  const by = portalUser(l, requestor);
  const cat = l.cfg.catalogue;
  const fields = feFields(cat);
  const labels = new Map(fields.map((x) => [x.key, x.label]));
  try {
    const org = await matchOrganization(tx, l, c, by);
    await record(tx, { tenantId: t, actor: SF_ACTOR, entity: { type: "request", id: l.row.id }, action: "connector.salesforce.checkpoint", data: { requestId: l.row.id, checkpoint: 1, step: "organization", object: c.objects.organization, remoteId: org.id, how: org.how, as: by.name } });
    const payload = { ...requestPayload(c, snap.body, l, labels), [c.systemFields.requestOrganization]: org.id, [c.systemFields.requestRequestor]: by.id, [c.systemFields.requestStatus]: c.statusValues.draft };
    const up = await sf.upsert(tx, t, c.objects.request, c.systemFields.requestExternalId, l.row.id, payload, by);
    await link(tx, t, "request", l.row.id, c.objects.request, up.record.id);
    await record(tx, { tenantId: t, actor: SF_ACTOR, entity: { type: "request", id: l.row.id }, action: "connector.salesforce.checkpoint", data: { requestId: l.row.id, checkpoint: 2, step: "draft", object: c.objects.request, remoteId: up.record.id, created: up.created, fields: Object.keys(payload).length, as: by.name } });
    const docs = await pushDocuments(tx, l, c, up.record.id, by);
    await record(tx, { tenantId: t, actor: SF_ACTOR, entity: { type: "request", id: l.row.id }, action: "connector.salesforce.checkpoint", data: { requestId: l.row.id, checkpoint: 3, step: "documents", object: c.objects.document, sent: docs.sent, total: docs.total, as: by.name } });
    const now = new Date().toISOString();
    await sf.update(tx, t, up.record.id, {
      [c.systemFields.requestStatus]: c.statusValues.submitted, [c.systemFields.requestSubmittedAt]: now, [c.systemFields.requestAttestedBy]: attestedBy.slice(0, 120),
      [c.systemFields.requestReviewSummary]: l.state.reviewSummary?.markdown ?? null,
    }, by);
    await record(tx, { tenantId: t, actor: SF_ACTOR, entity: { type: "request", id: l.row.id }, action: "connector.salesforce.checkpoint", data: { requestId: l.row.id, checkpoint: 4, step: "submit", object: c.objects.request, remoteId: up.record.id, status: c.statusValues.submitted, as: by.name } });
    await sf.countCalls(tx, t, 4 + docs.sent);
    return { system: "salesforce", simulated: true, recordId: up.record.id, organizationId: org.id, status: c.statusValues.submitted, syncedAt: now, connectorVersion: a.version, handledComments: [] };
  } catch (e) {
    plainError(e, c, snap.body, fields);
  }
}

/** After the requestor answers a Salesforce information request: their changes and a note go back, and it's resubmitted. */
export async function pushInfoAnswer(tx: Tx, l: Loaded, ir: InfoRequest, requestor: string) {
  const a = await activeConnector(tx, l.row.tenant_id);
  if (!a || !l.state.external) return;
  const { config: c, snap } = a;
  const t = l.row.tenant_id, id = l.state.external.recordId, by = portalUser(l, requestor);
  const labels = new Map(feFields(l.cfg.catalogue).map((x) => [x.key, x.label]));
  try {
    await sf.update(tx, t, id, requestPayload(c, snap.body, l, labels), by);
    const docs = await pushDocuments(tx, l, c, id, by);
    await sf.insert(tx, t, c.objects.comment, { [c.systemFields.commentRequest]: id, [c.systemFields.commentBody]: `What changed (written by FundingEnvoy for ${by.name}):\n${ir.whatChanged ?? ""}`, [c.systemFields.commentVisible]: true, [c.systemFields.commentAuthor]: `FundingEnvoy for ${by.name}` }, by);
    await sf.update(tx, t, id, { [c.systemFields.requestStatus]: c.statusValues.submitted }, by);
    await sf.countCalls(tx, t, 4 + docs.sent);
    l.state.external = { ...l.state.external, status: c.statusValues.submitted, syncedAt: new Date().toISOString() };
    await record(tx, { tenantId: t, actor: SF_ACTOR, entity: { type: "request", id: l.row.id }, action: "connector.salesforce.answer-written", data: { requestId: l.row.id, remoteId: id, documents: docs.sent, infoRequestId: ir.id, as: by.name } });
  } catch (e) {
    plainError(e, c, snap.body, feFields(l.cfg.catalogue));
  }
}

/** The trial run: the mapping applied to a sample request, sent to the org, and taken back out again. */
export async function trialRun(u: SessionUser, body?: ConnectorConfig) {
  requireOwner(u, true);
  return asUser(u, async (tx) => {
    const snap = await latestSnapshot(tx, u.tenantId!);
    if (!snap) throw new HttpError(409, "Read the org first.");
    const c = body ?? (await currentConfig(tx, u.tenantId!)).draft?.body ?? (await currentConfig(tx, u.tenantId!)).published?.body;
    if (!c) throw new HttpError(409, "Save the mapping first.");
    const cat = (await configVersion<Catalogue>(tx, u.tenantId!, "catalogue"))!.body;
    const fields = feFields(cat);
    const sampleRow = await one<{ id: string; ref: string; state: Loaded["state"] }>(tx, "select id, ref, state from requests where tenant_id = $1 and status <> 'draft' order by submitted_at desc nulls last limit 1", [u.tenantId]);
    const sample: Pick<Loaded, "state"> = sampleRow ? { state: sampleRow.state } : { state: sampleState(cat) };
    const sampleName = sampleRow ? `request ${sampleRow.ref}` : "a sample request made from the catalogue";
    const by: sf.SfActor = { id: sf.userIdFor(`${u.tenantId}:trial`), name: `${u.name} (trial run)`, via: "integration" };
    const accounts = await sf.list(tx, u.tenantId!, c.objects.organization);
    let payload: Record<string, unknown> = {};
    let saved = false;
    try {
      payload = { ...requestPayload(c, snap.body, sample, new Map(fields.map((x) => [x.key, x.label]))), [c.systemFields.requestOrganization]: accounts[0]?.id ?? "001000000000000AAA", [c.systemFields.requestStatus]: c.statusValues.submitted, [c.systemFields.requestSubmittedAt]: new Date().toISOString() };
      await tx.query("savepoint trial");
      saved = true;
      const rec = await sf.insert(tx, u.tenantId!, c.objects.request, { ...payload, [c.systemFields.requestExternalId]: `trial-${randomUUID().slice(0, 18)}` }, by);
      await tx.query("rollback to savepoint trial");
      await sf.countCalls(tx, u.tenantId!, 2);
      await record(tx, { tenantId: u.tenantId!, actor: SF_ACTOR, entity: { type: "connector", id: SYSTEM }, action: "connector.salesforce.trial-run", data: { ok: true, sample: sampleName, fields: Object.keys(payload).length, by: u.name } });
      return { ok: true, sample: sampleName, payload, result: { id: rec.id, success: true, note: "Accepted by Salesforce, then removed again." } };
    } catch (e) {
      if (saved) await tx.query("rollback to savepoint trial");
      const err = e instanceof sf.SfError ? { errorCode: e.errorCode, message: e.message, fields: e.fields } : e instanceof HttpError ? { errorCode: e.code ?? "mapping", message: e.message, fields: [] } : undefined;
      if (!err) throw e;
      await record(tx, { tenantId: u.tenantId!, actor: SF_ACTOR, entity: { type: "connector", id: SYSTEM }, action: "connector.salesforce.trial-run", data: { ok: false, sample: sampleName, error: err.errorCode, by: u.name } });
      return { ok: false, sample: sampleName, payload, result: { success: false, errors: [err] } };
    }
  });
}

function sampleState(cat: Catalogue): Loaded["state"] {
  const s = cat.subtypes[0]!;
  const fields: Record<string, { value: unknown; status: "confirmed" }> = {};
  for (const fd of s.fields) {
    const v = fd.options?.[0] ?? (fd.kind === "money" || fd.kind === "number" ? 25000 : fd.kind === "boolean" ? true : fd.kind === "datetime" ? "2027-09-14T09:00:00Z" : fd.kind === "date" ? "2027-09-14" : fd.key === "title" ? "Sample: Heart failure update for primary care" : `Sample ${fd.label.toLowerCase()}`);
    fields[fd.key] = { value: v, status: "confirmed" };
  }
  if (fields["activity.endDate"]) fields["activity.endDate"].value = "2027-09-15T17:00:00Z";
  return { family: s.family, subtype: s.id, fields } as unknown as Loaded["state"];
}

// ─── Hearing back: the org's platform events ─────────────────────────────────

/** Processes every event after the stored replay ID. Events FundingEnvoy itself caused are skipped. */
export async function drainEvents(tenantId: string) {
  return withContext({ tenantId }, async (tx) => {
    const a = await activeConnector(tx, tenantId);
    if (!a) return { processed: 0 };
    const cur = Number((await one<{ replay_id: string }>(tx, "select replay_id from connector_cursors where tenant_id = $1 and system = $2 and channel = $3", [tenantId, SYSTEM, sf.EVENT_CHANNEL]))?.replay_id ?? 0);
    const evs = await sf.eventsAfter(tx, tenantId, cur);
    let processed = 0, last = cur;
    for (const ev of evs) {
      last = Number(ev.replay_id);
      const p = ev.payload as { Kind__c: string; Request_Id__c: string; FundingEnvoy_Request_Id__c?: string; Status__c?: string; Body__c?: string; Comment_Id__c?: string; Approved_Amount__c?: number; Changed_By__c: sf.SfActor };
      if (p.Changed_By__c?.via !== "salesforce" || !p.FundingEnvoy_Request_Id__c) continue;
      if (p.Kind__c === "status" && !a.config.events.status) continue;
      if (p.Kind__c === "comment" && !a.config.events.comments) continue;
      await applyEvent(tx, a.config, p, Number(ev.replay_id));
      processed++;
    }
    if (evs.length) {
      await tx.query(`insert into connector_cursors (tenant_id, system, channel, replay_id) values ($1,$2,$3,$4)
        on conflict (tenant_id, system, channel) do update set replay_id = excluded.replay_id, updated_at = now()`, [tenantId, SYSTEM, sf.EVENT_CHANNEL, last]);
    }
    return { processed, replayId: last };
  });
}

async function applyEvent(tx: Tx, c: ConnectorConfig, p: { Kind__c: string; Request_Id__c: string; FundingEnvoy_Request_Id__c?: string; Status__c?: string; Body__c?: string; Comment_Id__c?: string; Approved_Amount__c?: number; Changed_By__c: sf.SfActor }, replayId: number) {
  const l = await loadRequest(tx, p.FundingEnvoy_Request_Id__c!);
  if (!l.state.external) return;
  const t = l.row.tenant_id;
  const who: Actor = { type: "person", id: p.Changed_By__c.id, name: `${p.Changed_By__c.name} (in Salesforce)` };
  const s = await one<{ settings: { words?: { assistantName?: string } } }>(tx, "select settings from tenants where id = $1", [t]);
  const fe: Actor = { type: "agent", id: "fundingenvoy", name: s?.settings.words?.assistantName ?? "FundingEnvoy" };
  const ext = l.state.external;
  const handled = new Set(ext.handledComments ?? []);
  const now = new Date().toISOString();
  await record(tx, { tenantId: t, actor: SF_ACTOR, entity: { type: "request", id: l.row.id }, action: "connector.salesforce.event-received", data: { requestId: l.row.id, replayId, kind: p.Kind__c, status: p.Status__c, by: p.Changed_By__c.name } });
  if (p.Kind__c === "status" && p.Status__c === c.statusValues.infoRequested) {
    // The coordinator's question is the latest portal-visible comment on the request.
    const comments = (await sf.list(tx, t, c.objects.comment, { [c.systemFields.commentRequest]: p.Request_Id__c, [c.systemFields.commentVisible]: true }))
      .filter((x) => x.createdBy.via === "salesforce" && !handled.has(x.id));
    await sf.countCalls(tx, t, 1);
    const q = comments[0];
    const text = String(q?.fields[c.systemFields.commentBody] ?? "Please see the grants team's request in the portal.");
    if (q) handled.add(q.id);
    const due = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const ir: InfoRequest = { id: randomUUID(), by: who, at: now, status: "open", dueAt: due, questions: [{ id: randomUUID(), text }] };
    await saveState(tx, l, { infoRequests: [...(l.state.infoRequests ?? []), ir], status: "info-requested", external: { ...ext, status: p.Status__c, syncedAt: now, handledComments: [...handled] } });
    await record(tx, { tenantId: t, actor: who, entity: { type: "request", id: l.row.id }, action: "info.requested", data: { requestId: l.row.id, infoRequestId: ir.id, questions: [text], dueAt: due, via: "salesforce" } });
    await addMessage(tx, l, fe, `${p.Changed_By__c.name} from the grants team asked a question on ${now.slice(0, 10)}. Please answer by ${due}:\n\n1. "${text}"\n\nOnly this is open; the rest of your request stays as it is. When you're done I'll send your answer back with a short "what changed" note.`, { infoRequest: ir.id });
    await tx.query("insert into tasks (tenant_id, request_id, kind, title, assignee_role, due_at, data) values ($1,$2,'info-request',$3,'requestor',$4,$5)", [t, l.row.id, "Answer a question from the grants team", due, { infoRequestId: ir.id }]);
    return;
  }
  if (p.Kind__c === "status" && (p.Status__c === c.statusValues.approved || p.Status__c === c.statusValues.declined || p.Status__c === c.statusValues.closed)) {
    const approved = p.Status__c === c.statusValues.approved, closed = p.Status__c === c.statusValues.closed;
    const amount = approved ? Number(p.Approved_Amount__c ?? l.row.amount ?? 0) : undefined;
    const patch = closed ? { status: "closed" as const } : {
      status: approved ? "approved" as const : "declined" as const, decidedAt: now,
      decision: { outcome: approved ? "approve" as const : "decline" as const, amount, rationale: "Decided in the grants team's Salesforce.", by: who, at: now },
    };
    await saveState(tx, l, { ...patch, external: { ...ext, status: p.Status__c!, syncedAt: now } });
    if (!closed) await tx.query("update requests set decided_at = now() where id = $1", [l.row.id]);
    const money = amount !== undefined ? ` for ${new Intl.NumberFormat("en-US", { style: "currency", currency: String(l.row.currency ?? "USD"), maximumFractionDigits: 0 }).format(amount)}` : "";
    await addMessage(tx, l, fe, closed ? `The grants team has closed ${l.row.ref}.` : approved ? `Good news: ${l.row.ref} was approved${money} on ${now.slice(0, 10)}. The grants team will send the agreement through their usual process.` : `${l.row.ref} was declined on ${now.slice(0, 10)}. The grants team's message, if any, is in your portal.`, { decision: p.Status__c });
    return;
  }
  if (p.Kind__c === "comment" && p.Comment_Id__c && !handled.has(p.Comment_Id__c)) {
    // A plain comment without a status change: show it to the requestor, unless it is the question already handled.
    const after = await sf.get(tx, t, p.Request_Id__c);
    if (after?.fields[c.systemFields.requestStatus] === c.statusValues.infoRequested) return;
    handled.add(p.Comment_Id__c);
    await saveState(tx, l, { external: { ...ext, handledComments: [...handled], syncedAt: now } });
    await addMessage(tx, l, fe, `${p.Changed_By__c.name} from the grants team wrote: "${p.Body__c ?? ""}"`, { salesforceComment: p.Comment_Id__c });
  }
}

// ─── The simulated org's own screens: what a coordinator sees in Salesforce ──

export async function simConsole(u: SessionUser) {
  requireOwner(u);
  return asUser(u, async (tx) => {
    const a = await activeConnector(tx, u.tenantId!);
    const reqs = await sf.list(tx, u.tenantId!, "gx__Request__c");
    const accounts = await sf.list(tx, u.tenantId!, "Account");
    const files = await sf.list(tx, u.tenantId!, "ContentVersion");
    const comments = await sf.list(tx, u.tenantId!, "gx__Comment__c");
    const cursor = Number((await one<{ replay_id: string }>(tx, "select replay_id from connector_cursors where tenant_id = $1 and system = $2 and channel = $3", [u.tenantId, SYSTEM, sf.EVENT_CHANNEL]))?.replay_id ?? 0);
    const events = (await sf.eventsAfter(tx, u.tenantId!, 0)).slice(-30).reverse();
    const refs = await many<{ id: string; ref: string }>(tx, "select id, ref from requests where tenant_id = $1 and id = any($2)", [u.tenantId, reqs.map((r) => String(r.fields.FundingEnvoy_Request_Id__c ?? "")).filter((x) => /^[0-9a-f-]{36}$/.test(x))]);
    return {
      connected: Boolean(accounts.length), active: Boolean(a), myDomain: a?.config.connection.myDomain, statusValues: a?.config.statusValues,
      objects: sf.OBJECTS.map((o) => ({ name: o.name, label: o.label, fields: o.fields.map((x) => ({ name: x.name, label: x.label, type: x.type })) })),
      requests: reqs.map((r) => ({
        ...r, ref: refs.find((x) => x.id === r.fields.FundingEnvoy_Request_Id__c)?.ref,
        account: accounts.find((x) => x.id === r.fields.gx__Account__c)?.fields.Name,
        files: files.filter((x) => x.fields.FirstPublishLocationId === r.id),
        comments: comments.filter((x) => x.fields.gx__Request__c === r.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
      })),
      accounts: accounts.map((x) => ({ id: x.id, name: x.fields.Name, taxId: x.fields.gx__Tax_Id__c, createdBy: x.createdBy, createdAt: x.createdAt, fromFundingEnvoy: Boolean(x.fields.FundingEnvoy_Organization_Id__c) })),
      events: events.map((e) => ({ replayId: Number(e.replay_id), uuid: e.event_uuid, at: e.created_at, payload: e.payload, processed: Number(e.replay_id) <= cursor })),
      cursor,
    };
  });
}

export async function simAct(u: SessionUser, sfId: string, input: { action: "request-info" | "approve" | "decline" | "comment"; text?: string; amount?: number }) {
  if (!u.roles.some((r) => ["coordinator", "process-owner", "committee-chair", "operator"].includes(r)) && u.kind !== "operator") throw new HttpError(403, "Only the grants team can act on a request in Salesforce.");
  await asUser(u, async (tx) => {
    const a = await activeConnector(tx, u.tenantId!);
    if (!a) throw new HttpError(409, "Salesforce isn't connected for this funder.");
    const c = a.config;
    const rec = await sf.get(tx, u.tenantId!, sfId);
    if (!rec || rec.object !== c.objects.request) throw new HttpError(404, "No such request in Salesforce.");
    const by: sf.SfActor = { id: sf.userIdFor(`${u.tenantId}:${u.id}`), name: u.name, via: "salesforce" };
    const text = input.text?.trim();
    try {
      if (input.action === "request-info") {
        if (!text) throw new HttpError(400, "Write the question for the requestor.");
        await sf.update(tx, u.tenantId!, sfId, { [c.systemFields.requestStatus]: c.statusValues.infoRequested }, by);
        await sf.insert(tx, u.tenantId!, c.objects.comment, { [c.systemFields.commentRequest]: sfId, [c.systemFields.commentBody]: text, [c.systemFields.commentVisible]: true, [c.systemFields.commentAuthor]: u.name }, by);
      } else if (input.action === "comment") {
        if (!text) throw new HttpError(400, "Write the comment.");
        await sf.insert(tx, u.tenantId!, c.objects.comment, { [c.systemFields.commentRequest]: sfId, [c.systemFields.commentBody]: text, [c.systemFields.commentVisible]: true, [c.systemFields.commentAuthor]: u.name }, by);
      } else if (input.action === "approve") {
        const amount = input.amount ?? Number(rec.fields.gx__Requested_Amount__c ?? 0);
        await sf.update(tx, u.tenantId!, sfId, { gx__Approved_Amount__c: amount, [c.systemFields.requestStatus]: c.statusValues.approved }, by);
      } else {
        if (text) await sf.insert(tx, u.tenantId!, c.objects.comment, { [c.systemFields.commentRequest]: sfId, [c.systemFields.commentBody]: text, [c.systemFields.commentVisible]: true, [c.systemFields.commentAuthor]: u.name }, by);
        await sf.update(tx, u.tenantId!, sfId, { [c.systemFields.requestStatus]: c.statusValues.declined }, by);
      }
    } catch (e) {
      if (e instanceof sf.SfError) throw new HttpError(409, `Salesforce refused: ${e.message}`, `salesforce:${e.errorCode}`);
      throw e;
    }
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "connector", id: SYSTEM }, action: "connector.salesforce.sim-action", data: { remoteId: sfId, action: input.action, simulated: true } });
  });
  return drainEvents(u.tenantId!);
}

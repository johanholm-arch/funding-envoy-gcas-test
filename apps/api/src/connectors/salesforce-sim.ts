// A simulated Salesforce org running a packaged grants app ("Grants Exchange", namespace gx), for the demo and the
// tests. It behaves the way the connector needs a real org to behave: objects and picklists that can be described,
// required fields, restricted picklists, validation rules and a duplicate rule that refuse bad writes with
// Salesforce's error codes, upsert on an external ID, a Flow that publishes a platform event when a request's status
// changes or a coordinator comments, and a daily API budget. Records live in sim_sf_records, per funder.
import { createHash, randomBytes } from "node:crypto";
import { many, one, type Tx } from "@fe/db";

export type SfType = "id" | "string" | "textarea" | "currency" | "double" | "int" | "boolean" | "date" | "datetime" | "picklist" | "reference";
export interface SfField { name: string; label: string; type: SfType; length?: number; required?: boolean; externalId?: boolean; picklist?: string[]; referenceTo?: string; readOnly?: boolean }
export interface SfObject { name: string; label: string; prefix: string; fields: SfField[] }
export interface SfRule { object: string; name: string; description: string; errorMessage: string; errorField?: string; when: (r: Record<string, unknown>) => boolean }
export interface SfActor { id: string; name: string; via: "portal" | "integration" | "salesforce" }
export interface SfRecord { id: string; object: string; fields: Record<string, unknown>; createdBy: SfActor; modifiedBy: SfActor; createdAt: string; modifiedAt: string }

export class SfError extends Error {
  constructor(public readonly errorCode: string, message: string, public readonly fields: string[] = []) { super(message); }
}

export const ORG = { name: "Grants Exchange (simulated)", edition: "Enterprise Edition", apiVersion: "66.0", namespace: "gx", licences: 40 };
export const EVENT_CHANNEL = "/event/FundingEnvoy_Request_Change__e";

const STATUS = ["Draft", "Submitted for Review", "Additional Information Requested", "Approved", "Declined", "Closed"];
const f = (name: string, label: string, type: SfType, more: Partial<SfField> = {}): SfField => ({ name, label, type, ...more });

export const OBJECTS: SfObject[] = [
  { name: "Account", label: "Organization", prefix: "001", fields: [
    f("Id", "Record ID", "id", { readOnly: true }),
    f("Name", "Organization Name", "string", { length: 255, required: true }),
    f("gx__Tax_Id__c", "Tax ID or Registration Number", "string", { length: 40 }),
    f("gx__Country__c", "Country", "picklist", { picklist: ["US", "GB", "FR", "DE", "Other"] }),
    f("BillingCity", "City", "string", { length: 40 }),
    f("gx__Organization_Type__c", "Organization Type", "picklist", { picklist: ["Medical Society", "Hospital", "University", "Patient Organization", "Education Provider", "Charity", "Other"] }),
    f("FundingEnvoy_Organization_Id__c", "FundingEnvoy Organization ID", "string", { length: 40, externalId: true }),
  ] },
  { name: "gx__Payee__c", label: "Payee", prefix: "a0Z", fields: [
    f("Id", "Record ID", "id", { readOnly: true }),
    f("Name", "Payee Name", "string", { length: 80, required: true }),
    f("gx__Account__c", "Organization", "reference", { referenceTo: "Account", required: true }),
    f("gx__Verified__c", "Bank Details Verified", "boolean"),
  ] },
  { name: "gx__Request__c", label: "Grant Request", prefix: "a0X", fields: [
    f("Id", "Record ID", "id", { readOnly: true }),
    f("Name", "Request Title", "string", { length: 80, required: true }),
    f("gx__Account__c", "Organization", "reference", { referenceTo: "Account", required: true }),
    f("gx__Requestor__c", "Requestor", "reference", { referenceTo: "User" }),
    f("gx__Status__c", "Status", "picklist", { required: true, picklist: STATUS }),
    f("gx__Grant_Family__c", "Grant Family", "picklist", { picklist: ["Independent Medical Education", "Charitable Contribution"] }),
    f("gx__Grant_Type__c", "Grant Type", "picklist", { required: true, picklist: ["IME - Accredited", "IME - Non-Accredited", "Charitable Contribution - General", "Charitable Contribution - Programme"] }),
    f("gx__Requested_Amount__c", "Requested Amount", "currency", { required: true }),
    f("CurrencyIsoCode", "Currency", "picklist", { required: true, picklist: ["USD", "GBP", "EUR"] }),
    f("gx__Start_Date_Time__c", "Start Date/Time", "datetime"),
    f("gx__End_Date_Time__c", "End Date/Time", "datetime"),
    f("gx__Location__c", "Venue or Location", "string", { length: 255 }),
    f("gx__Format__c", "Format", "picklist", { picklist: ["Live", "Virtual", "Hybrid", "Enduring Material"] }),
    f("gx__Geographic_Coverage__c", "Geographic Coverage", "picklist", { picklist: ["Mainly US", "Mainly UK", "Mainly France", "International", "Low-Middle Income Countries"] }),
    f("gx__Purpose__c", "Purpose", "textarea", { length: 32768 }),
    f("gx__Therapeutic_Area__c", "Therapeutic Area", "string", { length: 120 }),
    f("gx__Education_Provider__c", "Education Provider", "string", { length: 255 }),
    f("gx__Accredited__c", "Accredited Provider", "boolean"),
    f("gx__Expected_Learners__c", "Expected Learners", "int"),
    f("gx__Outcomes_Level__c", "Outcomes Level", "picklist", { picklist: ["Moore 1", "Moore 2", "Moore 3A", "Moore 3B", "Moore 4", "Moore 5", "Moore 6", "Moore 7"] }),
    f("gx__Learning_Objectives__c", "Learning Objectives", "textarea", { length: 32768 }),
    f("gx__Programme_Description__c", "Programme Description", "textarea", { length: 32768 }),
    f("gx__Submitted_Date__c", "Submitted Date", "datetime"),
    f("gx__Attested_By__c", "Attested By (typed name)", "string", { length: 120 }),
    f("gx__Review_Summary__c", "Pre-Submission Review Summary", "textarea", { length: 131072 }),
    f("gx__Approved_Amount__c", "Approved Amount", "currency"),
    f("FundingEnvoy_Request_Id__c", "FundingEnvoy Request ID", "string", { length: 40, externalId: true }),
  ] },
  { name: "ContentVersion", label: "File", prefix: "068", fields: [
    f("Id", "Record ID", "id", { readOnly: true }),
    f("Title", "Title", "string", { length: 255, required: true }),
    f("PathOnClient", "File Name", "string", { length: 500, required: true }),
    f("FirstPublishLocationId", "Linked To", "reference", { referenceTo: "gx__Request__c", required: true }),
    f("gx__Category__c", "Document Category", "picklist", { picklist: ["Request Letter", "Budget", "Agenda or Prospectus", "Financial Statement", "Conflict of Interest Policy", "Accreditation", "W-9", "Non-Profit Status", "Charity Registration", "Bylaws", "Programme Description", "Other"] }),
    f("ContentSize", "Size (bytes)", "int"),
    f("Checksum", "Checksum", "string", { length: 64 }),
    f("FundingEnvoy_Document_Id__c", "FundingEnvoy Document ID", "string", { length: 40, externalId: true }),
  ] },
  { name: "gx__Comment__c", label: "Request Comment", prefix: "a0Y", fields: [
    f("Id", "Record ID", "id", { readOnly: true }),
    f("gx__Request__c", "Request", "reference", { referenceTo: "gx__Request__c", required: true }),
    f("gx__Body__c", "Comment", "textarea", { length: 32768, required: true }),
    f("gx__Visible_To_Portal__c", "Visible to Requestor", "boolean"),
    f("gx__Author_Name__c", "Author", "string", { length: 120 }),
  ] },
];

const val = (r: Record<string, unknown>, k: string) => r[k];
export const RULES: SfRule[] = [
  { object: "gx__Request__c", name: "End_After_Start", description: "The activity ends after it starts.", errorMessage: "End Date/Time must be after Start Date/Time.", errorField: "gx__End_Date_Time__c",
    when: (r) => Boolean(val(r, "gx__Start_Date_Time__c") && val(r, "gx__End_Date_Time__c") && String(val(r, "gx__End_Date_Time__c")) < String(val(r, "gx__Start_Date_Time__c"))) },
  { object: "gx__Request__c", name: "Positive_Amount", description: "The requested amount is more than zero.", errorMessage: "Requested Amount must be greater than zero.", errorField: "gx__Requested_Amount__c",
    when: (r) => Number(val(r, "gx__Requested_Amount__c") ?? 0) <= 0 },
  { object: "gx__Request__c", name: "Dates_To_Submit", description: "A submitted education request has a start date.", errorMessage: "Start Date/Time is required to submit an education request.", errorField: "gx__Start_Date_Time__c",
    when: (r) => val(r, "gx__Status__c") === "Submitted for Review" && String(val(r, "gx__Grant_Type__c") ?? "").startsWith("IME") && !val(r, "gx__Start_Date_Time__c") },
  { object: "gx__Request__c", name: "Provider_For_Accredited", description: "Accredited education names its provider.", errorMessage: "Education Provider is required for accredited education.", errorField: "gx__Education_Provider__c",
    when: (r) => val(r, "gx__Grant_Type__c") === "IME - Accredited" && val(r, "gx__Status__c") === "Submitted for Review" && !val(r, "gx__Education_Provider__c") },
];

export function object(name: string): SfObject {
  const o = OBJECTS.find((x) => x.name === name);
  if (!o) throw new SfError("INVALID_TYPE", `sObject type '${name}' is not supported.`);
  return o;
}

/** The org's description: what a real connector reads with describe, the UI API and the Tooling API. */
export function describeOrg(myDomain: string) {
  return {
    org: { ...ORG, myDomain },
    objects: OBJECTS.map((o) => ({ name: o.name, label: o.label, fields: o.fields.map(({ name, label, type, length, required, externalId, picklist, referenceTo, readOnly }) => ({ name, label, type, length, required, externalId, picklist, referenceTo, readOnly })) })),
    validationRules: RULES.map(({ object, name, description, errorMessage, errorField }) => ({ object, name, description, errorMessage, errorField })),
    duplicateRules: [{ object: "Account", name: "Same_Tax_Id", description: "Two organizations can't share a tax ID or registration number." }],
    flows: [{ name: "FundingEnvoy_Request_Change", description: "Publishes FundingEnvoy_Request_Change__e when a request's status changes or a coordinator adds a portal-visible comment." }],
  };
}

export function snapshotHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function newId(prefix: string): string {
  return prefix + "8d" + [...randomBytes(13)].map((b) => B62[b % 62]).join("");
}
export function userIdFor(key: string): string {
  const h = createHash("sha256").update(key).digest();
  return "0058d" + [...h.subarray(0, 13)].map((b) => B62[b % 62]).join("");
}

export async function countCalls(tx: Tx, tenantId: string, n = 1) {
  await tx.query("insert into sim_sf_usage (tenant_id, day, calls) values ($1, current_date, $2) on conflict (tenant_id, day) do update set calls = sim_sf_usage.calls + $2", [tenantId, n]);
}

export async function limits(tx: Tx, tenantId: string) {
  const used = (await one<{ calls: number }>(tx, "select calls from sim_sf_usage where tenant_id = $1 and day = current_date", [tenantId]))?.calls ?? 0;
  const max = 100_000 + ORG.licences * 1000;
  return { DailyApiRequests: { Max: max, Remaining: max - used } };
}

function rowToRecord(r: { id: string; object: string; fields: Record<string, unknown>; created_by: SfActor; modified_by: SfActor; created_at: Date; modified_at: Date }): SfRecord {
  return { id: r.id, object: r.object, fields: r.fields, createdBy: r.created_by, modifiedBy: r.modified_by, createdAt: r.created_at.toISOString(), modifiedAt: r.modified_at.toISOString() };
}

export async function get(tx: Tx, tenantId: string, id: string): Promise<SfRecord | undefined> {
  const r = await one<Parameters<typeof rowToRecord>[0]>(tx, "select id, object, fields, created_by, modified_by, created_at, modified_at from sim_sf_records where tenant_id = $1 and id = $2", [tenantId, id]);
  return r ? rowToRecord(r) : undefined;
}

export async function list(tx: Tx, tenantId: string, obj: string, where: Record<string, unknown> = {}): Promise<SfRecord[]> {
  const rows = await many<Parameters<typeof rowToRecord>[0]>(tx, "select id, object, fields, created_by, modified_by, created_at, modified_at from sim_sf_records where tenant_id = $1 and object = $2 and fields @> $3 order by modified_at desc", [tenantId, obj, JSON.stringify(where)]);
  return rows.map(rowToRecord);
}

function check(o: SfObject, fields: Record<string, unknown>, merged: Record<string, unknown>) {
  for (const [k, v] of Object.entries(fields)) {
    const d = o.fields.find((x) => x.name === k);
    if (!d) throw new SfError("INVALID_FIELD", `No such column '${k}' on entity '${o.name}'.`, [k]);
    if (d.readOnly) throw new SfError("INVALID_FIELD_FOR_INSERT_UPDATE", `Unable to create/update field: ${k}`, [k]);
    if (v === null || v === undefined || v === "") continue;
    if (d.type === "picklist" && !d.picklist!.includes(String(v))) throw new SfError("INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", `${d.label}: bad value for restricted picklist field: ${String(v)}`, [k]);
    if ((d.type === "string" || d.type === "textarea") && String(v).length > (d.length ?? 255)) throw new SfError("STRING_TOO_LONG", `${d.label}: data value too large: ${String(v).slice(0, 40)}… (max length=${d.length})`, [k]);
    if ((d.type === "currency" || d.type === "double" || d.type === "int") && !Number.isFinite(Number(v))) throw new SfError("INVALID_TYPE_ON_FIELD_IN_RECORD", `${d.label}: value not of required type: ${String(v)}`, [k]);
    if (d.type === "datetime" && Number.isNaN(Date.parse(String(v)))) throw new SfError("INVALID_TYPE_ON_FIELD_IN_RECORD", `${d.label}: value not of required type: ${String(v)}`, [k]);
  }
  const missing = o.fields.filter((d) => d.required && (merged[d.name] === undefined || merged[d.name] === null || merged[d.name] === ""));
  if (missing.length) throw new SfError("REQUIRED_FIELD_MISSING", `Required fields are missing: [${missing.map((d) => d.name).join(", ")}]`, missing.map((d) => d.name));
  for (const r of RULES.filter((x) => x.object === o.name)) if (r.when(merged)) throw new SfError("FIELD_CUSTOM_VALIDATION_EXCEPTION", r.errorMessage, r.errorField ? [r.errorField] : []);
}

async function emit(tx: Tx, tenantId: string, payload: Record<string, unknown>) {
  await tx.query("insert into sim_sf_events (tenant_id, channel, payload) values ($1, $2, $3)", [tenantId, EVENT_CHANNEL, JSON.stringify({ ...payload, CreatedDate: new Date().toISOString() })]);
}

/** The org's record-triggered Flow: a status change, or a coordinator's portal-visible comment, publishes an event. */
async function flow(tx: Tx, tenantId: string, rec: SfRecord, before: Record<string, unknown> | undefined, by: SfActor) {
  if (rec.object === "gx__Request__c" && before?.gx__Status__c !== rec.fields.gx__Status__c) {
    await emit(tx, tenantId, { Kind__c: "status", Request_Id__c: rec.id, FundingEnvoy_Request_Id__c: rec.fields.FundingEnvoy_Request_Id__c, Status__c: rec.fields.gx__Status__c, Previous_Status__c: before?.gx__Status__c ?? null, Approved_Amount__c: rec.fields.gx__Approved_Amount__c ?? null, Changed_By__c: by });
  }
  if (rec.object === "gx__Comment__c" && !before && rec.fields.gx__Visible_To_Portal__c) {
    const req = await get(tx, tenantId, String(rec.fields.gx__Request__c));
    await emit(tx, tenantId, { Kind__c: "comment", Request_Id__c: rec.fields.gx__Request__c, FundingEnvoy_Request_Id__c: req?.fields.FundingEnvoy_Request_Id__c, Comment_Id__c: rec.id, Body__c: rec.fields.gx__Body__c, Changed_By__c: by });
  }
}

export async function insert(tx: Tx, tenantId: string, obj: string, fields: Record<string, unknown>, by: SfActor): Promise<SfRecord> {
  const o = object(obj);
  check(o, fields, fields);
  if (obj === "Account" && fields.gx__Tax_Id__c) {
    const dup = await list(tx, tenantId, "Account", { gx__Tax_Id__c: fields.gx__Tax_Id__c });
    if (dup.length) throw new SfError("DUPLICATES_DETECTED", `An organization with this tax ID already exists: ${dup[0]!.fields.Name} (${dup[0]!.id}).`, ["gx__Tax_Id__c"]);
  }
  const id = newId(o.prefix);
  const row = (await one<Parameters<typeof rowToRecord>[0]>(tx, "insert into sim_sf_records (tenant_id, id, object, fields, created_by, modified_by) values ($1,$2,$3,$4,$5,$5) returning id, object, fields, created_by, modified_by, created_at, modified_at",
    [tenantId, id, obj, JSON.stringify(fields), JSON.stringify(by)]))!;
  const rec = rowToRecord(row);
  await flow(tx, tenantId, rec, undefined, by);
  return rec;
}

export async function update(tx: Tx, tenantId: string, id: string, fields: Record<string, unknown>, by: SfActor): Promise<SfRecord> {
  const cur = await get(tx, tenantId, id);
  if (!cur) throw new SfError("ENTITY_IS_DELETED", "entity is deleted", []);
  const o = object(cur.object);
  const merged = { ...cur.fields, ...fields };
  check(o, fields, merged);
  const row = (await one<Parameters<typeof rowToRecord>[0]>(tx, "update sim_sf_records set fields = $3, modified_by = $4, modified_at = now() where tenant_id = $1 and id = $2 returning id, object, fields, created_by, modified_by, created_at, modified_at",
    [tenantId, id, JSON.stringify(merged), JSON.stringify(by)]))!;
  const rec = rowToRecord(row);
  await flow(tx, tenantId, rec, cur.fields, by);
  return rec;
}

/** Upsert on an external ID field: the same FundingEnvoy ID always lands on the same record. */
export async function upsert(tx: Tx, tenantId: string, obj: string, extField: string, extValue: string, fields: Record<string, unknown>, by: SfActor): Promise<{ record: SfRecord; created: boolean }> {
  const d = object(obj).fields.find((x) => x.name === extField);
  if (!d?.externalId) throw new SfError("INVALID_FIELD", `${extField} is not an external ID field on ${obj}.`, [extField]);
  const found = await list(tx, tenantId, obj, { [extField]: extValue });
  if (found.length > 1) throw new SfError("MULTIPLE_RECORDS", `More than one ${obj} has ${extField} = ${extValue}.`, [extField]);
  if (found[0]) return { record: await update(tx, tenantId, found[0].id, fields, by), created: false };
  return { record: await insert(tx, tenantId, obj, { ...fields, [extField]: extValue }, by), created: true };
}

export async function remove(tx: Tx, tenantId: string, id: string) {
  await tx.query("delete from sim_sf_records where tenant_id = $1 and (id = $2 or fields->>'FirstPublishLocationId' = $2 or fields->>'gx__Request__c' = $2)", [tenantId, id]);
}

export async function eventsAfter(tx: Tx, tenantId: string, replayId: number) {
  return many<{ replay_id: string; event_uuid: string; payload: Record<string, unknown>; created_at: Date }>(tx,
    "select replay_id, event_uuid, payload, created_at from sim_sf_events where tenant_id = $1 and channel = $2 and replay_id > $3 order by replay_id", [tenantId, EVENT_CHANNEL, replayId]);
}

/** First connection: the org already holds the organizations the grants team has worked with, like a real org would. */
export async function seedOrg(tx: Tx, tenantId: string) {
  const has = await one<{ n: number }>(tx, "select count(*)::int as n from sim_sf_records where tenant_id = $1", [tenantId]);
  if (has?.n) return;
  const orgs = await many<{ id: string; legal_name: string; type: string; country: string; identifiers: Record<string, string>; data: { address?: string } }>(tx,
    "select o.id, o.legal_name, o.type, o.country, o.identifiers, o.data from organizations o join org_shares s on s.org_id = o.id and s.tenant_id = $1 order by o.legal_name", [tenantId]);
  const admin: SfActor = { id: userIdFor(`${tenantId}:admin`), name: "Grants admin", via: "salesforce" };
  const typeOf: Record<string, string> = { association: "Medical Society", society: "Medical Society", hospital: "Hospital", university: "University", "patient-organization": "Patient Organization", charity: "Charity", provider: "Education Provider" };
  // Two in three are already there; the rest are new to this org, so the demo shows both matching and creating.
  for (const [i, o] of orgs.entries()) {
    if (i % 3 === 2) continue;
    const city = /,\s*([^,]+?),\s*[A-Z]{2}\s*\d/.exec(o.data.address ?? "")?.[1] ?? /,\s*([A-Za-zÀ-ÿ' -]+)\s*,\s*[A-Z]{2}$/.exec(o.data.address ?? "")?.[1];
    const rec = await insert(tx, tenantId, "Account", {
      Name: o.legal_name, gx__Tax_Id__c: Object.values(o.identifiers ?? {})[0] ?? null, gx__Country__c: ["US", "GB", "FR", "DE"].includes(o.country) ? o.country : "Other",
      BillingCity: city ?? null, gx__Organization_Type__c: typeOf[o.type] ?? "Other",
    }, admin);
    await insert(tx, tenantId, "gx__Payee__c", { Name: `${o.legal_name} (payee)`, gx__Account__c: rec.id, gx__Verified__c: i % 2 === 0 }, admin);
  }
}

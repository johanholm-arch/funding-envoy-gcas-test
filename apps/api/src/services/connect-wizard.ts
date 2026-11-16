// The Connect wizard behind Studio's "Connect to Salesforce": three questions, one at a time. Connect; find where the
// funder's grant requests live; match the details, showing only what needs a person. The same steps serve the
// practice (simulated) org and a company's own org. A company org's mapping is kept with its credentials until
// writing to it is switched on, so it never blocks the rest of the setup from being published.
import type { Catalogue } from "@fe/core";
import { one } from "@fe/db";
import { asUser, HttpError, type SessionUser } from "../auth.ts";
import { configVersion } from "../config.ts";
import * as live from "../connectors/salesforce-live.ts";
import { snapshotHash } from "../connectors/salesforce-sim.ts";
import {
  bestValue, currentConfig, feDocTypes, feFields, HINTS, jaccard, KIND_FITS, latestSnapshot, readOrg as readPracticeOrg,
  requireOwner, saveConfig, suggestMapping, testConnection, tokens, type ConnectorConfig, type FeField,
} from "./connector.ts";
import { liveSession } from "./connector-live.ts";
import { record } from "./requests.ts";

type Mode = "simulated" | "live";
const LIVE = "salesforce-live";
interface Reading { org: { name: string; myDomain: string; apiVersion: string; sandbox?: boolean }; objects: live.LiveObject[]; validationRules: { object: string; name: string; description: string; errorMessage: string }[]; requestObject?: string; note?: string }

const actor = { type: "connector" as const, id: "salesforce-live", name: "Salesforce connector (your org)" };
const fail = (e: unknown): never => { if (e instanceof live.SfLiveError) throw new HttpError(409, e.message, `salesforce:${e.code}`); throw e; };

// ─── Where things stand, for opening the wizard at the right step ────────────

export async function wizardState(u: SessionUser) {
  requireOwner(u);
  return asUser(u, async (tx) => {
    const t = (await one<{ slug: string; name: string }>(tx, "select slug, name from tenants where id = $1", [u.tenantId]))!;
    const practiceConnected = Boolean(await one(tx, "select 1 from sim_sf_records where tenant_id = $1 limit 1", [u.tenantId]));
    const cfg = await currentConfig(tx, u.tenantId!);
    const c = await one<{ my_domain: string; client_id: string; saved_by: string; saved_at: Date; last_test: { ok?: boolean; org?: { name: string; edition: string; sandbox: boolean }; user?: { username?: string }; message?: string; at?: string } | null; request_object: string | null; request_parts: string[] | null; grant_types: string[] | null; mapping: unknown; mapping_saved_by: string | null; mapping_saved_at: Date | null }>(tx,
      "select my_domain, client_id, saved_by, saved_at, last_test, request_object, request_parts, grant_types, mapping, mapping_saved_by, mapping_saved_at from connector_credentials where tenant_id = $1 and system = 'salesforce'", [u.tenantId]);
    const snap = c?.request_object ? await latestSnapshot(tx, u.tenantId!, LIVE) : undefined;
    const reqLabel = (snap?.body as unknown as Reading | undefined)?.objects.find((o) => o.name === c?.request_object)?.label;
    return {
      funder: t.name,
      practice: {
        connected: practiceConnected,
        draft: cfg.draft && cfg.draft.body.mode !== "live" ? { version: cfg.draft.version } : undefined,
        published: cfg.published ? { version: cfg.published.version, signedName: cfg.published.signed_name, signedAt: cfg.published.signed_at } : undefined,
      },
      company: c ? {
        myDomain: c.my_domain, clientIdHint: `…${c.client_id.slice(-6)}`, savedBy: c.saved_by, savedAt: c.saved_at, lastTest: c.last_test ?? undefined,
        requestObject: c.request_object ? { name: c.request_object, label: reqLabel ?? c.request_object } : undefined,
        parts: c.request_parts ?? undefined,
        grantTypes: c.grant_types ?? undefined,
        mappingSaved: c.mapping ? { by: c.mapping_saved_by, at: c.mapping_saved_at } : undefined,
      } : undefined,
    };
  });
}

// ─── Step 1 for the practice org ─────────────────────────────────────────────

export async function connectPractice(u: SessionUser) {
  requireOwner(u, true);
  const slug = await asUser(u, async (tx) => (await one<{ slug: string }>(tx, "select slug from tenants where id = $1", [u.tenantId]))!.slug);
  const myDomain = `${slug.replace(/[^a-z0-9-]/g, "").slice(0, 30)}-grants.my.salesforce.com`;
  const t = await testConnection(u, { mode: "simulated", myDomain });
  await readPracticeOrg(u, myDomain);
  return t;
}

// ─── Step 2 for a company org: where do grant requests live? ─────────────────

export async function findRequests(u: SessionUser) {
  requireOwner(u, true);
  try {
    const { client } = await liveSession(u);
    const r = await live.findRequestObjects(client);
    await asUser(u, (tx) => record(tx, { tenantId: u.tenantId!, actor, entity: { type: "connector", id: "salesforce" }, action: "connector.salesforce.live-request-objects-found", data: { candidates: r.candidates.map((c) => c.name), calls: client.calls + 1, by: u.name } }));
    return r;
  } catch (e) { return fail(e); }
}

export async function searchRequests(u: SessionUser, q: string) {
  requireOwner(u, true);
  try {
    const { client } = await liveSession(u);
    return { results: await live.searchObjects(client, q) };
  } catch (e) { return fail(e); }
}

export async function chooseRequestObject(u: SessionUser, name: string) {
  requireOwner(u, true);
  let reading: Awaited<ReturnType<typeof live.readRequestObject>>;
  let map: live.RequestMap;
  try {
    const { client, domain } = await liveSession(u);
    reading = await live.readRequestObject(client, domain, name);
    map = await live.mapRequest(client, reading.requestObject);
  } catch (e) { return fail(e); }
  // Parts in use (with records) are ticked to start with; the person confirms.
  const used = map.children.flatMap((c) => [c, ...c.children]).filter((c) => (c.records ?? 0) > 0).map((c) => c.name);
  const hash = snapshotHash(reading);
  await asUser(u, async (tx) => {
    await tx.query("insert into connector_snapshots (tenant_id, system, hash, body, read_by) values ($1,$2,$3,$4,$5) on conflict (tenant_id, system, hash) do update set read_at = now(), read_by = excluded.read_by", [u.tenantId, LIVE, hash, JSON.stringify(reading), u.name]);
    // A different object means the earlier matches no longer apply.
    await tx.query(`update connector_credentials set mapping = case when request_object is distinct from $2 then null else mapping end,
      request_parts = case when request_object is distinct from $2 or request_parts is null then $4::text[] else request_parts end,
      request_forms = case when request_object is distinct from $2 then null else request_forms end,
      grant_types = case when request_object is distinct from $2 then null else grant_types end,
      form_excluded = case when request_object is distinct from $2 then null else form_excluded end,
      request_object = $2, request_map = $3 where tenant_id = $1 and system = 'salesforce'`, [u.tenantId, reading.requestObject, JSON.stringify(map), used]);
    await record(tx, { tenantId: u.tenantId!, actor: { type: "person", id: u.id, name: u.name, roles: u.roles }, entity: { type: "connector", id: "salesforce" }, action: "connector.salesforce.live-request-object-chosen", data: { object: reading.requestObject, fields: reading.objects[0]!.fields.length, validationRules: reading.validationRules.length } });
  });
  return { requestObject: { name: reading.requestObject, label: reading.objects[0]!.label }, map };
}

/** The family of records that makes up a request, and the parts the person said belong to a grant request. */
export async function requestMapView(u: SessionUser) {
  requireOwner(u);
  const c = await asUser(u, (tx) => one<{ request_object: string | null; request_map: live.RequestMap | null; request_parts: string[] | null }>(tx, "select request_object, request_map, request_parts from connector_credentials where tenant_id = $1 and system = 'salesforce'", [u.tenantId]));
  if (!c?.request_object) throw new HttpError(409, "Choose where your grant requests are kept first.", "no-request-object");
  if (c.request_map) return { map: c.request_map, parts: c.request_parts ?? [] };
  // Chosen before the family was read (an earlier version): read it now.
  const r = await chooseRequestObject(u, c.request_object);
  const after = await asUser(u, (tx) => one<{ request_parts: string[] | null }>(tx, "select request_parts from connector_credentials where tenant_id = $1 and system = 'salesforce'", [u.tenantId]));
  return { map: r.map, parts: after?.request_parts ?? [] };
}

export async function saveParts(u: SessionUser, parts: string[]) {
  requireOwner(u, true);
  return asUser(u, async (tx) => {
    const c = await one<{ request_map: live.RequestMap | null }>(tx, "select request_map from connector_credentials where tenant_id = $1 and system = 'salesforce'", [u.tenantId]);
    if (!c?.request_map) throw new HttpError(409, "Choose where your grant requests are kept first.");
    const known = new Set(c.request_map.children.flatMap((x) => [x.name, ...x.children.map((g) => g.name)]));
    const clean = [...new Set(parts)].filter((p) => known.has(p));
    await tx.query("update connector_credentials set request_parts = $2 where tenant_id = $1 and system = 'salesforce'", [u.tenantId, clean]);
    await record(tx, { tenantId: u.tenantId!, actor: { type: "person", id: u.id, name: u.name, roles: u.roles }, entity: { type: "connector", id: "salesforce" }, action: "connector.salesforce.live-request-parts-chosen", data: { parts: clean } });
    return { map: c.request_map, parts: clean };
  });
}

// ─── Step 3: match the details ───────────────────────────────────────────────

const txt = (x: { name: string; label: string }) => `${x.name} ${x.label}`;

/** FundingEnvoy's suggested mapping for any org, once it knows which object holds grant requests. */
export function suggestForOrg(body: Reading, reqName: string, cat: Catalogue, current: Partial<ConnectorConfig> | undefined, hash: string) {
  const obj = (n: string) => body.objects.find((o) => o.name === n);
  const req = obj(reqName)!, acct = obj("Account"), doc = obj("ContentVersion");
  const find = (o: live.LiveObject | undefined, test: (x: live.LiveField) => boolean) => o?.fields.find(test)?.name ?? "";
  const accountRefs = req.fields.filter((x) => x.type === "reference" && x.referenceTo === "Account");
  const systemFields: ConnectorConfig["systemFields"] = {
    requestOrganization: accountRefs.find((x) => /account|organi[sz]ation|institution|\borg\b/i.test(txt(x)))?.name ?? accountRefs[0]?.name ?? "",
    requestRequestor: find(req, (x) => x.type === "reference" && /requestor|requester|applicant|submitter/i.test(txt(x))),
    requestStatus: find(req, (x) => x.type === "picklist" && /status/i.test(txt(x))),
    requestExternalId: find(req, (x) => Boolean(x.externalId) && /fundingenvoy|external/i.test(txt(x))),
    requestSubmittedAt: find(req, (x) => (x.type === "date" || x.type === "datetime") && /submit/i.test(txt(x))),
    requestAttestedBy: find(req, (x) => x.type === "string" && /attest|certif/i.test(txt(x))),
    requestReviewSummary: find(req, (x) => x.type === "textarea" && /review summary|pre.?submission/i.test(txt(x))),
    organizationTaxId: find(acct, (x) => x.type === "string" && /tax|\bein\b|vat|registration|npi/i.test(txt(x))),
    organizationCountry: find(acct, (x) => (x.type === "string" || x.type === "picklist") && /country/i.test(txt(x))),
    organizationExternalId: find(acct, (x) => Boolean(x.externalId) && /fundingenvoy/i.test(txt(x))),
    documentCategory: find(doc, (x) => x.type === "picklist" && x.name.endsWith("__c") && /category|type/i.test(txt(x))),
    documentExternalId: find(doc, (x) => Boolean(x.externalId) && /fundingenvoy/i.test(txt(x))),
    commentRequest: "", commentBody: "", commentVisible: "", commentAuthor: "",
  };
  const sys = new Set(Object.values(systemFields).filter(Boolean));
  const targets = req.fields.filter((x) => !x.readOnly && !sys.has(x.name) && x.type !== "id" && x.type !== "reference");
  const fe = feFields(cat);
  const reasons: Record<string, string> = {};
  const cands: { fe: FeField; sf: live.LiveField; score: number }[] = [];
  for (const f of fe) for (const t of targets) {
    if (!(KIND_FITS[f.kind] ?? ["string"]).includes(t.type as never)) continue;
    const a = [...tokens(f.label), ...tokens(f.key), ...(HINTS[f.key] ?? [])];
    const b = [...tokens(t.label), ...tokens(t.name)];
    const hint = (HINTS[f.key] ?? []).filter((h) => b.includes(h)).length;
    const score = jaccard(a, b) + hint * 0.25 + ((KIND_FITS[f.kind] ?? [])[0] === t.type ? 0.05 : 0);
    if (score >= 0.3) cands.push({ fe: f, sf: t, score });
  }
  cands.sort((x, y) => y.score - x.score);
  const taken = new Set<string>(), used = new Set<string>();
  const suggested: { fe: string; sf: string }[] = [];
  for (const c of cands) {
    if (taken.has(c.fe.key) || used.has(c.sf.name)) continue;
    taken.add(c.fe.key); used.add(c.sf.name);
    suggested.push({ fe: c.fe.key, sf: c.sf.name });
    reasons[c.fe.key] = `Similar name: “${c.sf.label}”`;
  }
  const sameObject = current?.objects?.request === reqName;
  const fields = sameObject && current?.fields ? current.fields : suggested;
  const values: Record<string, Record<string, string>> = {};
  for (const m of fields) {
    const f = fe.find((x) => x.key === m.fe), t = req.fields.find((x) => x.name === m.sf);
    if (!f?.options || t?.type !== "picklist") continue;
    values[m.sf] = { ...((sameObject && current?.values?.[m.sf]) || {}) };
    for (const o of f.options) if (!values[m.sf]![o.value]) { const b = bestValue(o.value, o.label, t.picklist ?? []); if (b.value) values[m.sf]![o.value] = b.value; }
  }
  const cats = doc?.fields.find((x) => x.name === systemFields.documentCategory)?.picklist ?? [];
  const documents: Record<string, string> = { ...((sameObject && current?.documents) || {}) };
  if (cats.length) for (const d of feDocTypes(cat)) if (!documents[d.type]) documents[d.type] = bestValue(d.type, d.label, cats).value ?? (cats.find((c) => /other/i.test(c)) ?? "");
  const statusPick = req.fields.find((x) => x.name === systemFields.requestStatus)?.picklist ?? [];
  const pick = (re: RegExp) => statusPick.find((p) => re.test(p)) ?? "";
  const config: ConnectorConfig = {
    system: "salesforce", mode: "live", enabled: false,
    connection: { myDomain: body.org.myDomain, siteUrl: "", apiVersion: body.org.apiVersion }, snapshotHash: hash,
    objects: { organization: "Account", request: reqName, document: "ContentVersion", comment: "" },
    systemFields: sameObject && current?.systemFields ? { ...systemFields, ...current.systemFields } : systemFields,
    statusValues: sameObject && current?.statusValues ? current.statusValues : {
      draft: pick(/draft|^new$|not submitted/i), submitted: pick(/submitted|ready for review|in review|pending review/i), infoRequested: pick(/information|more info|returned|pending requestor/i),
      approved: pick(/approved/i), declined: pick(/declined|rejected|denied/i), closed: pick(/closed|complete|cancel/i),
    },
    fields, values, documents,
    matching: { identifiers: true, byName: true }, checkpoints: { organization: true, draft: true, documents: true, submit: true }, events: { status: true, comments: true },
  };
  return { config, reasons, suggested };
}

export interface Need {
  id: string; kind: "choose-field" | "statuses" | "required" | "values" | "note";
  title: string; detail?: string; key?: string; sf?: string;
  options?: { value: string; label: string }[];
  rows?: { key: string; label: string; current: string }[];
}

const STATUS_WORDS: Record<keyof ConnectorConfig["statusValues"], string> = { draft: "Saved but not yet sent", submitted: "Submitted for review", infoRequested: "Grants team asks the requestor for more", approved: "Approved", declined: "Declined", closed: "Closed" };

/** Only what needs a person: everything FundingEnvoy could match by itself is left out. */
export function needsFor(c: ConnectorConfig, req: live.LiveObject, fe: FeField[], mode: Mode): Need[] {
  const needs: Need[] = [];
  const sf = (n: string) => req.fields.find((x) => x.name === n);
  const opt = (x: live.LiveField) => ({ value: x.name, label: x.label });
  if (!c.systemFields.requestOrganization || !sf(c.systemFields.requestOrganization)) {
    const refs = req.fields.filter((x) => x.type === "reference");
    needs.push({ id: "org", kind: "choose-field", key: "requestOrganization", title: `Which ${req.label} field says which organization is applying?`, detail: "FundingEnvoy fills it with the organization the request is from.", options: refs.map(opt) });
  }
  const status = sf(c.systemFields.requestStatus);
  if (!status) {
    needs.push({ id: "status-field", kind: "choose-field", key: "requestStatus", title: `Which ${req.label} field holds its status?`, options: req.fields.filter((x) => x.type === "picklist").map(opt) });
  } else {
    const rows = (Object.keys(STATUS_WORDS) as (keyof typeof STATUS_WORDS)[]).filter((k) => !c.statusValues[k] || !status.picklist?.includes(c.statusValues[k])).map((k) => ({ key: k, label: STATUS_WORDS[k], current: c.statusValues[k] ?? "" }));
    if (rows.length) needs.push({ id: "statuses", kind: "statuses", title: `Which ${status.label} means what?`, detail: "So FundingEnvoy knows what each stage of a request means, and can tell the requestor.", rows, options: (status.picklist ?? []).map((p) => ({ value: p, label: p })) });
  }
  const sys = new Set(Object.values(c.systemFields).filter(Boolean));
  const mapped = new Set(c.fields.map((m) => m.sf));
  for (const x of req.fields) {
    if (!x.required || x.readOnly || sys.has(x.name) || mapped.has(x.name)) continue;
    if (x.type === "reference") {
      needs.push({ id: `req-${x.name}`, kind: "note", sf: x.name, title: `${x.label} is required by Salesforce`, detail: `It links to ${x.referenceTo ?? "another record"}, which FundingEnvoy doesn't fill. Your Salesforce admin can give it a default value.` });
      continue;
    }
    const fits = fe.filter((f) => (KIND_FITS[f.kind] ?? ["string"]).includes(x.type as never));
    needs.push({ id: `req-${x.name}`, kind: "required", sf: x.name, title: `Salesforce needs “${x.label}” on every request. Which FundingEnvoy answer goes there?`, options: fits.map((f) => ({ value: f.key, label: f.label })) });
  }
  for (const m of c.fields) {
    const f = fe.find((x) => x.key === m.fe), t = sf(m.sf);
    if (!f?.options || t?.type !== "picklist") continue;
    const map = c.values[m.sf] ?? {};
    // Which kind of grant is which is too important to guess silently: it is asked once, with the guesses filled in.
    const key = m.fe === "request.subtype" || m.fe === "request.family";
    const confirmed = (c.confirmed ?? []).includes(`values-${m.sf}`);
    const rows = f.options.filter((o) => (key && !confirmed) || !map[o.value] || !t.picklist?.includes(map[o.value]!)).map((o) => ({ key: o.value, label: o.label, current: map[o.value] ?? "" }));
    if (rows.length) needs.push({ id: `values-${m.sf}`, kind: "values", sf: m.sf, key: m.fe, title: key ? (m.fe === "request.subtype" ? `Which ${t.label} is each type of grant?` : `Which ${t.label} is each grant family?`) : `${f.label} → ${t.label}: which ${t.label} is each of these?`, detail: key && !confirmed ? "FundingEnvoy has filled in its guesses. Check them once." : undefined, rows, options: (t.picklist ?? []).map((p) => ({ value: p, label: p })) });
  }
  if (mode === "live" && !c.systemFields.requestExternalId) {
    needs.push({ id: "external-id", kind: "note", title: "One field for your Salesforce admin to add, later", detail: `Before FundingEnvoy writes requests, your admin adds a text field to ${req.label} called “FundingEnvoy Request ID”, marked as an External ID. It lets FundingEnvoy recognise its own requests so it never creates one twice. Nothing to do now.` });
  }
  return needs;
}

export async function mappingView(u: SessionUser, mode: Mode) {
  requireOwner(u);
  return asUser(u, async (tx) => {
    const cat = (await configVersion<Catalogue>(tx, u.tenantId!, "catalogue"))!.body;
    const fe = feFields(cat);
    let reading: Reading, config: ConnectorConfig, reasons: Record<string, string>, suggestedFields: { fe: string; sf: string }[], saved: { by?: string | null; at?: Date | null } | undefined;
    if (mode === "simulated") {
      const snap = await latestSnapshot(tx, u.tenantId!);
      if (!snap) throw new HttpError(409, "Connect the practice Salesforce first.", "not-connected");
      reading = snap.body as unknown as Reading;
      const cfg = await currentConfig(tx, u.tenantId!);
      const stored = cfg.draft?.body.mode === "simulated" ? cfg.draft.body : cfg.published?.body;
      const s = suggestMapping(snap.body, cat, stored, snap.hash);
      config = stored ?? s.config; reasons = s.reasons; suggestedFields = s.config.fields;
      saved = stored ? { by: cfg.draft?.version ? "draft" : cfg.published?.signed_name, at: cfg.published?.signed_at } : undefined;
    } else {
      const c = await one<{ request_object: string | null; mapping: ConnectorConfig | null; mapping_saved_by: string | null; mapping_saved_at: Date | null }>(tx, "select request_object, mapping, mapping_saved_by, mapping_saved_at from connector_credentials where tenant_id = $1 and system = 'salesforce'", [u.tenantId]);
      const snap = await latestSnapshot(tx, u.tenantId!, LIVE);
      const body = snap?.body as unknown as Reading | undefined;
      if (!c?.request_object || body?.requestObject !== c.request_object) throw new HttpError(409, "Choose where your grant requests are kept first.", "no-request-object");
      reading = body;
      const s = suggestForOrg(body, c.request_object, cat, c.mapping ?? undefined, snap!.hash);
      config = c.mapping ?? s.config; reasons = s.reasons; suggestedFields = s.suggested;
      saved = c.mapping ? { by: c.mapping_saved_by, at: c.mapping_saved_at } : undefined;
    }
    const req = reading.objects.find((o) => o.name === config.objects.request)!;
    const doc = reading.objects.find((o) => o.name === config.objects.document);
    const needs = needsFor(config, req, fe, mode);
    const sys = new Set(Object.values(config.systemFields).filter(Boolean));
    return {
      mode, org: reading.org, saved,
      requestObject: { name: req.name, label: req.label, fields: req.fields.filter((x) => !x.readOnly && x.type !== "id").map(({ name, label, type, required, picklist }) => ({ name, label, type, required, picklist })) },
      config, needs,
      matched: config.fields.map((m) => ({ fe: m.fe, feLabel: fe.find((x) => x.key === m.fe)?.label ?? m.fe, sf: m.sf, sfLabel: req.fields.find((x) => x.name === m.sf)?.label ?? m.sf, why: suggestedFields.find((x) => x.fe === m.fe)?.sf === m.sf ? (reasons[m.fe] ?? "Suggested") : "Your choice" })),
      setByFundingEnvoy: [...sys].map((n) => req.fields.find((x) => x.name === n)?.label).filter(Boolean),
      notSent: fe.filter((f) => !config.fields.some((m) => m.fe === f.key)).map((f) => ({ key: f.key, label: f.label, kind: f.kind })),
      documentCategories: doc?.fields.find((x) => x.name === config.systemFields.documentCategory)?.picklist ?? [],
      feDocTypes: feDocTypes(cat), validationRules: reading.validationRules.filter((r) => r.object === req.name).length, note: reading.note,
    };
  });
}

export async function saveMapping(u: SessionUser, mode: Mode, config: ConnectorConfig) {
  requireOwner(u, true);
  if (mode === "simulated") {
    await saveConfig(u, { ...config, mode: "simulated" });
  } else {
    await asUser(u, async (tx) => {
      const c = await one<{ request_object: string | null }>(tx, "select request_object from connector_credentials where tenant_id = $1 and system = 'salesforce'", [u.tenantId]);
      if (!c?.request_object || c.request_object !== config.objects?.request) throw new HttpError(409, "Choose where your grant requests are kept first.");
      await tx.query("update connector_credentials set mapping = $2, mapping_saved_by = $3, mapping_saved_at = now() where tenant_id = $1 and system = 'salesforce'", [u.tenantId, JSON.stringify({ ...config, mode: "live", enabled: false }), u.name]);
      await record(tx, { tenantId: u.tenantId!, actor: { type: "person", id: u.id, name: u.name, roles: u.roles }, entity: { type: "connector", id: "salesforce" }, action: "connector.salesforce.live-mapping-saved", data: { object: config.objects.request, fields: config.fields.length } });
    });
  }
  return mappingView(u, mode);
}

// ─── Steps 3 and 4 for a company org: which request types are grants, and their own forms ────────────────────

const GRANTISH_TYPE = /grant|donation|contribution|sponsor|funding|educat|charit/i;

interface FormsRow { request_object: string | null; request_map: live.RequestMap | null; request_parts: string[] | null; request_forms: live.RequestForm[] | null; grant_types: string[] | null; form_excluded: Record<string, string[]> | null }

/** The org's request types, each with its own "New" form. Forms are read from Salesforce once and kept. */
export async function formsView(u: SessionUser, refresh = false) {
  requireOwner(u);
  const load = () => asUser(u, (tx) => one<FormsRow>(tx, "select request_object, request_map, request_parts, request_forms, grant_types, form_excluded from connector_credentials where tenant_id = $1 and system = 'salesforce'", [u.tenantId]));
  let c = await load();
  if (!c?.request_object) throw new HttpError(409, "Choose where your grant requests are kept first.", "no-request-object");
  if (!c.request_map) { await requestMapView(u); c = (await load())!; }
  if (!c.request_forms || refresh) {
    let forms: live.RequestForm[];
    try { const { client } = await liveSession(u); forms = await live.readForms(client, c.request_object!); } catch (e) { return fail(e); }
    // Types whose names suggest grants start ticked; the person confirms.
    const guess = c.grant_types ?? forms.map((f) => f.recordType).filter((t): t is NonNullable<typeof t> => Boolean(t && GRANTISH_TYPE.test(t.name))).map((t) => t.developerName);
    await asUser(u, async (tx) => {
      // Fields the grants team fills (status, owner, approvals) aren't asked of requestors, unless Salesforce requires them.
      const staffOnly = /status|owner|approv|reviewer|decision|internal/i;
      const defaults = Object.fromEntries(forms.map((f) => [f.recordType?.developerName ?? "", f.sections.flatMap((x) => x.fields).filter((x) => !x.required && staffOnly.test(`${x.name} ${x.label}`)).map((x) => x.name)]));
      await tx.query("update connector_credentials set request_forms = $2, grant_types = $3, form_excluded = coalesce(form_excluded, $4::jsonb) where tenant_id = $1 and system = 'salesforce'", [u.tenantId, JSON.stringify(forms), guess, JSON.stringify(defaults)]);
      await record(tx, { tenantId: u.tenantId!, actor, entity: { type: "connector", id: "salesforce" }, action: "connector.salesforce.live-forms-read", data: { object: c!.request_object, forms: forms.map((f) => ({ type: f.recordType?.developerName ?? "(one form)", sections: f.sections.length, fields: f.sections.reduce((n, x) => n + x.fields.length, 0) })), by: u.name } });
    });
    c = (await load())!;
  }
  const map = c.request_map!;
  const partLabels = new Map(map.children.flatMap((x) => [x, ...x.children]).map((x) => [x.name, x.label]));
  return {
    object: { name: map.root.name, label: map.root.label },
    types: (c.request_forms ?? []).map((f) => ({
      name: f.recordType?.name ?? map.root.label, developerName: f.recordType?.developerName ?? "",
      records: f.recordType ? map.root.types.find((t) => t.developerName === f.recordType!.developerName)?.records : map.root.records,
      grant: f.recordType ? (c!.grant_types ?? []).includes(f.recordType.developerName) : true,
    })),
    forms: Object.fromEntries((c.request_forms ?? []).map((f) => [f.recordType?.developerName ?? "", f])),
    excluded: c.form_excluded ?? {},
    // Lists on the form that are parts the person ticked in step 2: asked as lists (budget lines, for example).
    parts: (c.request_parts ?? []).map((p) => ({ name: p, label: partLabels.get(p) ?? p })),
  };
}

export async function saveGrantTypes(u: SessionUser, types: string[]) {
  requireOwner(u, true);
  const v = await formsView(u);
  const known = new Set(v.types.map((t) => t.developerName));
  const clean = [...new Set(types)].filter((t) => known.has(t));
  await asUser(u, async (tx) => {
    await tx.query("update connector_credentials set grant_types = $2 where tenant_id = $1 and system = 'salesforce'", [u.tenantId, clean]);
    await record(tx, { tenantId: u.tenantId!, actor: { type: "person", id: u.id, name: u.name, roles: u.roles }, entity: { type: "connector", id: "salesforce" }, action: "connector.salesforce.live-grant-types-chosen", data: { grantTypes: clean } });
  });
  return formsView(u);
}

/** Fields of one request type's form that requestors are not asked. Required fields are always asked. */
export async function saveExcluded(u: SessionUser, type: string, fields: string[]) {
  requireOwner(u, true);
  const v = await formsView(u);
  const form = v.forms[type];
  if (!form) throw new HttpError(404, "No such request type.");
  const optional = new Set(form.sections.flatMap((s) => s.fields).filter((f) => !f.required).map((f) => f.name));
  const clean = [...new Set(fields)].filter((f) => optional.has(f));
  await asUser(u, (tx) => tx.query("update connector_credentials set form_excluded = coalesce(form_excluded, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) where tenant_id = $1 and system = 'salesforce'", [u.tenantId, type, JSON.stringify(clean)]));
  return formsView(u);
}

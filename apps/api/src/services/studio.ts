// Studio: the process owner's configuration surface. Everything is a version: draft → validated → tested → signed.
import type { AutonomyLevel, AutonomyPolicy, Catalogue, Organization, Rulebook, WorkflowDef } from "@fe/core";
import { AUTONOMY_LABELS, composeRulebook, consequencePreview, effectiveLevel, KNOWN_CHECK_KINDS, onlyLockedForward, validateWorkflow } from "@fe/core";
import { many, one, type Tx } from "@fe/db";
import { parseClauses } from "@fe/agent";
import { actorOf, asUser, HttpError, type SessionUser } from "../auth.ts";
import { configVersion, invalidateConfigCache, loadPacks, tenantConfig, type ConfigKind } from "../config.ts";
import { record } from "./requests.ts";
import { evaluateCases, type TestCase, type TestsetReport } from "../testset.ts";
import { getFile, putFile } from "../storage.ts";

const KINDS: ConfigKind[] = ["catalogue", "rulebook", "workflow", "autonomy", "brand", "words", "policy", "sop", "testset"];

interface VersionRow { version: number; status: string; note: string | null; created_at: Date; signed_name: string | null; signed_at: Date | null; created_by: string | null }

export async function overview(u: SessionUser) {
  return asUser(u, async (tx) => {
    const rows = await many<VersionRow & { kind: string }>(tx, "select kind, version, status, note, created_at, signed_name, signed_at, created_by from config_versions where tenant_id = $1 order by kind, version desc", [u.tenantId]);
    return KINDS.map((k) => {
      const vs = rows.filter((r) => r.kind === k);
      const pub = vs.find((r) => r.status === "published");
      const draft = vs.find((r) => r.status === "draft");
      return { kind: k, published: pub ? { version: pub.version, signedName: pub.signed_name, signedAt: pub.signed_at } : undefined, draft: draft ? { version: draft.version, createdAt: draft.created_at, note: draft.note } : undefined, versions: vs.length };
    });
  });
}

export async function getVersion(u: SessionUser, kind: ConfigKind, version?: number) {
  return asUser(u, async (tx) => {
    const v = await configVersion(tx, u.tenantId!, kind, version);
    if (!v && version !== undefined) {
      const d = await one<{ version: number; body: unknown; status: string }>(tx, "select version, body, status from config_versions where tenant_id = $1 and kind = $2 and version = $3", [u.tenantId, kind, version]);
      if (d) return d;
    }
    if (!v) throw new HttpError(404, `No ${kind} version found.`);
    const status = await one<{ status: string }>(tx, "select status from config_versions where tenant_id = $1 and kind = $2 and version = $3", [u.tenantId, kind, v.version]);
    return { ...v, status: status?.status };
  });
}

export async function versions(u: SessionUser, kind: ConfigKind) {
  return asUser(u, (tx) => many<VersionRow>(tx, "select version, status, note, created_at, signed_name, signed_at, created_by from config_versions where tenant_id = $1 and kind = $2 order by version desc", [u.tenantId, kind]));
}

export async function createDraft(u: SessionUser, kind: ConfigKind, note?: string, body?: unknown) {
  return asUser(u, async (tx) => {
    const existing = await one<{ version: number }>(tx, "select version from config_versions where tenant_id = $1 and kind = $2 and status = 'draft'", [u.tenantId, kind]);
    if (existing) throw new HttpError(409, `A ${kind} draft (v${existing.version}) already exists. Edit it or discard it first.`);
    const pub = await configVersion<Record<string, unknown>>(tx, u.tenantId!, kind);
    const max = await one<{ v: number }>(tx, "select coalesce(max(version), 0) as v from config_versions where tenant_id = $1 and kind = $2", [u.tenantId, kind]);
    const version = (max?.v ?? 0) + 1;
    const content = body ?? (pub ? { ...pub.body, ...(typeof pub.body === "object" && pub.body && "version" in pub.body ? { version } : {}), ...(kind === "rulebook" || kind === "workflow" ? { status: "draft" } : {}) } : {});
    await tx.query("insert into config_versions (tenant_id, kind, version, status, body, note, created_by) values ($1,$2,$3,'draft',$4,$5,$6)", [u.tenantId, kind, version, JSON.stringify(content), note ?? null, u.id]);
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "config", id: `${kind}:${version}` }, action: "config.draft-created", data: { kind, version, from: pub?.version, note } });
    return { kind, version };
  });
}

export async function updateDraft(u: SessionUser, kind: ConfigKind, version: number, body: unknown) {
  return asUser(u, async (tx) => {
    const r = await tx.query("update config_versions set body = $4 where tenant_id = $1 and kind = $2 and version = $3 and status = 'draft'", [u.tenantId, kind, version, JSON.stringify(body)]);
    if (!r.rowCount) throw new HttpError(409, "Only a draft can be edited. Create a new version from the published one.");
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "config", id: `${kind}:${version}` }, action: "config.draft-edited", data: { kind, version } });
    return { ok: true };
  });
}

export async function discardDraft(u: SessionUser, kind: ConfigKind, version: number) {
  return asUser(u, async (tx) => {
    const r = await tx.query("delete from config_versions where tenant_id = $1 and kind = $2 and version = $3 and status = 'draft'", [u.tenantId, kind, version]);
    if (!r.rowCount) throw new HttpError(404, "No such draft.");
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "config", id: `${kind}:${version}` }, action: "config.draft-discarded", data: { kind, version } });
    return { ok: true };
  });
}

async function orgsForTenant(tx: Tx, tenantId: string): Promise<Organization[]> {
  const rows = await many<{ id: string; legal_name: string; type: string; country: string; identifiers: Record<string, string>; data: Organization & { id: string } }>(tx,
    "select o.id, o.legal_name, o.type, o.country, o.identifiers, o.data from organizations o join org_shares s on s.org_id = o.id where s.tenant_id = $1", [tenantId]);
  // Test cases reference organizations by their content id, which the seed keeps in data.id for passports.
  return rows.map((r) => ({ ...r.data, officers: r.data.officers ?? [], signers: r.data.signers ?? [], screening: r.data.screening ?? [], governmentControlled: r.data.governmentControlled ?? false, legalName: r.legal_name, type: r.type as Organization["type"], country: r.country, identifiers: r.identifiers }));
}

/** Run the tenant's test set against a draft (or the published) catalogue and rulebook. */
export async function runTests(u: SessionUser, opts: { rulebookVersion?: number; catalogueVersion?: number } = {}): Promise<TestsetReport & { rulebookVersion: number; catalogueVersion: number }> {
  return asUser(u, async (tx) => {
    const rb = await rawVersion<Rulebook>(tx, u.tenantId!, "rulebook", opts.rulebookVersion);
    const cat = await rawVersion<Catalogue>(tx, u.tenantId!, "catalogue", opts.catalogueVersion);
    const ts = await configVersion<{ cases: TestCase[] }>(tx, u.tenantId!, "testset");
    if (!ts) throw new HttpError(404, "This tenant has no test set yet.");
    const packs = await loadPacks(tx);
    const settings = (await one<{ settings: { productNames?: string[] } }>(tx, "select settings from tenants where id = $1", [u.tenantId]))?.settings;
    const report = evaluateCases({ catalogue: cat.body, rulebook: rb.body, packs, organizations: await orgsForTenant(tx, u.tenantId!), cases: ts.body.cases, productNames: settings?.productNames ?? [] });
    return { ...report, rulebookVersion: rb.version, catalogueVersion: cat.version };
  });
}

async function rawVersion<T>(tx: Tx, tenantId: string, kind: ConfigKind, version?: number): Promise<{ version: number; body: T }> {
  const row = version !== undefined
    ? await one<{ version: number; body: T }>(tx, "select version, body from config_versions where tenant_id = $1 and kind = $2 and version = $3", [tenantId, kind, version])
    : await one<{ version: number; body: T }>(tx, "select version, body from config_versions where tenant_id = $1 and kind = $2 and status = 'published'", [tenantId, kind]);
  if (!row) throw new HttpError(404, `No ${kind}${version !== undefined ? ` v${version}` : " published"}.`);
  return row;
}

export interface ValidationIssue { severity: "error" | "warning"; where?: string; message: string }

export async function validate(u: SessionUser, kind: ConfigKind, version: number): Promise<{ issues: ValidationIssue[]; tests?: TestsetReport }> {
  const v = await asUser(u, (tx) => rawVersion<unknown>(tx, u.tenantId!, kind, version));
  const issues: ValidationIssue[] = [];
  let tests: TestsetReport | undefined;
  if (kind === "workflow") {
    for (const i of validateWorkflow(v.body as WorkflowDef)) issues.push({ severity: i.severity, where: i.stage, message: i.message });
  }
  if (kind === "rulebook") {
    const rb = v.body as Rulebook;
    const packs = await asUser(u, (tx) => loadPacks(tx));
    const composed = composeRulebook(rb, packs);
    for (const w of composed.warnings) issues.push({ severity: "warning", message: w });
    const ids = new Set<string>();
    for (const r of rb.rules) {
      if (ids.has(r.id)) issues.push({ severity: "error", where: r.id, message: `Rule id ${r.id} is used twice.` });
      ids.add(r.id);
      if (!KNOWN_CHECK_KINDS.includes(r.check.kind)) issues.push({ severity: "error", where: r.id, message: `Unknown check type "${r.check.kind}".` });
      if (!r.basis?.ref) issues.push({ severity: "error", where: r.id, message: "Every rule needs a basis (law, code, policy clause or SOP clause)." });
      if (!r.messages?.pass || !r.messages?.fail) issues.push({ severity: "error", where: r.id, message: "Every rule needs a pass and a fail message." });
    }
    tests = await runTests(u, { rulebookVersion: version });
  }
  if (kind === "catalogue") {
    const cat = v.body as Catalogue;
    for (const s of cat.subtypes) {
      for (const a of s.attestations) if (!cat.attestations.some((x) => x.id === a)) issues.push({ severity: "error", where: s.id, message: `Attestation "${a}" is not defined.` });
      for (const q of s.coi) if (!cat.coiQuestions.some((x) => x.id === q)) issues.push({ severity: "error", where: s.id, message: `Conflict question "${q}" is not defined.` });
      const keys = new Set<string>();
      for (const f of s.fields) { if (keys.has(f.key)) issues.push({ severity: "error", where: `${s.id}.${f.key}`, message: "Field key used twice." }); keys.add(f.key); }
      for (const k of ["title", "amount.requested"]) if (!keys.has(k)) issues.push({ severity: "error", where: s.id, message: `Every subtype needs the "${k}" field.` });
    }
    tests = await runTests(u, { catalogueVersion: version });
  }
  if (kind === "autonomy") {
    const pol = v.body as AutonomyPolicy;
    const wf = (await asUser(u, (tx) => tenantConfig(tx, u.tenantId!))).workflow;
    for (const o of pol.overrides ?? []) if (!wf.stages.some((s) => s.id === o.stage)) issues.push({ severity: "error", where: o.stage, message: `There is no stage "${o.stage}" in the published workflow.` });
    if (pol.confidenceFloor < 0 || pol.confidenceFloor > 1) issues.push({ severity: "error", message: "Confidence floor must be between 0 and 1." });
  }
  if (tests && tests.passed < tests.total) issues.push({ severity: "error", message: `${tests.total - tests.passed} of ${tests.total} test cases disagree with this version. Fix the rules or the cases, or accept the differences with a reason when publishing.` });
  return { issues, tests };
}

/** Publishing is the process owner's signature. Errors block; test-set differences need a stated reason. */
export async function publish(u: SessionUser, kind: ConfigKind, version: number, input: { typedName: string; acceptDifferences?: string }) {
  if (!u.roles.includes("process-owner")) throw new HttpError(403, "Only the process owner can publish configuration.");
  if (input.typedName.trim().toLowerCase() !== u.name.trim().toLowerCase()) throw new HttpError(400, `Type your full name exactly as "${u.name}" to sign this version.`);
  const { issues, tests } = await validate(u, kind, version);
  const errors = issues.filter((i) => i.severity === "error" && !(i.message.includes("test cases disagree") && input.acceptDifferences?.trim()));
  if (errors.length) throw new HttpError(409, `This version cannot be published yet: ${errors.map((e) => e.message).join(" ")}`, "invalid");
  return asUser(u, async (tx) => {
    const prev = await one<{ version: number; body: unknown }>(tx, "select version, body from config_versions where tenant_id = $1 and kind = $2 and status = 'published'", [u.tenantId, kind]);
    const draft = await rawVersion<Record<string, unknown>>(tx, u.tenantId!, kind, version);
    if (prev) await tx.query("update config_versions set status = 'retired' where tenant_id = $1 and kind = $2 and version = $3", [u.tenantId, kind, prev.version]);
    const body = typeof draft.body === "object" && draft.body && "status" in draft.body ? { ...draft.body, status: "published", signedBy: u.name, signedAt: new Date().toISOString() } : draft.body;
    await tx.query("update config_versions set body = $4, status = 'published', signed_by = $5, signed_name = $6, signed_at = now() where tenant_id = $1 and kind = $2 and version = $3",
      [u.tenantId, kind, version, JSON.stringify(body), u.id, u.name]);
    // Brand and words are read on every page; the funder's settings carry the published version.
    if (kind === "brand" || kind === "words") {
      await tx.query("update tenants set settings = jsonb_set(settings, $2::text[], $3::jsonb) where id = $1", [u.tenantId, [kind], JSON.stringify(body)]);
    }
    const d = prev ? diffBodies(kind, prev.body, draft.body) : { summary: "First version" };
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "config", id: `${kind}:${version}` }, action: "config.published",
      data: { kind, version, previous: prev?.version, diff: d.summary, tests: tests ? `${tests.passed}/${tests.total}` : undefined, acceptedDifferences: input.acceptDifferences, meaning: "I approve this configuration version for use on new requests." } });
    invalidateConfigCache();
    return { version, previous: prev?.version, diff: d };
  });
}

export function diffBodies(kind: string, a: unknown, b: unknown): { summary: string; added?: string[]; removed?: string[]; changed?: string[] } {
  const byId = (xs: { id: string }[] | undefined) => new Map((xs ?? []).map((x) => [x.id, JSON.stringify(x)]));
  if (kind === "rulebook" || kind === "workflow" || kind === "catalogue") {
    const key = kind === "rulebook" ? "rules" : kind === "workflow" ? "stages" : "subtypes";
    const A = byId((a as Record<string, { id: string }[]>)[key]), B = byId((b as Record<string, { id: string }[]>)[key]);
    const added = [...B.keys()].filter((k) => !A.has(k)), removed = [...A.keys()].filter((k) => !B.has(k));
    const changed = [...B.keys()].filter((k) => A.has(k) && A.get(k) !== B.get(k));
    const pa = JSON.stringify((a as { parameters?: unknown }).parameters ?? {}), pb = JSON.stringify((b as { parameters?: unknown }).parameters ?? {});
    const paramsChanged = pa !== pb;
    const parts = [added.length ? `${added.length} added (${added.join(", ")})` : "", removed.length ? `${removed.length} removed (${removed.join(", ")})` : "", changed.length ? `${changed.length} changed (${changed.join(", ")})` : "", paramsChanged ? "parameters changed" : ""].filter(Boolean);
    return { summary: parts.length ? `${key}: ${parts.join("; ")}` : "No changes", added, removed, changed };
  }
  const ka = a && typeof a === "object" ? a as Record<string, unknown> : {}, kb = b && typeof b === "object" ? b as Record<string, unknown> : {};
  const changed = [...new Set([...Object.keys(ka), ...Object.keys(kb)])].filter((k) => JSON.stringify(ka[k]) !== JSON.stringify(kb[k]));
  return { summary: changed.length ? `Changed: ${changed.join(", ")}` : "No changes", changed };
}

export async function diff(u: SessionUser, kind: ConfigKind, from: number, to: number) {
  return asUser(u, async (tx) => {
    const a = await rawVersion(tx, u.tenantId!, kind, from), b = await rawVersion(tx, u.tenantId!, kind, to);
    return diffBodies(kind, a.body, b.body);
  });
}

// ─── SOP to workflow ────────────────────────────────────────────────────────

const VAGUE = /\b(where appropriate|as appropriate|as required|as needed|a threshold|the threshold|reasonable|promptly|in due course|significant)\b/i;

/**
 * Re-draft the workflow from a new SOP version. Stages stay tied to the clauses they came from:
 * clauses that changed, appeared or disappeared are mapped to the stages that cite them, and statements
 * that leave something unsaid (a threshold without a number, "where appropriate") become questions.
 * The draft is never published without the process owner reviewing it stage by stage and signing.
 */
export async function draftFromSop(u: SessionUser, input: { title: string; markdown: string }) {
  const cfg = await asUser(u, (tx) => tenantConfig(tx, u.tenantId!));
  const current = await asUser(u, (tx) => configVersion<{ markdown: string; title: string }>(tx, u.tenantId!, "sop"));
  const newClauses = parseClauses(input.markdown, "SOP", input.title);
  const oldClauses = current ? parseClauses(current.body.markdown, "SOP", current.body.title) : [];
  const num = (ref: string) => ref.replace(/^SOP\s+/, "");
  const oldMap = new Map(oldClauses.map((c) => [num(c.ref), c]));
  const newMap = new Map(newClauses.map((c) => [num(c.ref), c]));
  const changed = [...newMap.keys()].filter((k) => oldMap.has(k) && norm(oldMap.get(k)!.text) !== norm(newMap.get(k)!.text));
  const added = [...newMap.keys()].filter((k) => !oldMap.has(k));
  const removed = [...oldMap.keys()].filter((k) => !newMap.has(k));
  const stageImpact = cfg.workflow.stages.map((s) => {
    const refs = s.sopRefs.map((r) => r.replace(/^SOP\s*/, ""));
    const hit = refs.filter((r) => changed.some((c) => c === r || c.startsWith(`${r}.`) || r.startsWith(`${c}.`)) || removed.includes(r));
    return { stage: s.id, name: s.name, refs, affectedBy: hit, orphaned: refs.filter((r) => removed.includes(r)) };
  }).filter((x) => x.affectedBy.length);
  const questions = newClauses.filter((c) => VAGUE.test(c.text) && !/\d/.test(c.text.match(VAGUE)?.[0] ?? "") && !/[$€£]\s?\d|\d+\s?(days|%|business)/i.test(c.text))
    .map((c) => ({ clause: c.ref, text: `${c.ref} says "${(c.text.match(new RegExp(`[^.]*${VAGUE.source}[^.]*\\.?`, "i"))?.[0] ?? c.text).trim()}". What does that mean in practice for the workflow?` }));
  const sopVersion = await createDraft(u, "sop", `New SOP: ${input.title}`, { title: input.title, markdown: input.markdown }).catch(() => undefined);
  const wfBody: WorkflowDef = { ...cfg.workflow, status: "draft", source: { document: input.title, version: input.title.match(/v(\d+)/i)?.[1] ?? "new", clauses: Object.fromEntries(newClauses.map((c) => [num(c.ref), (c.heading ?? c.text).slice(0, 160)])) } };
  const wfVersion = await createDraft(u, "workflow", `Re-drafted from ${input.title}`, wfBody).catch(() => undefined);
  return {
    clauses: { total: newClauses.length, changed, added, removed }, stageImpact, questions,
    drafts: { sop: sopVersion?.version, workflow: wfVersion?.version },
    note: "Drafted by comparing clauses with the current SOP. Review every affected stage before signing; nothing changes for requests until the new workflow is published.",
  };
}

function norm(s: string) { return s.toLowerCase().replace(/\s+/g, " ").trim(); }

// ─── Autonomy dial ──────────────────────────────────────────────────────────

export async function autonomyView(u: SessionUser) {
  return asUser(u, async (tx) => {
    const cfg = await tenantConfig(tx, u.tenantId!);
    const history = await many<{ stage: string; confidence: number | null; outcome: string }>(tx, `
      select ai->'gate'->>'stage' as stage, (ai->'scores'->>'confidence')::float as confidence, ai->'gate'->>'outcome' as outcome
      from events where tenant_id = $1 and ai ? 'gate' and at > now() - interval '120 days'`, [u.tenantId]);
    const floor = cfg.autonomy?.confidenceFloor ?? 0.7;
    return {
      profile: cfg.autonomy?.profile ?? "standard", confidenceFloor: floor,
      stages: cfg.workflow.stages.map((s) => {
        const level = effectiveLevel(s, cfg.autonomy, {});
        const cap = onlyLockedForward(s) ? 2 : s.assistant.maxLevel;
        const rows = history.filter((h) => h.stage === s.id).map((h) => ({ stage: s.id, confidence: h.confidence ?? 0.95, reversible: true }));
        return {
          id: s.id, name: s.name, does: s.assistant.does, level, label: AUTONOMY_LABELS[level], max: Math.min(cap, s.assistant.maxLevel) as AutonomyLevel,
          locked: s.outcomes.filter((o) => o.locked).map((o) => o.locked), sopRefs: s.sopRefs,
          preview: ([0, 1, 2, 3, 4] as AutonomyLevel[]).filter((l) => l <= Math.min(cap, s.assistant.maxLevel)).map((l) => ({ level: l, label: AUTONOMY_LABELS[l], ...consequencePreview(rows, s.id, l, floor) })),
        };
      }),
    };
  });
}

// ─── Logo ───────────────────────────────────────────────────────────────────

export interface LogoRef { sha: string; mime: string; name?: string }
const LOGO_TYPES: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/webp": (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
  "image/svg+xml": (b) => /<svg[\s>]/i.test(b.subarray(0, 4096).toString("utf8")),
};
export const LOGO_MAX_BYTES = 512 * 1024;

/** Keep an uploaded logo. It becomes part of a brand draft when the draft is saved, and is used once published. */
export async function storeLogo(u: SessionUser, file: { buf: Buffer; mime: string; name: string }): Promise<LogoRef> {
  if (!u.roles.includes("process-owner") && !u.roles.includes("operator") && u.kind !== "operator") throw new HttpError(403, "Only the process owner can change the brand.");
  const mime = file.mime === "image/jpg" ? "image/jpeg" : file.mime;
  const check = LOGO_TYPES[mime];
  if (!check) throw new HttpError(400, "Use a PNG, JPEG, WebP or SVG image for the logo.");
  if (file.buf.length > LOGO_MAX_BYTES) throw new HttpError(400, "The logo is larger than 512 KB. Use a smaller image.");
  if (!check(file.buf)) throw new HttpError(400, "That file isn't the kind of image its name says it is.");
  const stored = await putFile(file.buf);
  await asUser(u, (tx) => record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "config", id: "brand:logo" }, action: "brand.logo-uploaded", data: { sha256: stored.sha256, mime, name: file.name, bytes: file.buf.length } }));
  return { sha: stored.sha256, mime, name: file.name };
}

/** The logo of the signed-in person's funder: the published one, or a draft's for Studio's preview. */
export async function logoFor(u: SessionUser, version?: number): Promise<{ buf: Buffer; mime: string } | undefined> {
  if (version !== undefined && !u.roles.some((r) => ["process-owner", "operator", "compliance-auditor"].includes(r)) && u.kind !== "operator") throw new HttpError(403, "Not allowed.");
  const logo = await asUser(u, async (tx) => {
    const row = version !== undefined
      ? await one<{ body: { logo?: LogoRef } }>(tx, "select body from config_versions where tenant_id = $1 and kind = 'brand' and version = $2", [u.tenantId, version])
      : await one<{ body: { logo?: LogoRef } }>(tx, "select settings->'brand' as body from tenants where id = $1", [u.tenantId]);
    return row?.body?.logo;
  });
  if (!logo?.sha || !/^[0-9a-f]{64}$/.test(logo.sha)) return undefined;
  return { buf: await getFile(`${logo.sha.slice(0, 2)}/${logo.sha}`), mime: logo.mime };
}

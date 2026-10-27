// The guided Studio: a funder's setup in the order a grants team thinks about it. Documents first (policy and SOP);
// FundingEnvoy reads them and proposes the words, the limits, the documents requestors must provide and the time
// allowed at each stage, each with the clause it came from. A person confirms or changes each step; every step saves
// a draft; one signature publishes them all. Nothing changes for requests until then.
import type { Catalogue, Pack, Role, Rulebook, WorkflowDef } from "@fe/core";
import { isCoreRule } from "@fe/core";
import { many, one, type Tx } from "@fe/db";
import { parseClauses, readDocument, type SetupProposal } from "@fe/agent";
import { actorOf, asUser, HttpError, type SessionUser } from "../auth.ts";
import { loadPacks, type ConfigKind } from "../config.ts";
import { record } from "./requests.ts";
import { provider } from "./assistant.ts";
import { createDraft, discardDraft, draftFromSop, publish, runTests, updateDraft, validate } from "./studio.ts";

const ORDER: ConfigKind[] = ["policy", "sop", "words", "brand", "catalogue", "rulebook", "workflow", "autonomy", "testset"];
const LABEL: Record<string, string> = {
  policy: "Policy", sop: "SOP", words: "Words", brand: "Look", catalogue: "Documents requestors provide",
  rulebook: "Limits and checks", workflow: "Workflow", autonomy: "Assistant", testset: "Test set",
};
const WORD_KEYS = ["request", "committee", "reviewingTeam", "reconciliation", "assistantName"] as const;
const WORD_LABEL: Record<string, string> = {
  request: "A request is called", committee: "The deciding committee is called", reviewingTeam: "A reviewing team is called",
  reconciliation: "The report on how funds were spent is called", assistantName: "The assistant is called",
};
const PARAMS = [
  { key: "leadTimeDays", label: "Minimum lead time", unit: "days between submission and the activity", kind: "days" },
  { key: "revenueCap", label: "Revenue cap", unit: "% of the organization's annual revenue, across all its requests in a year", kind: "percent" },
  { key: "singleApproverMaxUSD", label: "Single-approver limit", unit: "US$; charitable contributions up to this amount need one approver, not the committee", kind: "money" },
  { key: "budgetTolerance", label: "Budget tolerance", unit: "US$ difference allowed between the amount requested and the budget total", kind: "money" },
] as const;

function requireStudio(u: SessionUser, edit = false) {
  const roles = edit ? ["process-owner", "operator"] : ["process-owner", "operator", "compliance-auditor"];
  if (!u.roles.some((r) => roles.includes(r)) && u.kind !== "operator") throw new HttpError(403, edit ? "Only the process owner can change the setup." : "Studio is for the process owner.");
  if (!u.tenantId) throw new HttpError(400, "Choose a funder first.", "no-tenant");
}

interface Row<T> { version: number; status: string; body: T; note: string | null; signed_name: string | null; signed_at: Date | null; created_at: Date }
async function current<T>(tx: Tx, tenantId: string, kind: ConfigKind) {
  const rows = await many<Row<T>>(tx, "select version, status, body, note, signed_name, signed_at, created_at from config_versions where tenant_id = $1 and kind = $2 and status in ('draft','published') order by version desc", [tenantId, kind]);
  const draft = rows.find((r) => r.status === "draft"), published = rows.find((r) => r.status === "published");
  return { draft, published, body: (draft ?? published)?.body };
}

async function upsertDraft(u: SessionUser, kind: ConfigKind, body: unknown, note: string) {
  const d = await asUser(u, (tx) => one<{ version: number }>(tx, "select version from config_versions where tenant_id = $1 and kind = $2 and status = 'draft'", [u.tenantId, kind]));
  if (d) { await updateDraft(u, kind, d.version, body); return d.version; }
  return (await createDraft(u, kind, note, body)).version;
}

// ─── What the screens show ───────────────────────────────────────────────────

export async function setupView(u: SessionUser) {
  requireStudio(u);
  return asUser(u, async (tx) => {
    const t = u.tenantId!;
    const [policy, sop, words, catalogue, rulebook, workflow] = await Promise.all([
      current<{ title: string; markdown: string }>(tx, t, "policy"), current<{ title: string; markdown: string }>(tx, t, "sop"),
      current<Record<string, string>>(tx, t, "words"), current<Catalogue>(tx, t, "catalogue"),
      current<Rulebook>(tx, t, "rulebook"), current<WorkflowDef>(tx, t, "workflow"),
    ]);
    const tenant = await one<{ name: string; settings: { createdFrom?: string } }>(tx, "select name, settings from tenants where id = $1", [t]);
    const saved = await one<{ body: SetupProposal; documents: Record<string, string>; provider: string; created_by: string; created_at: Date }>(tx, "select body, documents, provider, created_by, created_at from studio_proposals where tenant_id = $1", [t]);
    const drafts = await many<{ kind: string; version: number }>(tx, "select kind, version from config_versions where tenant_id = $1 and status = 'draft'", [t]);
    const packs = await loadPacks(tx);

    const doc = (c: typeof policy) => c.body ? {
      title: c.body.title, words: c.body.markdown.split(/\s+/).length, clauses: c.body.markdown.split("\n").filter((l) => /^\s*(?:#{1,6}\s*)?(?:\*\*)?\d+(\.\d+)+/.test(l)).length,
      status: c.draft ? "draft" : "published", copiedFrom: /^Copied from /.test(c.published?.note ?? "") && !c.draft ? c.published!.note!.replace(/^Copied from /, "") : undefined,
      signedName: c.published?.signed_name ?? undefined, signedAt: c.published?.signed_at ?? undefined,
    } : undefined;

    // Clauses in the current documents, to show where a check's basis no longer exists.
    const refs = new Set([
      ...(policy.body ? parseClauses(policy.body.markdown, "Policy", policy.body.title) : []),
      ...(sop.body ? parseClauses(sop.body.markdown, "SOP", sop.body.title) : []),
    ].map((c) => c.ref));
    const fresh = Boolean(saved && policy.body && sop.body && saved.documents.policy === policy.body.title && saved.documents.sop === sop.body.title);

    // Documents requestors provide: one row per kind of document, across request types.
    const docRows = new Map<string, { type: string; label: string; help?: string; usedIn: string[]; always: boolean; sometimes: boolean }>();
    for (const s of catalogue.body?.subtypes ?? []) for (const d of s.documents) {
      const r = docRows.get(d.type) ?? { type: d.type, label: d.label, help: d.help, usedIn: [], always: false, sometimes: false };
      r.usedIn.push(s.name);
      if (d.required) r.always = true; else if (d.requiredWhen) r.sometimes = true;
      docRows.set(d.type, r);
    }
    const adopted = new Set((rulebook.body?.packs ?? []).map((p) => p.id));
    const disabled = new Set(rulebook.body?.disabled ?? []);

    return {
      funder: tenant?.name, copiedFrom: tenant?.settings.createdFrom,
      documents: { policy: doc(policy), sop: doc(sop) },
      proposal: saved ? { ...saved.body, provider: saved.provider, by: saved.created_by, at: saved.created_at, fresh } : undefined,
      words: WORD_KEYS.map((k) => ({ key: k, label: WORD_LABEL[k], value: words.body?.[k] ?? "", proposed: (saved?.body.words as Record<string, unknown> | undefined)?.[k] })),
      limits: PARAMS.map((p) => ({ ...p, value: (rulebook.body?.parameters as Record<string, unknown> | undefined)?.[p.key] as number | undefined, proposed: (saved?.body.parameters as Record<string, unknown> | undefined)?.[p.key] })),
      requestorDocuments: [...docRows.values()].map((d) => ({ ...d, status: d.always ? "always" : d.sometimes ? "sometimes" : "optional", inDocuments: saved?.body.documents.find((x) => x.type === d.type) })),
      checks: (rulebook.body?.rules ?? []).map((r) => ({
        id: r.id, statement: r.statement, severity: r.severity, basis: r.basis.ref, enabled: !disabled.has(r.id),
        locked: Boolean((r as { locked?: boolean }).locked) || isCoreRule(r.id),
        basisMissing: /^(Policy|SOP) /.test(r.basis.ref) && refs.size > 0 && !refs.has(r.basis.ref.split(/[,;]/)[0]!.trim()),
      })),
      packs: packs.filter((p: Pack) => adopted.has(p.id)).map((p: Pack) => ({ id: p.id, name: p.name, rules: p.rules.length, verification: p.verification.status })),
      workflow: [...(workflow.body?.stages ?? [])].sort((a, b) => a.order - b.order).map((s) => ({
        id: s.id, order: s.order, name: s.name, ownerRoles: s.ownerRoles, slaBusinessDays: s.slaBusinessDays ?? null, sopRefs: s.sopRefs,
        proposed: saved?.body.stageTimes.find((x) => x.stage === s.id),
      })),
      drafts: ORDER.filter((k) => drafts.some((d) => d.kind === k)).map((k) => ({ kind: k, label: LABEL[k], version: drafts.find((d) => d.kind === k)!.version })),
    };
  });
}

// ─── Step 1: documents ───────────────────────────────────────────────────────

export async function uploadDocument(u: SessionUser, kind: "policy" | "sop", input: { title?: string; text?: string; file?: { buf: Buffer; name: string; mime: string } }) {
  requireStudio(u, true);
  let text = input.text ?? "";
  if (input.file) {
    const r = await readDocument(input.file.buf, input.file.name, input.file.mime);
    text = r.pages.join("\n\n");
    if (r.kind === "unknown" || !text.trim()) throw new HttpError(400, "FundingEnvoy couldn't read text from that file. Use a PDF, Word (.docx), Markdown or text file.");
  }
  text = text.replace(/\r\n/g, "\n").trim();
  if (text.split(/\s+/).length < 40) throw new HttpError(400, `That ${kind === "sop" ? "SOP" : "policy"} is too short to work from. Upload the full document.`);
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const title = (input.title?.trim() || heading || input.file?.name.replace(/\.[a-z0-9]+$/i, "") || (kind === "sop" ? "SOP" : "Policy")).slice(0, 160);
  const clauses = parseClauses(text, kind === "sop" ? "SOP" : "Policy", title).length;
  if (kind === "policy") {
    await upsertDraft(u, "policy", { title, markdown: text }, `New policy: ${title}`);
    await asUser(u, (tx) => record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "config", id: "policy" }, action: "studio.document-uploaded", data: { kind, title, clauses, words: text.split(/\s+/).length } }));
    return { kind, title, clauses };
  }
  // A new SOP re-drafts the workflow; start both drafts afresh from the new text.
  for (const k of ["sop", "workflow"] as const) {
    const d = await asUser(u, (tx) => one<{ version: number }>(tx, "select version from config_versions where tenant_id = $1 and kind = $2 and status = 'draft'", [u.tenantId, k]));
    if (d) await discardDraft(u, k, d.version);
  }
  const r = await draftFromSop(u, { title, markdown: text });
  await asUser(u, (tx) => record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "config", id: "sop" }, action: "studio.document-uploaded", data: { kind, title, clauses } }));
  return { kind, title, clauses, comparison: r };
}

// ─── Reading the documents ───────────────────────────────────────────────────

export async function propose(u: SessionUser) {
  requireStudio(u, true);
  const input = await asUser(u, async (tx) => {
    const t = u.tenantId!;
    const policy = (await current<{ title: string; markdown: string }>(tx, t, "policy")).body;
    const sop = (await current<{ title: string; markdown: string }>(tx, t, "sop")).body;
    const cat = (await current<Catalogue>(tx, t, "catalogue")).body;
    const wf = (await current<WorkflowDef>(tx, t, "workflow")).body;
    const types = new Map<string, string>();
    for (const s of cat?.subtypes ?? []) for (const d of s.documents) if (!types.has(d.type)) types.set(d.type, d.label);
    return { policy, sop, documentTypes: [...types].map(([type, label]) => ({ type, label })), stages: (wf?.stages ?? []).map((s) => ({ id: s.id, name: s.name, sopRefs: s.sopRefs })) };
  });
  if (!input.policy && !input.sop) throw new HttpError(409, "Upload the policy or the SOP first.");
  const p = await provider();
  const { trace, ...proposal } = await p.proposeSetup(input);
  await asUser(u, async (tx) => {
    await tx.query(`insert into studio_proposals (tenant_id, body, documents, provider, created_by) values ($1,$2,$3,$4,$5)
      on conflict (tenant_id) do update set body = excluded.body, documents = excluded.documents, provider = excluded.provider, created_by = excluded.created_by, created_at = now()`,
      [u.tenantId, JSON.stringify(proposal), JSON.stringify({ policy: input.policy?.title, sop: input.sop?.title }), p.name, u.name]);
    await record(tx, { tenantId: u.tenantId!, actor: { type: "agent", id: "fundingenvoy", name: "FundingEnvoy" }, entity: { type: "config", id: "setup" }, action: "assistant.proposed-setup", ai: trace, data: {
      words: Object.keys(proposal.words), limits: Object.keys(proposal.parameters), documents: proposal.documents.map((d) => d.type), stageTimes: proposal.stageTimes.length, requestedBy: u.name,
    } });
  });
  return { ...proposal, provider: p.name };
}

// ─── Steps 2 to 4: saving choices as drafts ──────────────────────────────────

export async function saveWords(u: SessionUser, words: Record<string, string>) {
  requireStudio(u, true);
  const now = await asUser(u, (tx) => current<Record<string, string>>(tx, u.tenantId!, "words"));
  const body = { ...(now.body ?? {}) };
  for (const k of WORD_KEYS) if (typeof words[k] === "string" && words[k]!.trim()) body[k] = words[k]!.trim().slice(0, 60);
  return { version: await upsertDraft(u, "words", body, "Words") };
}

export async function saveRequirements(u: SessionUser, input: { limits?: Record<string, number | null>; documents?: Record<string, "always" | "optional">; checks?: Record<string, boolean> }) {
  requireStudio(u, true);
  const { rb, cat } = await asUser(u, async (tx) => ({ rb: (await current<Rulebook>(tx, u.tenantId!, "rulebook")).body, cat: (await current<Catalogue>(tx, u.tenantId!, "catalogue")).body }));
  if (!rb || !cat) throw new HttpError(409, "This funder has no rulebook or catalogue to change.");
  const out: Record<string, number> = {};
  if (input.limits || input.checks) {
    const params = { ...(rb.parameters as Record<string, unknown>) };
    for (const [k, v] of Object.entries(input.limits ?? {})) {
      if (!PARAMS.some((p) => p.key === k) || v === null || v === undefined) continue;
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${PARAMS.find((p) => p.key === k)!.label} must be a positive number.`);
      if (k === "revenueCap" && v > 1) throw new HttpError(400, "The revenue cap is a share of revenue, at most 100%.");
      params[k] = v;
    }
    const disabled = new Set(rb.disabled ?? []);
    for (const [id, on] of Object.entries(input.checks ?? {})) {
      const r = rb.rules.find((x) => x.id === id);
      if (!r) continue;
      if ((r as { locked?: boolean }).locked || isCoreRule(id)) { if (!on) throw new HttpError(400, `${id} is a platform safeguard and can't be switched off.`); continue; }
      if (on) disabled.delete(id); else disabled.add(id);
    }
    out.rulebook = await upsertDraft(u, "rulebook", { ...rb, parameters: params, disabled: [...disabled] }, "Limits and checks");
  }
  if (input.documents && Object.keys(input.documents).length) {
    const subtypes = cat.subtypes.map((s) => ({
      ...s,
      documents: s.documents.map((d) => {
        const want = input.documents![d.type];
        if (want === "optional") return { ...d, required: false, requiredWhen: undefined };
        if (want === "always" && !d.required && !d.requiredWhen) return { ...d, required: true };
        return d;
      }),
    }));
    out.catalogue = await upsertDraft(u, "catalogue", { ...cat, subtypes }, "Documents requestors provide");
  }
  return out;
}

const ROLE_SET = new Set<Role>(["coordinator", "medical-reviewer", "compliance-reviewer", "legal", "committee-member", "committee-chair", "finance", "tax", "compliance-auditor", "process-owner", "requestor", "org-admin"]);
export async function saveWorkflow(u: SessionUser, stages: { id: string; slaBusinessDays?: number | null; ownerRoles?: string[] }[]) {
  requireStudio(u, true);
  const wf = await asUser(u, async (tx) => (await current<WorkflowDef>(tx, u.tenantId!, "workflow")).body);
  if (!wf) throw new HttpError(409, "This funder has no workflow to change.");
  const byId = new Map(stages.map((s) => [s.id, s]));
  const next = {
    ...wf,
    stages: wf.stages.map((s) => {
      const c = byId.get(s.id);
      if (!c) return s;
      const roles = c.ownerRoles?.filter((r): r is Role => ROLE_SET.has(r as Role));
      return { ...s, ...(c.slaBusinessDays !== undefined ? { slaBusinessDays: c.slaBusinessDays ?? undefined } : {}), ...(roles?.length ? { ownerRoles: roles } : {}) };
    }),
  };
  return { version: await upsertDraft(u, "workflow", next, "Workflow") };
}

// ─── Step 6: check and publish everything ────────────────────────────────────

async function draftsOf(u: SessionUser) {
  return asUser(u, (tx) => many<{ kind: ConfigKind; version: number }>(tx, "select kind, version from config_versions where tenant_id = $1 and status = 'draft'", [u.tenantId]));
}

export async function checkAll(u: SessionUser) {
  requireStudio(u);
  const drafts = (await draftsOf(u)).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const results = [];
  for (const d of drafts) {
    const v = await validate(u, d.kind, d.version);
    results.push({ kind: d.kind, label: LABEL[d.kind] ?? d.kind, version: d.version, issues: v.issues });
  }
  const rb = drafts.find((d) => d.kind === "rulebook")?.version, cat = drafts.find((d) => d.kind === "catalogue")?.version;
  const tests = await runTests(u, { rulebookVersion: rb, catalogueVersion: cat });
  const said: Record<string, string> = { pass: "passes", fail: "fails", warn: "warns", na: "doesn't apply", pending: "is waiting" };
  const explain = (r: (typeof tests.results)[number]) => [
    ...r.mismatches.map((m) => `check ${m.ruleId} now ${said[m.actual] ?? m.actual} (it ${said[m.expected] ?? m.expected} today)`),
    ...(r.submittable.expected !== r.submittable.actual ? [r.submittable.actual ? "it could now be submitted" : "it could no longer be submitted"] : []),
  ];
  return { drafts: results, tests: { passed: tests.passed, total: tests.total, failing: tests.results.filter((r) => !r.ok).map((r) => ({ id: r.id, title: r.title, mismatches: explain(r) })) } };
}

export async function publishAll(u: SessionUser, input: { typedName: string; acceptDifferences?: string }) {
  if (!u.roles.includes("process-owner")) throw new HttpError(403, "Only the process owner can publish.");
  if (input.typedName.trim().toLowerCase() !== u.name.trim().toLowerCase()) throw new HttpError(400, `Type your full name exactly as "${u.name}" to sign.`);
  const drafts = (await draftsOf(u)).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  if (!drafts.length) throw new HttpError(409, "There are no changes to publish.");
  // Check everything before publishing anything.
  const problems: string[] = [];
  for (const d of drafts) {
    const v = await validate(u, d.kind, d.version);
    for (const i of v.issues.filter((x) => x.severity === "error" && !(x.message.includes("test cases disagree") && input.acceptDifferences?.trim()))) problems.push(`${LABEL[d.kind] ?? d.kind}: ${i.message}`);
  }
  if (problems.length) throw new HttpError(409, `Nothing was published. Fix these first: ${problems.join(" ")}`, "invalid");
  const published = [];
  for (const d of drafts) {
    const r = await publish(u, d.kind, d.version, input);
    published.push({ kind: d.kind, label: LABEL[d.kind] ?? d.kind, version: d.version, diff: r.diff.summary });
  }
  return { published };
}

export async function discardAll(u: SessionUser) {
  requireStudio(u, true);
  const drafts = await draftsOf(u);
  for (const d of drafts) await discardDraft(u, d.kind, d.version);
  return { discarded: drafts.length };
}

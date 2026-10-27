// The requestor-side assistant. Orchestration here is deterministic: what to ask next comes from the
// request's state, the catalogue and the rule results. The provider only reads text.
import type { Actor, AiTrace, CheckResult, FieldValue, RequestState, Rule } from "@fe/core";
import { buildFacts, effectiveLevel, formatMoney, gateProposal, summarize, transition, budgetTotal, toNumber, LOCKED_ACTIONS } from "@fe/core";
import { alsoCovers, createProvider, readDocument, retrieve, scopeCheck, DECLINE_TEXT, type AssistantProvider, type FieldProposal } from "@fe/agent";
import { many, one, type Tx } from "@fe/db";
import { actorOf, asUser, HttpError, type SessionUser } from "../auth.ts";
import { tenantConfig } from "../config.ts";
import { putFile } from "../storage.ts";
import {
  addMessage, fieldsFor, finalRef, loadRequest, nextDraftRef, record, requiredProgress, runChecks, saveState, setField, today, view, type Loaded,
} from "./requests.ts";
import { autoAdvance } from "./workflow.ts";
import { rescreen } from "./screening.ts";

let providerPromise: Promise<AssistantProvider> | undefined;
export function provider(): Promise<AssistantProvider> {
  providerPromise ??= createProvider();
  return providerPromise;
}

export async function assistantActor(tx: Tx, tenantId: string): Promise<Actor> {
  const t = await one<{ settings: { words?: { assistantName?: string } } }>(tx, "select settings from tenants where id = $1", [tenantId]);
  return { type: "agent", id: "fundingenvoy", name: t?.settings?.words?.assistantName ?? "FundingEnvoy" };
}

export interface Ask {
  kind: "type" | "budget" | "coi" | "field" | "document" | "flag" | "attestations" | "ready" | "conflict";
  questionId: string;
  text: string;
  options?: { id: string; label: string }[];
  fieldKey?: string;
  ruleId?: string;
}

function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith("?") || /^(can|could|may|do|does|is|are|what|how|which|when|who|why|should|would|will)\b/.test(t);
}

function ruleById(l: Loaded): Map<string, Rule> {
  return new Map(l.cfg.rulebook.rules.map((r) => [r.id, r]));
}

/** Decide what to ask the requestor next, in a fixed order a person can predict. */
const TITLES = /^(dr|pr|prof|mr|mrs|ms|mx|sir|dame)\.?$/i;
/** "Dr. Elena Marsh" is greeted as "Dr. Marsh"; "Teresa Quinlan" as "Teresa". */
export function greetingName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 && TITLES.test(parts[0]!) ? `${parts[0]} ${parts.at(-1)}` : parts[0]!;
}

/** Lower-case the first letter only, so names inside a reason keep their capitals. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function nextAsk(l: Loaded, checks: CheckResult[]): Ask {
  const st = l.state;
  const rules = ruleById(l);
  if (!st.typeConfirmed) {
    const opts = l.cfg.catalogue.subtypes.map((s) => ({ id: `subtype:${s.id}`, label: s.name }));
    return { kind: "type", questionId: "type", text: "Which of these best describes your request? It decides what else I ask for and who reviews it.", options: opts };
  }
  const mismatch = checks.find((c) => c.status === "fail" && rules.get(c.ruleId)?.check.kind === "equalsWithin" && !c.acknowledged);
  if (mismatch && st.budget.length) {
    const total = budgetTotal(st);
    const req = toNumber(st.fields["amount.requested"]?.value);
    const cur = (st.fields["amount.currency"]?.value as string) ?? "USD";
    return {
      kind: "budget", questionId: `budget:${mismatch.ruleId}`, ruleId: mismatch.ruleId,
      text: `Your budget totals ${formatMoney(total, cur)} but you're requesting ${formatMoney(req, cur)}. Should I use the budget total, or is a line missing?`,
      options: [
        { id: "use-budget", label: `Request ${formatMoney(total, cur)}` },
        { id: "keep-request", label: `Keep ${formatMoney(req, cur)} and explain` },
        { id: "upload", label: "Upload a revised budget" },
      ],
    };
  }
  const coiIds = l.subtype?.coi ?? [];
  const nextCoi = coiIds.find((q) => !st.coi[q]);
  const answeredCoi = coiIds.length - coiIds.filter((q) => !st.coi[q]).length;
  const progress = requiredProgress(l);
  const missingField = progress.missing.find((f) => f.kind !== "boolean" || true);
  if (missingField) {
    return { kind: "field", questionId: `field:${missingField.key}`, fieldKey: missingField.key, text: `${missingField.label}?${missingField.help ? ` ${missingField.help}` : ""}` };
  }
  if (progress.missingDocs.length) {
    const req = l.subtype!.documents.find((d) => d.type === progress.missingDocs[0])!;
    return { kind: "document", questionId: `doc:${req.type}`, text: `Please upload: ${req.label}.${req.help ? ` ${req.help}` : ""}`, options: [{ id: `upload:${req.type}`, label: "Upload" }] };
  }
  if (nextCoi) {
    const q = l.cfg.catalogue.coiQuestions.find((x) => x.id === nextCoi)!;
    return {
      kind: "coi", questionId: `coi:${q.id}`, text: `Conflict of interest, question ${answeredCoi + 1} of ${coiIds.length}: ${q.text}${q.help ? ` ${q.help}` : ""}`,
      options: [{ id: "no", label: "No" }, { id: "yes", label: "Yes, I'll give details" }],
    };
  }
  const warn = checks.find((c) => c.status === "fail" && c.severity === "warn" && !c.acknowledged);
  if (warn) {
    return {
      kind: "flag", questionId: `flag:${warn.ruleId}`, ruleId: warn.ruleId, text: `${warn.requestorMessage ?? warn.message} You can submit with this flagged for the reviewer, or change it.`,
      options: [{ id: "submit-with-flag", label: "Submit with the flag" }, { id: "change", label: "Change it" }],
    };
  }
  const block = checks.find((c) => (c.status === "fail" || c.status === "pending") && c.severity === "block" && rules.get(c.ruleId)?.check.kind !== "attestationsComplete");
  if (block) {
    return { kind: "field", questionId: `check:${block.ruleId}`, ruleId: block.ruleId, text: block.requestorMessage ?? block.message, options: block.actions.map((a) => ({ id: a.id, label: a.label })) };
  }
  const att = checks.find((c) => (c.status === "fail") && rules.get(c.ruleId)?.check.kind === "attestationsComplete");
  if (att) return { kind: "attestations", questionId: "attestations", text: "Last step: your statements. These are yours to make; I can't make them for you. They're recorded with your name and the time." };
  return { kind: "ready", questionId: "ready", text: "Everything Halden's policy asks for is in. Review exactly what will be sent, in your name, and submit when you're ready." };
}

async function askNext(tx: Tx, l: Loaded, fe: Actor, checks: CheckResult[], lead?: string) {
  const ask = nextAsk(l, checks);
  if (!lead) {
    // Edits in the document re-ask only when the question has changed; the conversation doesn't repeat itself.
    const last = await one<{ ask: { text?: string } | null }>(tx, "select data->'ask' as ask from messages where request_id = $1 and data ? 'ask' order by created_at desc limit 1", [l.row.id]);
    if (last?.ask?.text === ask.text) return ask;
  }
  const body = lead ? `${lead}\n\n${ask.text}` : ask.text;
  await addMessage(tx, l, fe, body, { ask });
  return ask;
}

async function recheckAndSave(tx: Tx, l: Loaded, patch: Partial<RequestState> = {}): Promise<CheckResult[]> {
  Object.assign(l.state, patch);
  const checks = runChecks(l, "draft");
  await saveState(tx, l, { ...patch, checks });
  return checks;
}

function proposalToField(p: FieldProposal, fe: Actor): FieldValue {
  return { value: p.value, status: "proposed", source: p.source, proposedBy: fe };
}

async function logAi(tx: Tx, l: Loaded, fe: Actor, action: string, trace: AiTrace, data: Record<string, unknown>, outcome: "proposed" | "applied" | "held-for-person") {
  const stage = l.cfg.workflow.stages.find((s) => s.id === l.state.stage);
  const level = stage ? effectiveLevel(stage, l.cfg.autonomy, buildFacts({ ...l.ctx, request: l.state })) : 3;
  await record(tx, { tenantId: l.row.tenant_id, actor: fe, entity: { type: "request", id: l.row.id }, action, data: { requestId: l.row.id, ...data }, ai: { ...trace, gate: { stage: l.state.stage, level, outcome } } });
}

// ─── Entry points ───────────────────────────────────────────────────────────

export async function startRequest(u: SessionUser, input: { text?: string; country?: string }) {
  if (u.kind !== "requestor" || !u.orgId || !u.tenantId) throw new HttpError(403, "Only a requestor signed in to a funder's portal can start a request.");
  const id = await asUser(u, async (tx) => {
    const cfg = await tenantConfig(tx, u.tenantId!);
    const org = await one<{ country: string }>(tx, "select country from organizations where id = $1", [u.orgId]);
    const ref = await nextDraftRef(tx, u.tenantId!);
    const now = new Date().toISOString();
    const first = [...cfg.workflow.stages].sort((a, b) => a.order - b.order)[0]!;
    const state: RequestState = {
      id: "", tenantId: u.tenantId!, ref, organizationId: u.orgId!, requestorId: u.id, typeConfirmed: false, country: input.country ?? org?.country ?? "US",
      status: "draft", stage: first.id, fields: {}, budget: [], documents: [], attestations: {}, coi: {}, checks: [], flags: [], versions: cfg.versions, createdAt: now,
    };
    const row = await one<{ id: string }>(tx,
      `insert into requests (tenant_id, ref, org_id, requestor_id, country, status, stage, state, versions) values ($1,$2,$3,$4,$5,'draft',$6,$7,$8) returning id`,
      [u.tenantId, ref, u.orgId, u.id, state.country, first.id, state, cfg.versions]);
    await tx.query("update requests set state = jsonb_set(state, '{id}', to_jsonb($1::text)) where id = $1", [row!.id]);
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "request", id: row!.id }, action: "request.started", data: { requestId: row!.id, ref, versions: cfg.versions } });
    await rescreen(tx, u.tenantId!, u.orgId!, "intake", row!.id);
    const fe = await assistantActor(tx, u.tenantId!);
    const l = await loadRequest(tx, row!.id);
    if (!input.text) {
      await addMessage(tx, l, fe, `Hello ${greetingName(u.name)}. I can help you prepare a funding request. Tell me about the activity, upload what you have, or use the form. I check everything against the company's policy as we go, and nothing is sent until you confirm.\n\nI'm an AI assistant. I can explain the policy and check your request; I can't predict or make funding decisions.`, { intro: true });
    }
    return row!.id;
  });
  if (input.text) await onMessage(u, id, input.text);
  return id;
}

export async function onMessage(u: SessionUser, requestId: string, text: string) {
  const p = await provider();
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    const fe = await assistantActor(tx, l.row.tenant_id);
    const msg = await addMessage(tx, l, actorOf(u), text);
    await record(tx, { tenantId: l.row.tenant_id, actor: actorOf(u), entity: { type: "request", id: l.row.id }, action: "message.sent", data: { requestId: l.row.id, messageId: msg!.id, chars: text.length } });

    // 1. Scope boundary, enforced in code.
    const decline = scopeCheck(text);
    if (decline) {
      await addMessage(tx, l, fe, DECLINE_TEXT[decline], { declined: decline });
      await record(tx, { tenantId: l.row.tenant_id, actor: fe, entity: { type: "request", id: l.row.id }, action: "assistant.declined", data: { requestId: l.row.id, reason: decline } });
      return;
    }

    // 2. A pending field question takes the reply as the answer.
    const pending = await lastAsk(tx, l.row.id);
    if (pending?.kind === "field" && pending.fieldKey && !isQuestion(text)) {
      const f = fieldsFor(l.cfg, l.subtype).find((x) => x.key === pending.fieldKey);
      const value = f && (f.kind === "number" || f.kind === "money") ? toNumber(text) ?? text : text.trim();
      l.state = setField(l.state, pending.fieldKey, { value, status: "confirmed", source: { kind: "message", messageId: msg!.id, quote: text.slice(0, 200) } }, actorOf(u));
      await record(tx, { tenantId: l.row.tenant_id, actor: actorOf(u), entity: { type: "request", id: l.row.id }, action: "field.answered", data: { requestId: l.row.id, key: pending.fieldKey, value } });
      const checks = await recheckAndSave(tx, l);
      await askNext(tx, l, fe, checks, "Thanks, recorded as yours.");
      return;
    }
    if (pending?.kind === "coi" && pending.questionId.startsWith("coi:") && !isQuestion(text)) {
      // Free-text reply to a COI question is treated as a "yes" with detail; the requestor confirms by having typed it.
      await answerCoiTx(tx, u, l, pending.questionId.slice(4), /^\s*no\b/i.test(text) ? "no" : "yes", text, fe);
      return;
    }

    // 3. Policy questions are answered from quoted clauses, or declined.
    if (isQuestion(text)) {
      const hits = retrieve(text, l.cfg.clauses, 3);
      const ans = await p.answerPolicy(text, hits.map((h) => h.clause));
      if (ans.declined) {
        await addMessage(tx, l, fe, DECLINE_TEXT["out-of-corpus"], { declined: "out-of-corpus" });
      } else {
        await addMessage(tx, l, fe, ans.answer, { citations: ans.citations, policyAnswer: true });
      }
      await logAi(tx, l, fe, "assistant.policy-answer", ans.trace, { question: text.slice(0, 300), citations: ans.citations.map((c) => c.ref), declined: ans.declined }, "applied");
      return;
    }

    // 4. Otherwise read facts from the message (they are the requestor's own words, so they count as confirmed).
    const fields = fieldsFor(l.cfg, l.subtype);
    const ext = await p.extractFromMessage(text, fields, msg!.id);
    for (const pr of ext.proposals) {
      if (l.state.fields[pr.key]?.status === "confirmed") continue;
      l.state = setField(l.state, pr.key, { value: pr.value, status: "confirmed", source: pr.source }, actorOf(u));
    }
    if (ext.proposals.length) await logAi(tx, l, fe, "assistant.read-message", ext.trace, { keys: ext.proposals.map((x) => x.key) }, "applied");
    if (!l.state.typeConfirmed) await classify(tx, l, fe, text, ext.proposals);
    const checks = await recheckAndSave(tx, l);
    if (!l.state.typeConfirmed) return; // the classification question was asked
    await askNext(tx, l, fe, checks, ext.proposals.length ? `Noted: ${ext.proposals.map((x) => fields.find((f) => f.key === x.key)?.label ?? x.key).join(", ")}.` : undefined);
  });
}

async function classify(tx: Tx, l: Loaded, fe: Actor, text: string, proposals: FieldProposal[]) {
  const p = await provider();
  const c = await p.classifyRequest({ text, proposals, catalogue: l.cfg.catalogue, country: l.state.country });
  await logAi(tx, l, fe, "assistant.classified", c.trace, { subtype: c.subtype, confidence: c.confidence, reasons: c.reasons }, "proposed");
  if (c.subtype) l.state = { ...l.state, subtype: c.subtype, family: l.cfg.catalogue.subtypes.find((s) => s.id === c.subtype)?.family, typeConfirmed: false };
  const sub = l.cfg.catalogue.subtypes.find((s) => s.id === c.subtype);
  const q = c.question ?? { text: `This looks like ${sub?.name ?? "a request"}. Is that right?`, options: [] };
  const options = q.options.length ? q.options.map((o) => ({ id: o.subtype ? `subtype:${o.subtype}` : o.id, label: o.label })) : l.cfg.catalogue.subtypes.map((s) => ({ id: `subtype:${s.id}`, label: s.name }));
  const lead = sub ? `This looks like ${sub.name.toLowerCase()}${c.reasons.length ? ` (${lowerFirst(c.reasons[0]!)})` : ""}. One thing to confirm first, because it decides what else I ask for and who reviews it:` : "One thing first:";
  await addMessage(tx, l, fe, `${lead}\n\n${q.text}`, { ask: { kind: "type", questionId: "type", text: q.text, options } satisfies Ask });
}

async function lastAsk(tx: Tx, requestId: string): Promise<Ask | undefined> {
  const m = await one<{ data: { ask?: Ask } }>(tx, "select data from messages where request_id = $1 and author->>'type' = 'agent' and channel = 'requestor' order by created_at desc limit 1", [requestId]);
  return m?.data.ask;
}

function assertOwnDraftOrInfo(u: SessionUser, l: Loaded) {
  if (u.kind === "requestor" && l.row.requestor_id !== u.id && l.row.org_id !== u.orgId) throw new HttpError(403, "This request belongs to another organization.");
  if (!["draft", "info-requested"].includes(l.state.status)) throw new HttpError(409, "This request has been submitted. Changes go through the coordinator's information request.");
}

export async function onUpload(u: SessionUser, requestId: string, files: { name: string; mime: string; buf: Buffer; typeHint?: string }[]) {
  const p = await provider();
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    const fe = await assistantActor(tx, l.row.tenant_id);
    const known = uniqueDocTypes(l);
    const read: { id: string; name: string; type: string; pages: string[]; classifiedBy: string; confidence: number; covers: { type: string; page: number }[] }[] = [];
    let budgetLines: RequestState["budget"] | undefined;
    const warnings: string[] = [];
    for (const f of files) {
      const stored = await putFile(f.buf);
      const docId = (await one<{ id: string }>(tx, "select gen_random_uuid() as id"))!.id;
      const r = await readDocument(f.buf, f.name, f.mime, { documentId: docId });
      warnings.push(...r.warnings);
      let type = f.typeHint, by = "requestor", confidence = 1;
      if (!type) {
        const c = await p.classifyDocument({ name: f.name, mime: f.mime, pages: r.pages }, known);
        type = c.type; by = "assistant"; confidence = c.confidence;
        await logAi(tx, l, fe, "assistant.classified-document", c.trace, { documentId: docId, name: f.name, type, confidence, reason: c.reason }, "applied");
      }
      const dated = /(\d{4})/.exec(f.name)?.[1];
      const covers = alsoCovers(r.pages, type!, known.map((k) => k.type));
      await tx.query(
        `insert into documents (id, tenant_id, org_id, request_id, type, name, mime, size, sha256, storage_key, page_count, pages_text, dated, classified_by, uploaded_by, covers)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [docId, l.row.tenant_id, l.row.org_id, l.row.id, type, f.name, f.mime, f.buf.length, stored.sha256, stored.key, r.pages.length, JSON.stringify(r.pages), dated && Number(dated) > 1990 && Number(dated) < 2100 ? `${dated}-12-31` : null, by, u.id, covers.map((c) => c.type)]);
      await record(tx, { tenantId: l.row.tenant_id, actor: actorOf(u), entity: { type: "request", id: l.row.id }, action: "document.uploaded", data: { requestId: l.row.id, documentId: docId, name: f.name, sha256: stored.sha256, type, pages: r.pages.length } });
      if (r.budget?.length && (type === "budget" || !budgetLines)) budgetLines = r.budget.map((b) => ({ ...b, source: { ...b.source!, documentId: docId } }));
      read.push({ id: docId, name: f.name, type: type!, pages: r.pages, classifiedBy: by, confidence, covers });
    }
    // Extract proposals from everything readable.
    const fields = fieldsFor(l.cfg, l.subtype);
    const ext = await p.extractFields({ documents: read.filter((d) => d.pages.length).map((d) => ({ id: d.id, name: d.name, type: d.type, pages: d.pages })), fields, subtype: l.state.subtype });
    let applied = 0;
    const skipped: string[] = [];
    for (const pr of ext.proposals) {
      const cur = l.state.fields[pr.key];
      if (cur && cur.status !== "proposed" && JSON.stringify(cur.value) !== JSON.stringify(pr.value)) { skipped.push(pr.key); continue; }
      l.state = setField(l.state, pr.key, proposalToField(pr, fe), fe);
      applied++;
    }
    if (budgetLines) l.state = { ...l.state, budget: budgetLines };
    await logAi(tx, l, fe, "assistant.extracted", ext.trace, { documentIds: read.map((d) => d.id), proposed: applied, conflicts: ext.conflicts.map((c) => c.key), budgetLines: budgetLines?.length ?? 0 }, "proposed");

    l.docs = [...l.docs, ...read.flatMap((d) => [{ id: d.id, type: d.type, name: d.name, sha256: "", pagesText: d.pages }, ...d.covers.map((c) => ({ id: d.id, type: c.type, name: d.name, sha256: "", pagesText: d.pages }))])];
    l.ctx.documents = l.docs;
    if (!l.state.typeConfirmed) {
      await classify(tx, l, fe, String(l.state.fields.title?.value ?? read.map((d) => d.name).join(" ")), ext.proposals);
    }
    l.subtype = l.cfg.catalogue.subtypes.find((s) => s.id === l.state.subtype);
    l.ctx.subtype = l.subtype;
    const checks = await recheckAndSave(tx, l);
    const progress = requiredProgress(l);
    const docList = read.map((d) => `${d.name} (${labelFor(l, d.type)}${d.classifiedBy === "assistant" ? ", classified by me" : ""}${d.covers.length ? `; it also contains the ${d.covers.map((c) => `${labelFor(l, c.type).toLowerCase()} on page ${c.page}`).join(" and the ")}, so I've counted it for that too` : ""})`).join("; ");
    const lead = [
      `I read ${read.length === 1 ? "it" : read.length === 2 ? "both" : `all ${read.length}`}: ${docList}.`,
      applied ? `I filled in ${applied} value${applied === 1 ? "" : "s"}${progress.total ? `; ${progress.answered} of the ${progress.total} things this request needs are now in` : ""}. Each shows where it came from, and stays marked as proposed until you confirm it.` : "I didn't find values I could fill in.",
      budgetLines ? `The budget has ${budgetLines.length} lines totalling ${formatMoney(budgetTotal(l.state), (l.state.fields["amount.currency"]?.value as string) ?? "USD")}.` : "",
      ext.conflicts.length ? `Your documents disagree on: ${ext.conflicts.map((c) => fields.find((f) => f.key === c.key)?.label ?? c.key).join(", ")}. I've used the first and flagged it; I won't pick for you.` : "",
      skipped.length ? `I didn't overwrite values you had already confirmed: ${skipped.map((k) => fields.find((f) => f.key === k)?.label ?? k).join(", ")}.` : "",
      warnings.join(" "),
    ].filter(Boolean).join(" ");
    await addMessage(tx, l, fe, lead, { extracted: { applied, documentIds: read.map((d) => d.id), conflicts: ext.conflicts } });
    if (l.state.typeConfirmed) await askNext(tx, l, fe, checks);
  });
}

function uniqueDocTypes(l: Loaded): { type: string; label: string }[] {
  const m = new Map<string, string>();
  for (const s of l.cfg.catalogue.subtypes) for (const d of s.documents) if (!m.has(d.type)) m.set(d.type, d.label);
  return [...m.entries()].map(([type, label]) => ({ type, label }));
}

function labelFor(l: Loaded, type: string): string {
  return uniqueDocTypes(l).find((d) => d.type === type)?.label ?? type;
}

export async function onChoice(u: SessionUser, requestId: string, questionId: string, optionId: string, note?: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    const fe = await assistantActor(tx, l.row.tenant_id);
    const me = actorOf(u);
    const opt = (await lastAskWithId(tx, l.row.id, questionId))?.options?.find((o) => o.id === optionId);
    await addMessage(tx, l, me, opt?.label ?? optionId, { choice: { questionId, optionId } });

    if (questionId === "type") {
      if (!optionId.startsWith("subtype:")) {
        await addMessage(tx, l, fe, "No problem. Tell me a little more about who runs the activity and whether learners receive credit, and I'll suggest the type again. You can also pick it directly.", { ask: { kind: "type", questionId: "type", text: "Pick the type directly", options: l.cfg.catalogue.subtypes.map((s) => ({ id: `subtype:${s.id}`, label: s.name })) } satisfies Ask });
        return;
      }
      const sub = l.cfg.catalogue.subtypes.find((s) => s.id === optionId.slice(8));
      if (!sub) throw new HttpError(400, "Unknown request type.");
      l.state = { ...l.state, subtype: sub.id, family: sub.family, typeConfirmed: true };
      l.subtype = sub; l.ctx.subtype = sub;
      // Proposals for fields not in this subtype are dropped; their history stays in the trail.
      const keys = new Set(sub.fields.map((f) => f.key));
      l.state.fields = Object.fromEntries(Object.entries(l.state.fields).filter(([k]) => keys.has(k)));
      await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "request.type-confirmed", data: { requestId: l.row.id, subtype: sub.id } });
      const checks = await recheckAndSave(tx, l);
      const weeks = sub.typicalDecisionWeeks ? ` Decisions for this type usually take ${sub.typicalDecisionWeeks[0]} to ${sub.typicalDecisionWeeks[1]} weeks after a complete submission.` : "";
      const salesNote = sub.family === "education" ? " The company can have no role in choosing faculty or content, and the agreement will say so." : "";
      await askNext(tx, l, fe, checks, `Then this is ${sub.name.toLowerCase()}.${salesNote}${weeks}`);
      return;
    }
    if (questionId.startsWith("budget:")) {
      const ruleId = questionId.slice(7);
      if (optionId === "use-budget") {
        const total = budgetTotal(l.state);
        l.state = setField(l.state, "amount.requested", { value: total, status: "changed", source: { kind: "derived", note: "Set to the itemized budget total" } }, me, note ?? "Match itemized budget");
        await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "field.changed", data: { requestId: l.row.id, key: "amount.requested", value: total, reason: note ?? "Match itemized budget" } });
        const checks = await recheckAndSave(tx, l);
        await askNext(tx, l, fe, checks, `Done: the request is now ${formatMoney(total, (l.state.fields["amount.currency"]?.value as string) ?? "USD")}.`);
      } else if (optionId === "keep-request") {
        await acknowledgeTx(tx, u, l, ruleId, "submit-with-flag", note ?? "Requestor kept the requested amount", fe);
      } else {
        await addMessage(tx, l, fe, "Upload the revised budget and I'll read it again.", { ask: { kind: "document", questionId: "doc:budget", text: "Upload the revised budget", options: [{ id: "upload:budget", label: "Upload" }] } satisfies Ask });
      }
      return;
    }
    if (questionId.startsWith("coi:")) {
      if (optionId === "yes" && !note) {
        await addMessage(tx, l, fe, "Please tell me the details in your own words. They're recorded as yours, and a compliance reviewer will look at them.", { ask: { kind: "coi", questionId, text: "Details" } satisfies Ask });
        return;
      }
      await answerCoiTx(tx, u, l, questionId.slice(4), optionId === "yes" ? "yes" : "no", note, fe);
      return;
    }
    if (questionId.startsWith("flag:")) {
      if (optionId === "submit-with-flag") await acknowledgeTx(tx, u, l, questionId.slice(5), "submit-with-flag", note, fe);
      else await addMessage(tx, l, fe, "Change it in the request on the right, or tell me what's different, and I'll check again.", {});
      return;
    }
    throw new HttpError(400, "That question is no longer open.");
  });
}

async function lastAskWithId(tx: Tx, requestId: string, questionId: string): Promise<Ask | undefined> {
  const rows = await many<{ data: { ask?: Ask } }>(tx, "select data from messages where request_id = $1 and author->>'type' = 'agent' order by created_at desc limit 20", [requestId]);
  return rows.map((r) => r.data.ask).find((a) => a?.questionId === questionId);
}

async function answerCoiTx(tx: Tx, u: SessionUser, l: Loaded, qid: string, answer: "yes" | "no", detail: string | undefined, fe: Actor) {
  const me = actorOf(u);
  if (!l.subtype?.coi.includes(qid)) throw new HttpError(400, "Unknown question.");
  l.state = { ...l.state, coi: { ...l.state.coi, [qid]: { questionId: qid, answer, detail, by: me, at: new Date().toISOString() } } };
  await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "coi.answered", data: { requestId: l.row.id, questionId: qid, answer, detail } });
  const checks = await recheckAndSave(tx, l);
  const q = l.cfg.catalogue.coiQuestions.find((x) => x.id === qid);
  await askNext(tx, l, fe, checks, answer === "yes" ? `Recorded as yours. ${q?.ifYes ?? "A compliance reviewer will look at this before the decision."}` : undefined);
}

export async function answerCoi(u: SessionUser, requestId: string, qid: string, answer: "yes" | "no", detail?: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    await answerCoiTx(tx, u, l, qid, answer, detail, await assistantActor(tx, l.row.tenant_id));
  });
}

async function acknowledgeTx(tx: Tx, u: SessionUser, l: Loaded, ruleId: string, choice: string, note: string | undefined, fe: Actor) {
  const me = actorOf(u);
  l.state = { ...l.state, flags: [...l.state.flags.filter((f) => f.ruleId !== ruleId), { ruleId, choice, note, by: me, at: new Date().toISOString() }] };
  await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "flag.acknowledged", data: { requestId: l.row.id, ruleId, choice, note } });
  const checks = await recheckAndSave(tx, l);
  await askNext(tx, l, fe, checks, "Noted. The reviewer will see this flag and your note.");
}

export async function acknowledge(u: SessionUser, requestId: string, ruleId: string, choice: string, note?: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    await acknowledgeTx(tx, u, l, ruleId, choice, note, await assistantActor(tx, l.row.tenant_id));
  });
}

export async function updateFields(u: SessionUser, requestId: string, changes: { key: string; value?: unknown; confirm?: boolean; reason?: string }[]) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    const me = actorOf(u);
    const allowed = new Set(fieldsFor(l.cfg, l.subtype).map((f) => f.key));
    for (const c of changes) {
      if (!allowed.has(c.key)) throw new HttpError(400, `Unknown field ${c.key}.`);
      const cur = l.state.fields[c.key];
      if (c.value === undefined && c.confirm && cur) {
        l.state = setField(l.state, c.key, { ...cur, status: "confirmed" }, me);
        await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "field.confirmed", data: { requestId: l.row.id, key: c.key, value: cur.value, source: cur.source } });
      } else if (c.value !== undefined) {
        const changed = cur !== undefined && JSON.stringify(cur.value) !== JSON.stringify(c.value);
        l.state = setField(l.state, c.key, { value: c.value, status: changed ? "changed" : "confirmed", source: changed ? { kind: "form", note: c.reason } : cur?.source ?? { kind: "form" } }, me, c.reason);
        await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: changed ? "field.changed" : "field.set", data: { requestId: l.row.id, key: c.key, value: c.value, previous: cur?.value, reason: c.reason } });
      }
    }
    const checksAfter = await recheckAndSave(tx, l);
    if (l.state.status === "draft") await askNext(tx, l, await assistantActor(tx, l.row.tenant_id), checksAfter);
  });
}

export async function confirmAll(u: SessionUser, requestId: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    const me = actorOf(u);
    const keys = Object.entries(l.state.fields).filter(([, v]) => v.status === "proposed").map(([k]) => k);
    for (const k of keys) l.state = setField(l.state, k, { ...l.state.fields[k]!, status: "confirmed" }, me);
    if (keys.length) await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "field.confirmed-all", data: { requestId: l.row.id, keys } });
    const checksAfter = await recheckAndSave(tx, l);
    if (l.state.status === "draft") await askNext(tx, l, await assistantActor(tx, l.row.tenant_id), checksAfter);
    return keys.length;
  });
}

export async function updateBudget(u: SessionUser, requestId: string, op: { removeLine?: number; addLine?: { description: string; category: string; amount: number }; note?: string }) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    if (op.removeLine !== undefined) {
      const line = l.state.budget.find((b) => b.line === op.removeLine);
      if (!line) throw new HttpError(404, "No such budget line.");
      l.state = { ...l.state, budget: l.state.budget.filter((b) => b.line !== op.removeLine) };
      await record(tx, { tenantId: l.row.tenant_id, actor: actorOf(u), entity: { type: "request", id: l.row.id }, action: "budget.line-removed", data: { requestId: l.row.id, line } });
    }
    if (op.addLine) {
      const line = { line: Math.max(0, ...l.state.budget.map((b) => b.line)) + 1, ...op.addLine, source: { kind: "form" as const } };
      l.state = { ...l.state, budget: [...l.state.budget, line] };
      await record(tx, { tenantId: l.row.tenant_id, actor: actorOf(u), entity: { type: "request", id: l.row.id }, action: "budget.line-added", data: { requestId: l.row.id, line, note: op.note } });
    }
    const checks = await recheckAndSave(tx, l);
    await askNext(tx, l, await assistantActor(tx, l.row.tenant_id), checks);
  });
}

/** Link the organization's latest document of this type from an earlier request to this one, and say so. */
export async function reuseDocument(u: SessionUser, requestId: string, type: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    const src = await one<{ id: string; name: string; dated: string | null; request_ref: string | null }>(tx, `
      select d.id, d.name, d.dated, r.ref as request_ref from documents d left join requests r on r.id = d.request_id
      where d.org_id = $1 and d.type = $2 and (d.request_id is null or d.request_id <> $3) order by d.dated desc nulls last, d.created_at desc limit 1`, [l.row.org_id, type, l.row.id]);
    if (!src) throw new HttpError(404, "Your organization has no earlier document of that kind to reuse. Please upload it.");
    const r = await one<{ id: string }>(tx, `insert into documents (tenant_id, org_id, request_id, type, name, mime, size, sha256, storage_key, page_count, pages_text, dated, classified_by, uploaded_by)
      select $2, org_id, $3, type, name, mime, size, sha256, storage_key, page_count, pages_text, dated, classified_by, $4 from documents where id = $1 returning id`, [src.id, l.row.tenant_id, l.row.id, u.id]);
    await record(tx, { tenantId: l.row.tenant_id, actor: actorOf(u), entity: { type: "request", id: l.row.id }, action: "document.reused", data: { requestId: l.row.id, documentId: r!.id, from: src.id, fromRequest: src.request_ref, type } });
    const reloaded = await loadRequest(tx, requestId);
    const checks = await recheckAndSave(tx, reloaded);
    await askNext(tx, reloaded, await assistantActor(tx, l.row.tenant_id), checks, `Added ${src.name}${src.dated ? ` (dated ${src.dated})` : ""} from ${src.request_ref ? `request ${src.request_ref}` : "your profile"}. It stays on your earlier request too.`);
    return { ok: true, documentId: r!.id };
  });
}

export async function attest(u: SessionUser, requestId: string, attId: string, typedName?: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    if (u.kind !== "requestor") throw new HttpError(403, "Only the requestor can make this statement.");
    const def = l.cfg.catalogue.attestations.find((a) => a.id === attId);
    if (!def || !l.subtype?.attestations.includes(attId)) throw new HttpError(400, "This statement does not apply to this request.");
    if (def.mode === "type" && (typedName ?? "").trim().toLowerCase() !== u.name.trim().toLowerCase()) {
      throw new HttpError(400, `Type your full name exactly as "${u.name}" to make this statement.`);
    }
    const me = actorOf(u);
    // LOCKED_ACTIONS.attest: a person, not the assistant, makes every statement.
    if (!LOCKED_ACTIONS.attest.roles.some((r) => u.roles.includes(r))) throw new HttpError(403, "Only the requestor can make this statement.");
    l.state = { ...l.state, attestations: { ...l.state.attestations, [attId]: { id: attId, version: def.version, text: def.text, typedName, by: me, at: new Date().toISOString() } } };
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "attestation.made", data: { requestId: l.row.id, attestation: attId, version: def.version, text: def.text, typedName } });
    const checksAfter = await recheckAndSave(tx, l);
    if (l.state.status === "draft") await askNext(tx, l, await assistantActor(tx, l.row.tenant_id), checksAfter);
  });
}

/** Exactly what will be written to the system of record, for the requestor to read before submitting. */
export async function preview(u: SessionUser, requestId: string) {
  return asUser(u, async (tx) => {
    const l0 = await loadRequest(tx, requestId);
    const stale = l0.org.screening.some((s) => s.checkedAt.slice(0, 10) !== today());
    if (stale && ["draft", "info-requested"].includes(l0.state.status)) await rescreen(tx, l0.row.tenant_id, l0.row.org_id, "submission", requestId);
    const l = stale ? await loadRequest(tx, requestId) : l0;
    const checks = runChecks(l, "submit");
    const s = summarize(checks);
    const unacked = checks.filter((c) => c.status === "fail" && c.severity === "warn" && !c.acknowledged);
    const proposed = Object.entries(l.state.fields).filter(([, v]) => v.status === "proposed").map(([k]) => k);
    const stagesAhead = l.cfg.workflow.stages.filter((st) => st.order > (l.cfg.workflow.stages.find((x) => x.id === l.state.stage)?.order ?? 0)).slice(0, 6).map((st) => ({ id: st.id, name: st.name, owner: st.ownerRoles, slaBusinessDays: st.slaBusinessDays }));
    return {
      ...view(l, checks),
      canSubmit: s.submittable && !unacked.length && !proposed.length,
      blockers: [
        ...s.mustFix.map((c) => ({ ruleId: c.ruleId, text: c.requestorMessage ?? c.message })),
        ...unacked.map((c) => ({ ruleId: c.ruleId, text: `Decide: ${c.requestorMessage ?? c.message}` })),
        ...(proposed.length ? [{ ruleId: "proposed", text: `Confirm or change ${proposed.length} proposed value${proposed.length === 1 ? "" : "s"}.` }] : []),
      ],
      flagsForReviewer: checks.filter((c) => c.acknowledged || c.status === "judge").map((c) => ({ ruleId: c.ruleId, text: c.message, note: c.acknowledged?.note })),
      whatHappensNext: stagesAhead,
    };
  });
}

export async function submit(u: SessionUser, requestId: string) {
  const out = await asUser(u, async (tx) => {
    const l0 = await loadRequest(tx, requestId);
    await rescreen(tx, l0.row.tenant_id, l0.row.org_id, "submission", requestId);
    const l = await loadRequest(tx, requestId);
    assertOwnDraftOrInfo(u, l);
    const me = actorOf(u);
    const fe = await assistantActor(tx, l.row.tenant_id);
    const checks = runChecks(l, "submit");
    const s = summarize(checks);
    const unacked = checks.filter((c) => c.status === "fail" && c.severity === "warn" && !c.acknowledged);
    const proposed = Object.values(l.state.fields).filter((v) => v.status === "proposed").length;
    if (!s.submittable || unacked.length || proposed) {
      throw new HttpError(409, [
        s.mustFix.length ? `${s.mustFix.length} item${s.mustFix.length === 1 ? "" : "s"} must be fixed first.` : "",
        unacked.length ? `${unacked.length} decision${unacked.length === 1 ? " is" : "s are"} yours to make first.` : "",
        proposed ? `${proposed} proposed value${proposed === 1 ? "" : "s"} still need${proposed === 1 ? "s" : ""} your confirmation.` : "",
      ].filter(Boolean).join(" "), "not-ready");
    }
    const facts = buildFacts({ ...l.ctx, request: l.state });
    const stage = l.cfg.workflow.stages.find((x) => x.id === l.state.stage)!;
    const out = stage.outcomes.find((o) => !["withdraw", "decline"].includes(o.id))!;
    const t = transition({ wf: l.cfg.workflow, currentStageId: stage.id, outcomeId: out.id, actor: me, facts, checks });
    const ref = l.row.ref.startsWith("D-") ? await finalRef(tx, l.row.tenant_id, l.state.family) : l.row.ref;
    await tx.query("update requests set ref = $2 where id = $1", [l.row.id, ref]);
    l.row.ref = ref;
    const now = new Date().toISOString();
    const summaryMd = reviewSummary(l, checks, ref);
    l.state = { ...l.state, ref, status: t.status, stage: t.to, submittedAt: l.state.submittedAt ?? now, checks, reviewSummary: { generatedAt: now, rulebookVersion: l.state.versions.rulebook, markdown: summaryMd } };
    await saveState(tx, l);
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "request.submitted", data: { requestId: l.row.id, ref, from: t.from, to: t.to, skipped: t.skipped, flags: l.state.flags.map((f) => f.ruleId), rulebookVersion: l.state.versions.rulebook } });
    await record(tx, { tenantId: l.row.tenant_id, actor: fe, entity: { type: "request", id: l.row.id }, action: "assistant.review-summary", data: { requestId: l.row.id, checks: checks.length, passed: s.passed.length, forReviewer: s.forReviewer.length + l.state.flags.length } });
    await addMessage(tx, l, fe, `Submitted as ${ref} on ${now.slice(0, 10)}, in your name. I'll tell you when a reviewer picks it up and when anything is needed from you.`, { submitted: true });
    return { ref };
  });
  await autoAdvance(requestId, u);
  return out;
}

export function reviewSummary(l: Loaded, checks: CheckResult[], ref: string): string {
  const s = summarize(checks);
  const line = (c: CheckResult) => `| ${c.statement} | ${c.status === "pass" ? "Pass" : c.acknowledged ? "Flag (requestor chose to submit)" : c.status === "judge" ? "For a reviewer" : c.status} | ${c.evidence.map((e) => `${e.label}${e.value ? `: ${e.value}` : ""}`).join("; ") || c.basis.ref} |`;
  return [
    `# Pre-submission review summary · ${ref}`,
    `Rulebook v${l.state.versions.rulebook} · workflow v${l.state.versions.workflow} · ${checks.length} checks · ${s.passed.length} passed · ${s.forReviewer.length + s.yourCall.length} for a person`,
    "",
    "| Check | Result | Evidence |", "|---|---|---|",
    ...checks.filter((c) => c.status !== "na").map(line),
    "",
    "## What the assistant did",
    `Proposed ${Object.values(l.state.fields).filter((f) => f.proposedBy?.type === "agent").length} values from documents, each confirmed by the requestor. Classified ${l.docs.filter((d) => d.classifiedBy === "assistant").length} documents. It did not decide anything.`,
  ].join("\n");
}

export async function askPolicy(u: SessionUser, question: string) {
  const p = await provider();
  return asUser(u, async (tx) => {
    const decline = scopeCheck(question);
    if (decline) return { answer: DECLINE_TEXT[decline], citations: [], declined: decline };
    const cfg = await tenantConfig(tx, u.tenantId!);
    const hits = retrieve(question, cfg.clauses, 3);
    const a = await p.answerPolicy(question, hits.map((h) => h.clause));
    await record(tx, { tenantId: u.tenantId!, actor: await assistantActor(tx, u.tenantId!), entity: { type: "policy", id: "ask" }, action: "assistant.policy-answer", data: { question: question.slice(0, 300), citations: a.citations.map((c) => c.ref), declined: a.declined, askedBy: u.id }, ai: a.trace });
    return a.declined ? { answer: DECLINE_TEXT["out-of-corpus"], citations: [], declined: a.declined } : { answer: a.answer, citations: a.citations };
  });
}

export { gateProposal, today };

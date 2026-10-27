// Moving requests through the tenant's workflow: automatic steps the assistant may take, triage,
// reviewer and coordinator actions, information requests and committee decisions.
import type { Actor, CheckResult, Condition, InfoRequest, RequestState } from "@fe/core";
import {
  assertPersonForLockedAction, assertSeparationOfDuties, buildFacts, dueDate, effectiveLevel, evaluate, formatMoney, gateProposal, summarize, transition,
  TransitionError, GateError,
} from "@fe/core";
import { many, one, withContext, type Tx } from "@fe/db";
import { randomUUID } from "node:crypto";
import { actorOf, asUser, HttpError, type SessionUser } from "../auth.ts";
import { addMessage, loadRequest, record, runChecks, saveState, tenantSettings, type Loaded } from "./requests.ts";
import { onEnterStage } from "./contracting.ts";

export interface ReviewingGroup { id: string; label: string; when: Condition }

const DEFAULT_GROUPS: ReviewingGroup[] = [
  { id: "us-medical-education", label: "US medical education", when: { all: [{ fact: "family", op: "eq", value: "education" }, { fact: "country", op: "eq", value: "US" }] } },
  { id: "uk-medical-education", label: "UK medical education", when: { all: [{ fact: "family", op: "eq", value: "education" }, { fact: "country", op: "eq", value: "GB" }] } },
  { id: "fr-affiliate", label: "France affiliate", when: { fact: "country", op: "eq", value: "FR" } },
  { id: "us-charitable", label: "US charitable contributions", when: { all: [{ fact: "family", op: "eq", value: "charitable" }, { fact: "country", op: "eq", value: "US" }] } },
  { id: "uk-charitable", label: "UK charitable contributions", when: { all: [{ fact: "family", op: "eq", value: "charitable" }, { fact: "country", op: "eq", value: "GB" }] } },
  { id: "global-committee", label: "Global committee", when: { always: true } },
];

export async function reviewingGroups(tx: Tx, tenantId: string): Promise<ReviewingGroup[]> {
  const s = await tenantSettings(tx, tenantId);
  return (s.reviewingGroups as ReviewingGroup[] | undefined) ?? DEFAULT_GROUPS;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Routing: the tenant's triage rules in order (rulebook parameter "triage"), else the built-in groups. */
export function triage(l: Loaded, groups: ReviewingGroup[]): { group: ReviewingGroup; rule: string } {
  const facts = buildFacts({ ...l.ctx, request: l.state });
  const mapping = l.cfg.rulebook.parameters.triage as { ruleId: string; group: string }[] | undefined;
  if (mapping?.length) {
    for (const m of mapping) {
      const rule = l.cfg.rulebook.rules.find((r) => r.id === m.ruleId);
      if (rule && evaluate(rule.scope, facts)) return { group: { id: slug(m.group), label: m.group, when: rule.scope }, rule: m.ruleId };
    }
  }
  const g = groups.find((x) => evaluate(x.when, facts)) ?? groups[groups.length - 1]!;
  return { group: g, rule: `default:${g.id}` };
}

export function triageGroups(l: Loaded, fallback: ReviewingGroup[]): ReviewingGroup[] {
  const mapping = l.cfg.rulebook.parameters.triage as { ruleId: string; group: string }[] | undefined;
  if (!mapping?.length) return fallback;
  return [...new Map(mapping.map((m) => [slug(m.group), { id: slug(m.group), label: m.group, when: { always: true } as Condition }])).values()];
}

function feActor(name = "FundingEnvoy"): Actor {
  return { type: "agent", id: "fundingenvoy", name };
}

export async function createTask(tx: Tx, l: Loaded, kind: string, title: string, role: string, data: Record<string, unknown> = {}, dueAt?: string) {
  await tx.query("insert into tasks (tenant_id, request_id, kind, title, assignee_role, due_at, data) values ($1,$2,$3,$4,$5,$6,$7)",
    [l.row.tenant_id, l.row.id, kind, title, role, dueAt ?? null, data]);
}

async function closeTasks(tx: Tx, requestId: string, kind?: string) {
  await tx.query(`update tasks set status = 'done', completed_at = now() where request_id = $1 and status = 'open' ${kind ? "and kind = $2" : ""}`, kind ? [requestId, kind] : [requestId]);
}

/**
 * After a person acts, let the assistant take the next steps it is allowed to take at its autonomy level.
 * Level 4 steps are applied and logged; level 3 steps become a proposal plus a task for a person; level 2 and below stop.
 */
export async function autoAdvance(requestId: string, by: SessionUser | { tenantId: string }) {
  const tenantId = "tenantId" in by && by.tenantId ? by.tenantId : undefined;
  if (!tenantId) return;
  await withContext({ tenantId }, async (tx) => {
    for (let guard = 0; guard < 6; guard++) {
      const l = await loadRequest(tx, requestId);
      const stage = l.cfg.workflow.stages.find((s) => s.id === l.state.stage);
      if (!stage) return;
      const facts = buildFacts({ ...l.ctx, request: l.state });
      const level = effectiveLevel(stage, l.cfg.autonomy, facts);
      const s = await tenantSettings(tx, tenantId);
      const fe = feActor((s.words as { assistantName?: string } | undefined)?.assistantName);
      const forward = stage.outcomes.find((o) => !o.locked && !["decline", "request-info", "withdraw", "defer", "return"].includes(o.id));

      if (stage.id === "completeness" || /complete/.test(stage.id)) {
        const checks = runChecks(l, "review");
        const sum = summarize(checks);
        if (!sum.submittable || !forward) {
          await createTask(tx, l, "completeness", `${l.row.ref}: ${sum.mustFix.length} item(s) open after submission`, "coordinator", { ruleIds: sum.mustFix.map((c) => c.ruleId) });
          await saveState(tx, l, { checks });
          return;
        }
        const gate = gateProposal(level, { reversible: true });
        if (gate !== "applied") {
          await createTask(tx, l, "completeness", `${l.row.ref}: confirm completeness`, "coordinator");
          await record(tx, { tenantId, actor: fe, entity: { type: "request", id: l.row.id }, action: "assistant.completeness-checked", data: { requestId: l.row.id, passed: sum.passed.length }, ai: aiGate(stage.id, level, "held-for-person") });
          return;
        }
        const t = transition({ wf: l.cfg.workflow, currentStageId: stage.id, outcomeId: forward.id, actor: fe, facts, checks });
        await saveState(tx, l, { stage: t.to, status: t.status, checks });
        await record(tx, { tenantId, actor: fe, entity: { type: "request", id: l.row.id }, action: "stage.advanced", data: { requestId: l.row.id, from: t.from, to: t.to, outcome: forward.id, skipped: t.skipped, checks: checks.length, screening: l.org.screening.map((x) => `${x.list} ${x.result}`) }, ai: aiGate(stage.id, level, "applied") });
        continue;
      }

      if (stage.id === "triage" || /triage/.test(stage.id)) {
        const groups = await reviewingGroups(tx, tenantId);
        const { group, rule } = triage(l, groups);
        const gate = gateProposal(level, { confidence: 0.97, floor: l.cfg.autonomy?.confidenceFloor ?? 0.7, reversible: true });
        const proposed: RequestState["reviewingGroup"] = { id: group.id, label: group.label, by: "assistant", confidence: 0.97, rule };
        if (gate === "applied" && forward) {
          const t = transition({ wf: l.cfg.workflow, currentStageId: stage.id, outcomeId: forward.id, actor: fe, facts });
          await saveState(tx, l, { reviewingGroup: proposed, stage: t.to, status: t.status });
          await record(tx, { tenantId, actor: fe, entity: { type: "request", id: l.row.id }, action: "triage.applied", data: { requestId: l.row.id, group: group.id, rule, to: t.to }, ai: aiGate(stage.id, level, "applied") });
          await addMessage(tx, l, fe, `Routed to ${group.label} (rule ${rule}). A coordinator can change this.`, { triage: proposed }, "internal");
          continue;
        }
        if (!l.state.reviewingGroup) {
          await saveState(tx, l, { reviewingGroup: proposed });
          await createTask(tx, l, "triage", `${l.row.ref}: confirm routing to ${group.label}`, "coordinator", { group: group.id, rule });
          await record(tx, { tenantId, actor: fe, entity: { type: "request", id: l.row.id }, action: "triage.proposed", data: { requestId: l.row.id, group: group.id, rule }, ai: aiGate(stage.id, level, "held-for-person") });
        }
        return;
      }
      return; // every other stage needs a person
    }
  });
}

function aiGate(stage: string, level: number, outcome: "applied" | "held-for-person" | "proposed") {
  return { provider: "platform", model: "rulebook", promptVersion: "n/a", inputHashes: [], outputHash: "", gate: { stage, level: level as 0 | 1 | 2 | 3 | 4, outcome } };
}

// ─── People acting on a request ─────────────────────────────────────────────

export async function act(u: SessionUser, requestId: string, outcomeId: string, input: { reason?: string; groupId?: string; note?: string; form?: Record<string, unknown> }) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const me = actorOf(u);
    const stage = l.cfg.workflow.stages.find((s) => s.id === l.state.stage);
    if (!stage) throw new HttpError(409, "This request is not in an active stage.");
    const outcome = stage.outcomes.find((o) => o.id === outcomeId);
    if (!outcome) throw new HttpError(400, `"${outcomeId}" is not available at ${stage.name}.`);
    if (outcome.locked === "decide-funding") throw new HttpError(400, "Record the committee decision with the decision form; it captures the vote, recusals and rationale.");
    try {
      assertSeparationOfDuties("review", me, { requestedBy: l.row.requestor_id });
      const checks = runChecks(l, "review");
      const patch: Partial<RequestState> = { checks };
      if (stage.id.includes("triage") && input.groupId) {
        const g = triageGroups(l, await reviewingGroups(tx, l.row.tenant_id)).find((x) => x.id === input.groupId);
        if (!g) throw new HttpError(400, "Unknown reviewing group.");
        const overridden = l.state.reviewingGroup && l.state.reviewingGroup.id !== g.id;
        patch.reviewingGroup = { id: g.id, label: g.label, by: "person", rule: overridden ? "override" : l.state.reviewingGroup?.rule };
      }
      const t = transition({ wf: l.cfg.workflow, currentStageId: stage.id, outcomeId, actor: me, facts: buildFacts({ ...l.ctx, request: { ...l.state, ...patch } }), checks, reason: input.reason });
      if (/review/.test(stage.id)) {
        await tx.query("insert into reviews (tenant_id, request_id, stage, reviewer_id, outcome, reason, form) values ($1,$2,$3,$4,$5,$6,$7)", [l.row.tenant_id, l.row.id, stage.id, u.id, outcomeId, input.reason ?? null, input.form ?? {}]);
      }
      await saveState(tx, l, { ...patch, stage: t.to, status: t.status, ...(t.status === "declined" ? { decidedAt: new Date().toISOString() } : {}) });
      if (t.to !== t.from) await onEnterStage(tx, l);
      await closeTasks(tx, l.row.id);
      await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "stage.advanced", data: { requestId: l.row.id, from: t.from, to: t.to, outcome: outcomeId, reason: input.reason, note: input.note, skipped: t.skipped, reviewingGroup: patch.reviewingGroup } });
      const next = l.cfg.workflow.stages.find((s) => s.id === t.to);
      if (next && !["agreement", "payment"].includes(next.id)) {
        const role = next.ownerRoles[0];
        if (role) await createTask(tx, l, next.id, `${l.row.ref}: ${next.name}`, role, {}, dueDate(next, new Date().toISOString()));
      }
    } catch (e) {
      if (e instanceof TransitionError || e instanceof GateError) throw new HttpError(400, e.message, (e as TransitionError).code ?? "gate");
      throw e;
    }
  });
  await autoAdvance(requestId, u);
}

export async function judge(u: SessionUser, requestId: string, ruleId: string, decision: string, note?: string) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const me = actorOf(u);
    assertSeparationOfDuties("review", me, { requestedBy: l.row.requestor_id });
    const j = { ...(l.state.judgements ?? {}), [ruleId]: { decision, note, by: me, at: new Date().toISOString() } };
    await saveState(tx, l, { judgements: j });
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "judgement.recorded", data: { requestId: l.row.id, ruleId, decision, note } });
  });
}

export async function requestInfo(u: SessionUser, requestId: string, questions: string[], dueDays = 10) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const me = actorOf(u);
    if (!questions.length || questions.some((q) => !q.trim())) throw new HttpError(400, "Write at least one question.");
    const due = new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10);
    const ir: InfoRequest = { id: randomUUID(), by: me, at: new Date().toISOString(), status: "open", dueAt: due, questions: questions.map((text) => ({ id: randomUUID(), text: text.trim() })) };
    await saveState(tx, l, { infoRequests: [...(l.state.infoRequests ?? []), ir], status: "info-requested" });
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "info.requested", data: { requestId: l.row.id, infoRequestId: ir.id, questions, dueAt: due } });
    const s = await tenantSettings(tx, l.row.tenant_id);
    const fe = feActor((s.words as { assistantName?: string } | undefined)?.assistantName);
    const quoted = questions.map((q, i) => `${i + 1}. "${q.trim()}"`).join("\n");
    await addMessage(tx, l, fe, `${u.name} from the grants team asked ${questions.length === 1 ? "a question" : `${questions.length} questions`} on ${ir.at.slice(0, 10)}. Please answer by ${due}:\n\n${quoted}\n\nOnly these are open; the rest of your request stays as it is. When you're done I'll write a short "what changed" note for the reviewer.`, { infoRequest: ir.id });
    await tx.query("insert into tasks (tenant_id, request_id, kind, title, assignee_role, due_at, data) values ($1,$2,'info-request',$3,'requestor',$4,$5)", [l.row.tenant_id, l.row.id, `Answer ${questions.length} question(s) from the grants team`, due, { infoRequestId: ir.id }]);
  });
}

export async function answerInfo(u: SessionUser, requestId: string, infoRequestId: string, answers: { questionId: string; answer: string }[]) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const me = actorOf(u);
    const irs = l.state.infoRequests ?? [];
    const ir = irs.find((x) => x.id === infoRequestId);
    if (!ir || ir.status !== "open") throw new HttpError(404, "That information request is not open.");
    const now = new Date().toISOString();
    for (const a of answers) {
      const q = ir.questions.find((x) => x.id === a.questionId);
      if (q && a.answer.trim()) Object.assign(q, { answer: a.answer.trim(), answeredAt: now });
    }
    const done = ir.questions.every((q) => q.answer);
    const events = await many<{ action: string; data: Record<string, unknown>; at: Date }>(tx, "select action, data, at from events where tenant_id = $1 and data->>'requestId' = $2 and at > $3 order by seq", [l.row.tenant_id, l.row.id, ir.at]);
    const docs = events.filter((e) => e.action === "document.uploaded").map((e) => String(e.data.name));
    const fields = events.filter((e) => e.action.startsWith("field.")).map((e) => String(e.data.key));
    if (done) {
      ir.status = "answered";
      ir.whatChanged = [
        ...ir.questions.map((q) => `Answered: "${q.text}" → ${q.answer}`),
        docs.length ? `Added: ${docs.join(", ")}.` : "No documents added.",
        fields.length ? `Fields changed: ${[...new Set(fields)].join(", ")}.` : "No other fields changed.",
      ].join("\n");
    }
    await saveState(tx, l, { infoRequests: irs, status: done ? "in-review" : l.state.status });
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: done ? "info.answered" : "info.partially-answered", data: { requestId: l.row.id, infoRequestId, answers } });
    if (done) {
      await tx.query("update tasks set status = 'done', completed_at = now() where request_id = $1 and kind = 'info-request' and status = 'open'", [l.row.id]);
      const s = await tenantSettings(tx, l.row.tenant_id);
      const fe = feActor((s.words as { assistantName?: string } | undefined)?.assistantName);
      await addMessage(tx, l, fe, `What changed since the information request of ${ir.at.slice(0, 10)}:\n${ir.whatChanged}`, { whatChanged: ir.id }, "internal");
      await record(tx, { tenantId: l.row.tenant_id, actor: fe, entity: { type: "request", id: l.row.id }, action: "assistant.what-changed", data: { requestId: l.row.id, infoRequestId, note: ir.whatChanged } });
      await createTask(tx, l, "info-answered", `${l.row.ref}: requestor answered your questions`, "coordinator");
    }
  });
}

export async function decide(u: SessionUser, requestId: string, input: { outcome: "approve" | "approve-with-conditions" | "decline" | "defer"; amount?: number; conditions?: string; rationale: string; votes?: { memberId: string; vote: "for" | "against" | "abstain" }[]; recusals?: { memberId: string; reason: string }[]; meetingId?: string }) {
  await asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    const me = actorOf(u);
    const stage = l.cfg.workflow.stages.find((s) => s.id === l.state.stage);
    const outcome = stage?.outcomes.find((o) => o.id === input.outcome) ?? stage?.outcomes.find((o) => o.locked === "decide-funding" && o.id.startsWith(input.outcome.split("-")[0]!));
    if (!stage || !outcome || outcome.locked !== "decide-funding") throw new HttpError(409, "This request is not waiting for a funding decision.");
    try {
      assertPersonForLockedAction("decide-funding", me, outcome.actorRoles);
      assertSeparationOfDuties("decide-funding", me, { requestedBy: l.row.requestor_id });
    } catch (e) {
      throw new HttpError(403, (e as Error).message, "gate");
    }
    if (!input.rationale?.trim()) throw new HttpError(400, "A decision needs a rationale, recorded with your name.");
    const recusedIds = new Set((input.recusals ?? []).map((r) => r.memberId));
    if ((input.votes ?? []).some((v) => recusedIds.has(v.memberId))) throw new HttpError(400, "A recused member cannot vote.");
    const t = transition({ wf: l.cfg.workflow, currentStageId: stage.id, outcomeId: outcome.id, actor: me, facts: buildFacts({ ...l.ctx, request: l.state }), reason: input.rationale });
    const now = new Date().toISOString();
    const amount = input.amount ?? (l.state.fields["amount.requested"]?.value as number | undefined);
    await tx.query("insert into decisions (tenant_id, request_id, meeting_id, outcome, amount, conditions, rationale, votes, recusals, decided_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [l.row.tenant_id, l.row.id, input.meetingId ?? null, input.outcome, amount ?? null, input.conditions ?? null, input.rationale, JSON.stringify(input.votes ?? []), JSON.stringify(input.recusals ?? []), u.id]);
    await saveState(tx, l, { stage: t.to, status: t.status, decidedAt: now, decision: { outcome: input.outcome, amount, conditions: input.conditions, rationale: input.rationale, by: me, at: now } });
    if (t.to !== t.from) await onEnterStage(tx, l);
    await tx.query("update requests set decided_at = now() where id = $1", [l.row.id]);
    await closeTasks(tx, l.row.id);
    await record(tx, { tenantId: l.row.tenant_id, actor: me, entity: { type: "request", id: l.row.id }, action: "decision.recorded", data: { requestId: l.row.id, outcome: input.outcome, amount, conditions: input.conditions, rationale: input.rationale, votes: input.votes, recusals: input.recusals, to: t.to } });
    const s = await tenantSettings(tx, l.row.tenant_id);
    const fe = feActor((s.words as { assistantName?: string } | undefined)?.assistantName);
    const cur = (l.state.fields["amount.currency"]?.value as string) ?? "USD";
    const text = input.outcome === "decline"
      ? `The committee has decided not to fund this request. Reason recorded: ${input.rationale}`
      : input.outcome === "defer" ? "The committee has deferred this request to its next meeting. I'll tell you if anything is needed from you."
      : `The committee approved ${formatMoney(amount, cur)}${input.conditions ? ` with this condition: ${input.conditions}` : ""}. Next, the letter of agreement goes to your authorized signer for e-signature.`;
    await addMessage(tx, l, fe, text, { decision: input.outcome });
    const next = l.cfg.workflow.stages.find((x) => x.id === t.to);
    if (next?.ownerRoles[0] && !["agreement", "payment"].includes(next.id)) await createTask(tx, l, next.id, `${l.row.ref}: ${next.name}`, next.ownerRoles[0]);
  });
}

export type { CheckResult };

import type { Actor, CheckResult, OutcomeDef, RequestStatus, StageDef, WorkflowDef } from "../types.ts";
import { evaluate, type Facts } from "../conditions.ts";
import { assertPersonForLockedAction, GateError, MAX_LEVEL_AT_LOCKED_STAGE } from "../gates.ts";
import { addBusinessDays, isoDate, toDate } from "../dates.ts";
import { onlyLockedForward } from "../autonomy.ts";

const TERMINAL = new Set(["closed", "declined", "withdrawn"]);

const STATUS_BY_STAGE_ID: Record<string, RequestStatus> = {
  intake: "draft",
  completeness: "submitted",
  triage: "submitted",
  "medical-review": "in-review",
  "compliance-review": "in-review",
  committee: "committee",
  approval: "committee",
  agreement: "agreement",
  payment: "payment",
  reconciliation: "reconciliation",
  outcomes: "outcomes",
  "close-and-disclose": "closed",
  close: "closed",
};

export function statusFor(stage: StageDef | undefined, target?: string): RequestStatus {
  if (target === "declined") return "declined";
  if (target === "withdrawn") return "withdrawn";
  if (target === "closed") return "closed";
  if (!stage) return "draft";
  return stage.status ?? STATUS_BY_STAGE_ID[stage.id] ?? "in-review";
}

export function stageById(wf: WorkflowDef, id: string): StageDef | undefined {
  return wf.stages.find((s) => s.id === id);
}

/** Apply variations whose condition matches, returning an effective copy of the stage. */
export function effectiveStage(stage: StageDef, facts: Facts): StageDef {
  let s = stage;
  for (const v of stage.variations ?? []) {
    if (evaluate(v.when, facts)) s = { ...s, ...v.patch };
  }
  return s;
}

/** Resolve a target stage id, skipping stages whose skipWhen holds, following their first outcome. */
export function resolveTarget(wf: WorkflowDef, targetId: string, facts: Facts, skipped: string[] = []): { stageId: string; skipped: string[] } {
  if (TERMINAL.has(targetId)) return { stageId: targetId, skipped };
  const raw = stageById(wf, targetId);
  if (!raw) throw new Error(`Workflow v${wf.version} has no stage "${targetId}"`);
  const s = effectiveStage(raw, facts);
  if (s.skipWhen && evaluate(s.skipWhen, facts)) {
    const pass = s.outcomes.find((o) => !["decline", "request-info"].includes(o.id)) ?? s.outcomes[0];
    if (!pass) return { stageId: s.id, skipped };
    if (skipped.length > wf.stages.length) throw new Error("Workflow skip loop");
    return resolveTarget(wf, pass.next, facts, [...skipped, s.id]);
  }
  return { stageId: s.id, skipped };
}

export interface TransitionInput {
  wf: WorkflowDef;
  currentStageId: string;
  outcomeId: string;
  actor: Actor;
  facts: Facts;
  checks?: CheckResult[];
  reason?: string;
}

export interface TransitionResult {
  from: string;
  to: string;
  outcome: OutcomeDef;
  status: RequestStatus;
  skipped: string[];
}

export class TransitionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

export function transition(t: TransitionInput): TransitionResult {
  const raw = stageById(t.wf, t.currentStageId);
  if (!raw) throw new TransitionError("no-stage", `Unknown stage ${t.currentStageId}`);
  const stage = effectiveStage(raw, t.facts);
  const outcome = stage.outcomes.find((o) => o.id === t.outcomeId);
  if (!outcome) throw new TransitionError("no-outcome", `"${t.outcomeId}" is not an outcome of ${stage.name}. Options: ${stage.outcomes.map((o) => o.id).join(", ")}.`);

  if (outcome.locked) assertPersonForLockedAction(outcome.locked, t.actor, outcome.actorRoles);
  const systemish = t.actor.type !== "person";
  if (!systemish && !t.actor.roles?.some((r) => outcome.actorRoles.includes(r))) {
    throw new TransitionError("role", `${t.actor.name} cannot choose "${outcome.label}" at ${stage.name}; it needs: ${outcome.actorRoles.join(", ")}.`);
  }
  if (outcome.requiresReason && !t.reason?.trim()) {
    throw new TransitionError("reason", `"${outcome.label}" needs a reason, recorded with your name.`);
  }
  const forward = !["decline", "request-info", "withdraw", "defer"].includes(outcome.id);
  if (forward && stage.requiresPassing?.length && t.checks) {
    const failing = t.checks.filter((c) => stage.requiresPassing!.includes(c.ruleId) && (c.status === "fail" || c.status === "pending") && c.severity === "block");
    if (failing.length) throw new TransitionError("checks", `Cannot leave ${stage.name} while these are open: ${failing.map((c) => c.statement).join("; ")}.`);
  }
  const { stageId, skipped } = resolveTarget(t.wf, outcome.next, t.facts);
  return { from: stage.id, to: stageId, outcome, status: statusFor(stageById(t.wf, stageId), stageId), skipped };
}

export function dueDate(stage: StageDef, enteredAt: string, holidays: string[] = []): string | undefined {
  if (!stage.slaBusinessDays) return undefined;
  const d = toDate(enteredAt);
  return d ? isoDate(addBusinessDays(d, stage.slaBusinessDays, holidays)) : undefined;
}

export interface WorkflowIssue {
  severity: "error" | "warning";
  stage?: string;
  message: string;
}

/** Soundness checks run before a workflow version can be signed. */
export function validateWorkflow(wf: WorkflowDef): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const ids = new Set(wf.stages.map((s) => s.id));
  if (!wf.stages.length) return [{ severity: "error", message: "The workflow has no stages." }];
  const first = [...wf.stages].sort((a, b) => a.order - b.order)[0]!;
  // targets exist
  for (const s of wf.stages) {
    if (!s.outcomes.length) issues.push({ severity: "error", stage: s.id, message: `${s.name} has no outcomes, so a request would stop there.` });
    for (const o of s.outcomes) {
      if (!ids.has(o.next) && !TERMINAL.has(o.next)) issues.push({ severity: "error", stage: s.id, message: `Outcome "${o.label}" goes to "${o.next}", which does not exist.` });
      if (o.locked && !o.actorRoles.length) issues.push({ severity: "error", stage: s.id, message: `"${o.label}" is a locked action but names no person role.` });
    }
    if (onlyLockedForward(s) && s.assistant.maxLevel > MAX_LEVEL_AT_LOCKED_STAGE) issues.push({ severity: "error", stage: s.id, message: `${s.name} exists for a person-only decision (funding or payment release); the assistant's maximum level there is ${MAX_LEVEL_AT_LOCKED_STAGE} (Recommend).` });
    if (s.assistant.level > s.assistant.maxLevel) issues.push({ severity: "error", stage: s.id, message: `${s.name}: assistant level ${s.assistant.level} exceeds its maximum ${s.assistant.maxLevel}.` });
    if (!s.sopRefs.length) issues.push({ severity: "warning", stage: s.id, message: `${s.name} is not tied to any SOP clause.` });
  }
  // reachability
  const seen = new Set<string>([first.id]);
  const queue = [first.id];
  while (queue.length) {
    const s = stageById(wf, queue.shift()!)!;
    for (const o of s.outcomes) if (ids.has(o.next) && !seen.has(o.next)) { seen.add(o.next); queue.push(o.next); }
  }
  for (const s of wf.stages) if (!seen.has(s.id)) issues.push({ severity: "error", stage: s.id, message: `${s.name} cannot be reached from ${first.name}.` });
  // a path to a terminal outcome
  const reachesEnd = wf.stages.some((s) => s.outcomes.some((o) => o.next === "closed"));
  if (!reachesEnd) issues.push({ severity: "error", message: "No outcome closes a request." });
  // locked funding decision present
  if (!wf.stages.some((s) => s.outcomes.some((o) => o.locked === "decide-funding"))) issues.push({ severity: "error", message: "No stage records the funding decision as a locked, person-only action." });
  return issues;
}

export { GateError };

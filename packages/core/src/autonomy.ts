import type { AutonomyLevel, AutonomyPolicy, StageDef, WorkflowDef } from "./types.ts";
import { evaluate, type Facts } from "./conditions.ts";
import { MAX_LEVEL_AT_LOCKED_STAGE } from "./gates.ts";

const BACKWARD = new Set(["decline", "request-info", "withdraw", "defer", "return"]);

/**
 * A stage whose every way forward is a locked action (committee decision, payment release) is capped at Recommend:
 * the assistant can prepare, never proceed. A stage with locked and unlocked outcomes (agreement: draft and send,
 * then a person signs) keeps its level; the locked outcome itself still requires a named person.
 */
export function onlyLockedForward(stage: StageDef): boolean {
  const forward = stage.outcomes.filter((o) => !BACKWARD.has(o.id));
  return forward.length > 0 && forward.every((o) => o.locked);
}

/** Effective assistant level at a stage: workflow default, then policy overrides, capped by the stage max and the locked-stage cap. */
export function effectiveLevel(stage: StageDef, policy: AutonomyPolicy | undefined, facts: Facts): AutonomyLevel {
  let level: AutonomyLevel = stage.assistant.level;
  if (policy?.profile === "cautious") level = Math.min(level, 2) as AutonomyLevel;
  for (const o of policy?.overrides ?? []) {
    if (o.stage === stage.id && evaluate(o.when, facts)) level = o.level;
  }
  const cap = Math.min(stage.assistant.maxLevel, onlyLockedForward(stage) ? MAX_LEVEL_AT_LOCKED_STAGE : 4) as AutonomyLevel;
  return Math.min(level, cap) as AutonomyLevel;
}

export type AssistantMode = "off" | "observe" | "recommend" | "act-confirm" | "act";

export function modeFor(level: AutonomyLevel): AssistantMode {
  return (["off", "observe", "recommend", "act-confirm", "act"] as const)[level];
}

/**
 * Decide what happens to an assistant proposal at a stage.
 * - applied: the assistant may apply it now (level 4, within the rulebook, reversible)
 * - held-for-person: it is queued for a person to confirm (level 3) or decide (level 2)
 * - dropped: assistant is off or observing at this stage
 * Confidence below the floor always holds for a person and is shown as "no recommendation".
 */
export function gateProposal(level: AutonomyLevel, opts: { confidence?: number; floor?: number; reversible?: boolean }): "applied" | "held-for-person" | "proposed" | "dropped" {
  if (level <= 1) return "dropped";
  if (opts.confidence !== undefined && opts.floor !== undefined && opts.confidence < opts.floor) return "held-for-person";
  if (level === 4 && opts.reversible !== false) return "applied";
  if (level >= 3) return "held-for-person";
  return "proposed";
}

/** What the dial would have done over a history of past proposals: the "consequence preview" in Studio. */
export function consequencePreview(history: { stage: string; confidence: number; reversible: boolean }[], stage: string, level: AutonomyLevel, floor: number) {
  const rows = history.filter((h) => h.stage === stage);
  const applied = rows.filter((h) => gateProposal(level, { confidence: h.confidence, floor, reversible: h.reversible }) === "applied").length;
  return { total: rows.length, applied, heldForPerson: rows.length - applied, appliedPct: rows.length ? applied / rows.length : 0 };
}

export function stageLevels(wf: WorkflowDef, policy: AutonomyPolicy | undefined, facts: Facts): Record<string, AutonomyLevel> {
  return Object.fromEntries(wf.stages.map((s) => [s.id, effectiveLevel(s, policy, facts)]));
}

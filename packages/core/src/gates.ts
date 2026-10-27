// The platform's fixed rules. Tenants configure everything else; they cannot change these.
// G1–G6 are the six global gates from the design concept. LOCKED_ACTIONS are the five
// outcomes that always require a named person, whatever the autonomy dial says.

import type { Actor, AutonomyLevel, LockedAction, Role } from "./types.ts";

export const LOCKED_ACTIONS: Record<LockedAction, { label: string; roles: Role[] }> = {
  "decide-funding": { label: "Decide funding", roles: ["committee-member", "committee-chair"] },
  attest: { label: "Make an attestation", roles: ["requestor", "org-admin"] },
  "sign-agreement": { label: "Sign an agreement", roles: ["requestor", "org-admin", "legal"] },
  "release-payment": { label: "Release a payment", roles: ["finance"] },
  "submit-disclosure": { label: "Submit a disclosure", roles: ["compliance-auditor", "process-owner", "finance"] },
};

/** The highest autonomy level the assistant may have at a stage that contains a locked action. */
export const MAX_LEVEL_AT_LOCKED_STAGE: AutonomyLevel = 2;

export class GateError extends Error {
  constructor(public readonly gate: string, message: string) {
    super(message);
    this.name = "GateError";
  }
}

/** Throws unless a named person holding an allowed role performs a locked action. */
export function assertPersonForLockedAction(action: LockedAction, actor: Actor, allowedRoles?: Role[]): void {
  if (actor.type !== "person") {
    throw new GateError("locked-action", `${LOCKED_ACTIONS[action].label} must be done by a named person, not by ${actor.type} "${actor.name}".`);
  }
  const roles = allowedRoles ?? LOCKED_ACTIONS[action].roles;
  if (!actor.roles?.some((r) => roles.includes(r))) {
    throw new GateError("locked-action", `${actor.name} cannot ${LOCKED_ACTIONS[action].label.toLowerCase()}; it needs one of: ${roles.join(", ")}.`);
  }
}

// ─── G2: decisions separate from sales ───────────────────────────────────────

/** Roles that may never create, score, approve or see the status of a funding request. */
export const COMMERCIAL_ROLES: Role[] = ["sales"];

export function assertNotCommercial(actor: Actor, what = "see funding requests"): void {
  if (actor.roles?.some((r) => COMMERCIAL_ROLES.includes(r))) {
    throw new GateError("G2", `Sales and marketing roles cannot ${what}. Grant decisions are kept separate from commercial functions (OIG 2003 guidance; PhRMA and AdvaMed codes).`);
  }
}

// ─── Separation of duties ────────────────────────────────────────────────────

export interface DutyHistory {
  routedBy?: string; // person id who routed/accepted the request into review
  decidedBy?: string[]; // committee members who voted
  requestedBy?: string; // requestor person id
}

/** The person who routed a request cannot release its payment; a requestor cannot review or decide their own request. */
export function assertSeparationOfDuties(action: "release-payment" | "decide-funding" | "review", actor: Actor, h: DutyHistory): void {
  if (action === "release-payment" && h.routedBy && h.routedBy === actor.id) {
    throw new GateError("SoD", "The person who routed this request cannot also release its payment.");
  }
  if ((action === "decide-funding" || action === "review") && h.requestedBy && h.requestedBy === actor.id) {
    throw new GateError("SoD", "A requestor cannot review or decide their own request.");
  }
}

// ─── G1, G3–G6 are expressed as locked rules in content/packs/core.json and evaluated by
// the rule engine; the ids below are reserved so tenants cannot disable them. ──────────
export const CORE_RULE_PREFIX = "CORE-";
export function isCoreRule(id: string): boolean {
  return id.startsWith(CORE_RULE_PREFIX);
}

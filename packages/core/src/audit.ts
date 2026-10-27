import { createHash } from "node:crypto";
import type { AuditEvent, AuditEventInput } from "./types.ts";

export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) o[k] = sortKeys(x);
    }
    return o;
  }
  return v;
}

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** The material hashed for an event: everything except the hash itself. */
export function eventMaterial(e: Omit<AuditEvent, "hash">): string {
  return canonicalJson({
    tenantId: e.tenantId, seq: e.seq, id: e.id, at: e.at, actor: e.actor, entity: e.entity,
    action: e.action, data: e.data ?? {}, ai: e.ai ?? null, prevHash: e.prevHash,
  });
}

export function hashEvent(e: Omit<AuditEvent, "hash">): string {
  return sha256(e.prevHash + eventMaterial(e));
}

export function sealEvent(input: AuditEventInput, seq: number, id: string, at: string, prevHash: string): AuditEvent {
  const base = { ...input, seq, id, at, prevHash, data: input.data ?? {} };
  return { ...base, hash: hashEvent(base) };
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  head?: string;
  firstBreak?: { seq: number; reason: string };
}

/** Walk events in seq order and recompute every hash and link. */
export function verifyChain(events: AuditEvent[], startPrev = GENESIS_HASH): ChainVerification {
  let prev = startPrev;
  let expectedSeq = events[0]?.seq ?? 1;
  for (const e of events) {
    if (e.seq !== expectedSeq) return { ok: false, checked: e.seq - 1, firstBreak: { seq: e.seq, reason: `sequence gap: expected ${expectedSeq}` } };
    if (e.prevHash !== prev) return { ok: false, checked: e.seq - 1, firstBreak: { seq: e.seq, reason: "link to previous event does not match" } };
    const { hash, ...rest } = e;
    if (hashEvent(rest) !== hash) return { ok: false, checked: e.seq - 1, firstBreak: { seq: e.seq, reason: "event content does not match its hash" } };
    prev = hash;
    expectedSeq++;
  }
  return { ok: true, checked: events.length, head: prev };
}

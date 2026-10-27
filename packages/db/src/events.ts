import { randomUUID } from "node:crypto";
import { GENESIS_HASH, sealEvent, verifyChain, type AuditEvent, type AuditEventInput, type ChainVerification } from "@fe/core";
import { many, one, type Tx } from "./client.ts";

interface EventRow {
  tenant_id: string; seq: number; id: string; at: Date; actor: AuditEvent["actor"]; entity_type: string; entity_id: string;
  action: string; data: Record<string, unknown>; ai: AuditEvent["ai"] | null; prev_hash: string; hash: string;
}

export function rowToEvent(r: EventRow): AuditEvent {
  return {
    tenantId: r.tenant_id, seq: r.seq, id: r.id, at: new Date(r.at).toISOString(), actor: r.actor,
    entity: { type: r.entity_type, id: r.entity_id }, action: r.action, data: r.data, ...(r.ai ? { ai: r.ai } : {}),
    prevHash: r.prev_hash, hash: r.hash,
  };
}

/**
 * Append one event to the tenant's chain inside the caller's transaction.
 * The head row is locked FOR UPDATE, so concurrent appends for one tenant serialize and seq has no gaps.
 */
export async function appendEvent(tx: Tx, input: AuditEventInput): Promise<AuditEvent> {
  let head = await one<{ seq: number; hash: string }>(tx, "select seq, hash from event_heads where tenant_id = $1 for update", [input.tenantId]);
  if (!head) {
    await tx.query("insert into event_heads (tenant_id, seq, hash) values ($1, 0, $2) on conflict do nothing", [input.tenantId, GENESIS_HASH]);
    head = (await one<{ seq: number; hash: string }>(tx, "select seq, hash from event_heads where tenant_id = $1 for update", [input.tenantId]))!;
  }
  const at = new Date().toISOString();
  const ev = sealEvent(input, head.seq + 1, randomUUID(), at, head.hash);
  await tx.query(
    `insert into events (tenant_id, seq, id, at, actor, entity_type, entity_id, action, data, ai, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [ev.tenantId, ev.seq, ev.id, ev.at, ev.actor, ev.entity.type, ev.entity.id, ev.action, ev.data ?? {}, ev.ai ?? null, ev.prevHash, ev.hash],
  );
  await tx.query("update event_heads set seq = $2, hash = $3 where tenant_id = $1", [ev.tenantId, ev.seq, ev.hash]);
  return ev;
}

export async function eventsForEntity(tx: Tx, tenantId: string, type: string, id: string): Promise<AuditEvent[]> {
  return (await many<EventRow>(tx, "select * from events where tenant_id = $1 and entity_type = $2 and entity_id = $3 order by seq", [tenantId, type, id])).map(rowToEvent);
}

/** Events about a request: the request itself plus anything recorded with data.requestId. */
export async function eventsForRequest(tx: Tx, tenantId: string, requestId: string): Promise<AuditEvent[]> {
  return (await many<EventRow>(tx,
    `select * from events where tenant_id = $1 and ((entity_type = 'request' and entity_id = $2) or data->>'requestId' = $2) order by seq`,
    [tenantId, requestId])).map(rowToEvent);
}

export async function verifyTenantChain(tx: Tx, tenantId: string): Promise<ChainVerification> {
  const rows = await many<EventRow>(tx, "select * from events where tenant_id = $1 order by seq", [tenantId]);
  return verifyChain(rows.map(rowToEvent));
}

export async function anchorChain(tx: Tx, tenantId: string): Promise<{ seq: number; hash: string } | undefined> {
  const head = await one<{ seq: number; hash: string }>(tx, "select seq, hash from event_heads where tenant_id = $1", [tenantId]);
  if (!head || head.seq === 0) return undefined;
  await tx.query("insert into chain_anchors (tenant_id, seq, hash) values ($1,$2,$3) on conflict do nothing", [tenantId, head.seq, head.hash]);
  return head;
}

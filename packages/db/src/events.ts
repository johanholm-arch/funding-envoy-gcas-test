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

const queued = new WeakMap<object, AuditEventInput[]>();

/** Called by withContext: events recorded in this transaction are queued and sealed together just before commit. */
export function deferEvents(tx: Tx): void {
  queued.set(tx, []);
}

/**
 * Record an event in the tenant's chain. Inside withContext the event is queued and sealed at commit (see
 * flushEvents), so the tenant's chain head is locked only for the moment it takes to write the batch, not for the
 * whole transaction. Outside a deferred transaction it is sealed immediately.
 */
export async function appendEvent(tx: Tx, input: AuditEventInput): Promise<void> {
  const q = queued.get(tx);
  if (q) { q.push(input); return; }
  await seal(tx, [input]);
}

/** Seal everything queued in this transaction. The head row of each tenant is locked FOR UPDATE, in tenant order, so
 * concurrent commits serialize per tenant, sequences have no gaps, and two-tenant transactions cannot deadlock. */
export async function flushEvents(tx: Tx): Promise<void> {
  const q = queued.get(tx);
  queued.delete(tx);
  if (q?.length) await seal(tx, q);
}

async function seal(tx: Tx, inputs: AuditEventInput[]): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  const tenants = [...new Set(inputs.map((i) => i.tenantId))].sort();
  for (const tenantId of tenants) {
    let head = await one<{ seq: string; hash: string }>(tx, "select seq, hash from event_heads where tenant_id = $1 for update", [tenantId]);
    if (!head) {
      await tx.query("insert into event_heads (tenant_id, seq, hash) values ($1, 0, $2) on conflict do nothing", [tenantId, GENESIS_HASH]);
      head = (await one<{ seq: string; hash: string }>(tx, "select seq, hash from event_heads where tenant_id = $1 for update", [tenantId]))!;
    }
    let seq = Number(head.seq), prev = head.hash;
    const at = new Date().toISOString();
    const evs = inputs.filter((i) => i.tenantId === tenantId).map((input) => {
      const ev = sealEvent(input, ++seq, randomUUID(), at, prev);
      prev = ev.hash;
      return ev;
    });
    await tx.query(
      `insert into events (tenant_id, seq, id, at, actor, entity_type, entity_id, action, data, ai, prev_hash, hash)
       select $1, * from unnest($2::bigint[], $3::uuid[], $4::timestamptz[], $5::jsonb[], $6::text[], $7::text[], $8::text[], $9::jsonb[], $10::jsonb[], $11::text[], $12::text[])`,
      [tenantId, evs.map((e) => e.seq), evs.map((e) => e.id), evs.map((e) => e.at), evs.map((e) => JSON.stringify(e.actor)), evs.map((e) => e.entity.type), evs.map((e) => e.entity.id),
        evs.map((e) => e.action), evs.map((e) => JSON.stringify(e.data ?? {})), evs.map((e) => (e.ai ? JSON.stringify(e.ai) : null)), evs.map((e) => e.prevHash), evs.map((e) => e.hash)],
    );
    await tx.query("update event_heads set seq = $2, hash = $3 where tenant_id = $1", [tenantId, seq, prev]);
    out.push(...evs);
  }
  return out;
}

export async function eventsForEntity(tx: Tx, tenantId: string, type: string, id: string): Promise<AuditEvent[]> {
  return (await many<EventRow>(tx, "select * from events where tenant_id = $1 and entity_type = $2 and entity_id = $3 order by seq", [tenantId, type, id])).map(rowToEvent);
}

/** Events about a request: the request itself plus anything recorded with data.requestId. */
export async function eventsForRequest(tx: Tx, tenantId: string, requestId: string): Promise<AuditEvent[]> {
  return (await many<EventRow>(tx,
    `select * from events where tenant_id = $1 and request_id = $2 order by seq`,
    [tenantId, requestId])).map(rowToEvent);
}

export interface TenantVerification extends ChainVerification {
  mode: "full" | "since-checkpoint";
  from?: { seq: number; at: string; method: string };
}

/**
 * Recompute every hash and link of a tenant's chain, a page at a time so memory stays flat at millions of events.
 * "since-checkpoint" starts from the latest checkpoint (an anchor, or an earlier full verification) after confirming
 * the checkpoint still matches the stored event; "full" starts from the first event and, when the chain is intact,
 * records a new checkpoint at the head.
 */
export async function verifyTenantChain(tx: Tx, tenantId: string, opts: { mode?: "full" | "since-checkpoint"; pageSize?: number } = {}): Promise<TenantVerification> {
  const pageSize = opts.pageSize ?? 20_000;
  let mode = opts.mode ?? "full";
  let prev = GENESIS_HASH, after = 0, from: TenantVerification["from"];
  if (mode === "since-checkpoint") {
    const cp = await one<{ seq: string; hash: string; anchored_at: Date; method: string }>(tx, "select seq, hash, anchored_at, method from chain_anchors where tenant_id = $1 order by seq desc limit 1", [tenantId]);
    if (!cp) mode = "full";
    else {
      const at = await one<{ hash: string }>(tx, "select hash from events where tenant_id = $1 and seq = $2", [tenantId, cp.seq]);
      if (!at || at.hash !== cp.hash) return { ok: false, checked: 0, mode, firstBreak: { seq: Number(cp.seq), reason: "the event at the checkpoint no longer matches the checkpoint" } };
      prev = cp.hash; after = Number(cp.seq);
      from = { seq: after, at: cp.anchored_at.toISOString(), method: cp.method };
    }
  }
  let checked = 0;
  for (;;) {
    const rows = await many<EventRow>(tx, "select * from events where tenant_id = $1 and seq > $2 order by seq limit $3", [tenantId, after, pageSize]);
    if (!rows.length) break;
    const page = rows.map(rowToEvent);
    if (Number(page[0]!.seq) !== after + 1) return { ok: false, checked, mode, from, firstBreak: { seq: Number(page[0]!.seq), reason: `sequence gap: expected ${after + 1}` } };
    const v = verifyChain(page.map((e) => ({ ...e, seq: Number(e.seq) })), prev);
    if (!v.ok) return { ...v, checked: checked + Math.max(0, (v.firstBreak?.seq ?? after) - after - 1), mode, from };
    checked += page.length; prev = v.head!; after = Number(page.at(-1)!.seq);
    if (rows.length < pageSize) break;
  }
  if (mode === "full" && checked > 0) {
    await tx.query("insert into chain_anchors (tenant_id, seq, hash, method) values ($1,$2,$3,'verified-checkpoint') on conflict do nothing", [tenantId, after, prev]);
  }
  return { ok: true, checked, head: prev, mode, from };
}

export async function anchorChain(tx: Tx, tenantId: string): Promise<{ seq: number; hash: string } | undefined> {
  const head = await one<{ seq: number; hash: string }>(tx, "select seq, hash from event_heads where tenant_id = $1", [tenantId]);
  if (!head || head.seq === 0) return undefined;
  await tx.query("insert into chain_anchors (tenant_id, seq, hash) values ($1,$2,$3) on conflict do nothing", [tenantId, head.seq, head.hash]);
  return head;
}

// Loads a tenant's configuration versions and composes the effective rulebook.
// Published versions are immutable, so (tenant, kind, version) is safe to cache forever.
import type { AutonomyPolicy, Catalogue, Pack, Rulebook, WorkflowDef } from "@fe/core";
import { composeRulebook, type ComposedRulebook } from "@fe/core";
import { many, one, type Tx } from "@fe/db";
import { parseClauses, type Clause } from "@fe/agent";

export type ConfigKind = "rulebook" | "workflow" | "catalogue" | "autonomy" | "brand" | "words" | "policy" | "sop" | "metrics";

const cache = new Map<string, unknown>();

export async function configVersion<T>(tx: Tx, tenantId: string, kind: ConfigKind, version?: number): Promise<{ version: number; body: T; signedName?: string; signedAt?: string } | undefined> {
  if (version !== undefined) {
    const key = `${tenantId}:${kind}:${version}`;
    if (cache.has(key)) return cache.get(key) as { version: number; body: T };
    const row = await one<{ version: number; body: T; signed_name: string | null; signed_at: Date | null; status: string }>(tx,
      "select version, body, signed_name, signed_at, status from config_versions where tenant_id = $1 and kind = $2 and version = $3", [tenantId, kind, version]);
    if (!row) return undefined;
    const v = { version: row.version, body: row.body, signedName: row.signed_name ?? undefined, signedAt: row.signed_at?.toISOString() };
    if (row.status !== "draft") cache.set(key, v);
    return v;
  }
  const row = await one<{ version: number }>(tx, "select version from config_versions where tenant_id = $1 and kind = $2 and status = 'published'", [tenantId, kind]);
  return row ? configVersion<T>(tx, tenantId, kind, row.version) : undefined;
}

export async function loadPacks(tx: Tx): Promise<Pack[]> {
  const key = "packs:all";
  if (cache.has(key)) return cache.get(key) as Pack[];
  const rows = await many<{ body: Pack }>(tx, "select distinct on (id) body from packs order by id, version desc");
  const packs = rows.map((r) => r.body);
  cache.set(key, packs);
  return packs;
}

export function invalidateConfigCache(): void {
  cache.clear();
}

export interface TenantConfig {
  catalogue: Catalogue;
  rulebook: ComposedRulebook;
  rulebookRaw: Rulebook;
  workflow: WorkflowDef;
  autonomy?: AutonomyPolicy;
  packs: Pack[];
  clauses: Clause[];
  versions: { rulebook: number; workflow: number; catalogue: number; packs: Record<string, number> };
}

export async function tenantConfig(tx: Tx, tenantId: string, pinned?: { rulebook?: number; workflow?: number; catalogue?: number }): Promise<TenantConfig> {
  const [cat, rb, wf, au, pol, sop] = await Promise.all([
    configVersion<Catalogue>(tx, tenantId, "catalogue", pinned?.catalogue),
    configVersion<Rulebook>(tx, tenantId, "rulebook", pinned?.rulebook),
    configVersion<WorkflowDef>(tx, tenantId, "workflow", pinned?.workflow),
    configVersion<AutonomyPolicy>(tx, tenantId, "autonomy"),
    configVersion<{ markdown: string; title: string }>(tx, tenantId, "policy"),
    configVersion<{ markdown: string; title: string }>(tx, tenantId, "sop"),
  ]);
  if (!cat || !rb || !wf) throw new Error("This tenant has no published catalogue, rulebook or workflow yet.");
  const packs = await loadPacks(tx);
  const rulebook = composeRulebook(rb.body, packs);
  const clauses = [
    ...(pol ? parseClauses(pol.body.markdown, "Policy", pol.body.title) : []),
    ...(sop ? parseClauses(sop.body.markdown, "SOP", sop.body.title) : []),
  ];
  return {
    catalogue: cat.body, rulebook, rulebookRaw: rb.body, workflow: wf.body, autonomy: au?.body, packs, clauses,
    versions: { rulebook: rb.version, workflow: wf.version, catalogue: cat.version, packs: Object.fromEntries(rulebook.packs.map((p) => [p.id, p.version])) },
  };
}

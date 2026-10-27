import type { Pack, Rule, Rulebook } from "./types.ts";
import { isCoreRule } from "./gates.ts";

export interface ComposedRulebook {
  version: number;
  rules: Rule[];
  parameters: Record<string, unknown>;
  packs: { id: string; version: number; verification: Pack["verification"]["status"] }[];
  disabled: string[];
  warnings: string[];
}

/**
 * Compose the effective rule set: pack rules in pack order, then tenant rules.
 * A tenant rule with the same id as a pack rule replaces it (and is reported), except locked core rules.
 * Tenant-disabled ids are removed, except locked/core rules.
 * Parameters: pack parameters (by key, verified or not) then tenant parameters override.
 */
export function composeRulebook(tenant: Rulebook, packs: Pack[]): ComposedRulebook {
  const warnings: string[] = [];
  const byId = new Map<string, Rule>();
  const order: string[] = [];
  const parameters: Record<string, unknown> = {};
  const selected = tenant.packs.map((p) => {
    const pack = packs.find((x) => x.id === p.id);
    if (!pack) warnings.push(`Pack "${p.id}" v${p.version} is referenced but not loaded.`);
    else if (pack.version !== p.version) warnings.push(`Pack "${p.id}" is loaded at v${pack.version}; the rulebook pins v${p.version}.`);
    return pack;
  }).filter((p): p is Pack => Boolean(p));

  for (const pack of selected) {
    for (const prm of pack.parameters) {
      const short = prm.key;
      parameters[short] = prm.value;
    }
    for (const r of pack.rules) {
      if (byId.has(r.id)) warnings.push(`Rule ${r.id} appears in more than one pack; the later pack (${pack.id}) wins.`);
      else order.push(r.id);
      byId.set(r.id, { ...r, source: r.source ?? (`pack:${pack.id}` as const) });
    }
  }
  for (const r of tenant.rules) {
    const existing = byId.get(r.id);
    if (existing && (existing.locked || isCoreRule(existing.id))) {
      warnings.push(`Tenant rule ${r.id} tries to replace a locked platform rule and was ignored.`);
      continue;
    }
    if (existing) warnings.push(`Tenant rule ${r.id} replaces the ${existing.source} version.`);
    else order.push(r.id);
    byId.set(r.id, { ...r, source: "tenant" });
  }
  const disabled = (tenant.disabled ?? []).filter((id) => {
    const r = byId.get(id);
    if (r && (r.locked || isCoreRule(id))) { warnings.push(`Rule ${id} is locked by the platform and cannot be disabled.`); return false; }
    return true;
  });
  Object.assign(parameters, tenant.parameters ?? {});
  const rules = order.map((id) => byId.get(id)!).filter((r) => !disabled.includes(r.id));
  return {
    version: tenant.version,
    rules,
    parameters,
    packs: selected.map((p) => ({ id: p.id, version: p.version, verification: p.verification.status })),
    disabled,
    warnings,
  };
}

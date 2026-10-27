// Screening of requesting organizations against exclusion, sanctions, tax-status and PEP lists.
// Runs at intake, at submission and before payment. In the demo environment the lists are simulated:
// each organization keeps the result recorded in its passport, re-dated to the run. Production replaces
// `screenOne` with live list providers (OIG LEIE, SAM.gov, OFAC SDN, UK OFSI, EU CFSP, IRS TEOS, PEP).
import type { Actor, Organization, ScreeningResult } from "@fe/core";
import { one, type Tx } from "@fe/db";
import { record, today } from "./requests.ts";

const LISTS_BY_COUNTRY: Record<string, string[]> = {
  US: ["LEIE", "SAM", "OFAC-SDN", "IRS-TEOS"],
  GB: ["OFAC-SDN", "UK-OFSI", "PEP"],
  FR: ["OFAC-SDN", "EU-CFSP", "PEP"],
};

export const SCREENING_ACTOR: Actor = { type: "system", id: "screening", name: "Screening service (simulated lists)" };

function screenOne(org: Organization, list: string, when: string): ScreeningResult {
  const prior = org.screening.filter((s) => s.list === list).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  return {
    list, listVersion: when.slice(0, 7), checkedAt: `${when}T08:00:00Z`,
    result: prior?.result ?? "clear", ...(prior?.score !== undefined ? { score: prior.score } : {}), ...(prior?.adjudication ? { adjudication: prior.adjudication } : {}),
  };
}

/** Re-run screening for an organization, store the results on its passport and record the run. */
export async function rescreen(tx: Tx, tenantId: string, orgId: string, reason: "intake" | "submission" | "pre-payment" | "recurring", requestId?: string): Promise<ScreeningResult[]> {
  const row = await one<{ data: Organization; country: string }>(tx, "select data, country from organizations where id = $1", [orgId]);
  if (!row) return [];
  const org = { ...row.data, screening: row.data.screening ?? [] } as Organization;
  const when = today();
  const lists = [...new Set([...(LISTS_BY_COUNTRY[row.country] ?? ["OFAC-SDN", "PEP"]), ...org.screening.map((s) => s.list)])];
  const fresh = lists.map((l) => screenOne(org, l, when));
  const kept = org.screening.filter((s) => !lists.includes(s.list));
  await tx.query("update organizations set data = jsonb_set(data, '{screening}', $2::jsonb), updated_at = now() where id = $1", [orgId, JSON.stringify([...kept, ...fresh])]);
  await record(tx, {
    tenantId, actor: SCREENING_ACTOR, entity: { type: "organization", id: orgId }, action: "screening.run",
    data: { requestId, reason, lists: fresh.map((s) => ({ list: s.list, version: s.listVersion, result: s.result })), simulated: true },
  });
  return fresh;
}

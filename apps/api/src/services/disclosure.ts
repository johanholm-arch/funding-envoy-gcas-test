// Disclosure readiness, files and the regulatory calendar, generated from the packs the tenant has adopted.
import type { CalendarEntry, DisclosureRegime } from "@fe/core";
import { assertPersonForLockedAction, formatMoney } from "@fe/core";
import { many } from "@fe/db";
import { actorOf, asUser, HttpError, type SessionUser } from "../auth.ts";
import { tenantConfig } from "../config.ts";
import { record, today } from "./requests.ts";

interface TovRow { id: string; regime: string; category: string; recipient: { name: string; type: string; country: string; identifiers: Record<string, string>; address?: string }; amount: number; currency: string; period: string; state: string; data: { ref?: string; title?: string }; created_at: Date }

/** Identifiers each regime needs to publish a record about an organization. */
const REQUIRED_IDS: Record<string, { any: string[]; label: string }> = {
  "open-payments": { any: ["ein", "ccn", "npi"], label: "tax identifier or CMS certification number" },
  "efpia-hco": { any: ["charityNumber", "companyNumber", "siren", "ein", "registrationNumber"], label: "registration number" },
  "disclosure-uk": { any: ["charityNumber", "companyNumber", "odsCode", "registrationNumber"], label: "charity or company number" },
  "transparence-sante": { any: ["siren", "siret", "rna", "finess"], label: "SIREN, SIRET, RNA or FINESS" },
};

export function nextOccurrence(rule: string, from = today()): string | undefined {
  const [kind, spec] = rule.split(":");
  if (!spec) return undefined;
  if (kind === "once") return spec >= from ? spec : undefined;
  const dates = spec.split(",").map((md) => md.trim());
  const year = Number(from.slice(0, 4));
  const candidates = [year, year + 1].flatMap((y) => dates.map((md) => `${y}-${md}`)).filter((d) => d >= from).sort();
  return candidates[0];
}

async function regimes(u: SessionUser): Promise<{ regimes: DisclosureRegime[]; calendar: (CalendarEntry & { pack: string })[] }> {
  return asUser(u, async (tx) => {
    const cfg = await tenantConfig(tx, u.tenantId!);
    const selected = new Set(cfg.rulebookRaw.packs.map((p) => p.id));
    const packs = cfg.packs.filter((p) => selected.has(p.id));
    return { regimes: packs.flatMap((p) => p.disclosures), calendar: packs.flatMap((p) => p.calendar.map((c) => ({ ...c, pack: p.id }))) };
  });
}

export async function calendar(u: SessionUser) {
  const { calendar } = await regimes(u);
  return calendar.map((c) => ({ id: c.id, label: c.label, pack: c.pack, next: nextOccurrence(c.rule), rule: c.rule, basis: c.basis }))
    .filter((c) => c.next).sort((a, b) => a.next!.localeCompare(b.next!));
}

export async function readiness(u: SessionUser) {
  const { regimes: rs, calendar: cal } = await regimes(u);
  const rows = await asUser(u, (tx) => many<TovRow>(tx, "select * from transfers_of_value where tenant_id = $1 order by created_at", [u.tenantId]));
  return rs.map((r) => {
    const mine = rows.filter((x) => x.regime === r.id);
    const req = REQUIRED_IDS[r.id];
    const unmatched = req ? mine.filter((x) => !req.any.some((k) => x.recipient.identifiers?.[k])) : [];
    const periods = [...new Set(mine.map((x) => x.period))].sort();
    const due = cal.filter((c) => c.regime === r.id || c.id.startsWith(r.id.split("-")[0]!)).map((c) => nextOccurrence(c.rule)).filter(Boolean).sort()[0];
    return {
      id: r.id, name: r.name, deadline: r.deadline, nextDue: due, periods,
      records: mine.length, total: mine.reduce((s, x) => s + x.amount, 0), currency: mine[0]?.currency,
      totalLabel: mine.length ? formatMoney(mine.reduce((s, x) => s + x.amount, 0), mine[0]!.currency) : "—",
      unmatched: unmatched.map((x) => ({ id: x.id, recipient: x.recipient.name, needs: req!.label, ref: x.data.ref })),
      submitted: mine.filter((x) => x.state === "submitted").length,
      status: !mine.length ? "nothing-to-report" : unmatched.length ? "needs-attention" : mine.every((x) => x.state === "submitted") ? "submitted" : "ready",
    };
  });
}

function csv(rows: (string | number | undefined)[][]): string {
  return rows.map((r) => r.map((v) => { const s = v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
}

/** A disclosure file in the regime's column order. Formats follow each regime's published template; field lists are marked for verification in content/packs/VERIFICATION.md. */
export async function disclosureFile(u: SessionUser, regime: string, period: string): Promise<{ filename: string; body: string }> {
  const rows = await asUser(u, (tx) => many<TovRow>(tx, "select * from transfers_of_value where tenant_id = $1 and regime = $2 and period like $3 order by created_at", [u.tenantId, regime, `${period}%`]));
  if (!rows.length) throw new HttpError(404, "Nothing to disclose for that regime and period.");
  const head: Record<string, string[]> = {
    "open-payments": ["Record_ID", "Covered_Recipient_Type", "Teaching_Hospital_Name", "Teaching_Hospital_TIN", "Recipient_State", "Total_Amount_of_Payment_USDollars", "Date_of_Payment", "Form_of_Payment", "Nature_of_Payment", "Program_Year"],
    "efpia-hco": ["HCO name", "Country of principal practice", "Principal practice address", "Unique country identifier", "Donations and grants to HCOs", "Contribution to costs of events", "Fee for service and consultancy", "Total", "Year"],
    "disclosure-uk": ["Recipient name", "Address", "Charity or company number", "Donations and grants", "Contribution to costs of events", "Fee for service and consultancy", "Total", "Year"],
    "transparence-sante": ["Type de bénéficiaire", "Dénomination", "Identifiant (SIREN/RNA/FINESS)", "Pays", "Type de lien", "Montant TTC", "Date", "Objet", "Semestre"],
  };
  const body: (string | number | undefined)[][] = [head[regime] ?? ["Recipient", "Category", "Amount", "Currency", "Period"]];
  for (const r of rows) {
    const id = Object.values(r.recipient.identifiers ?? {})[0];
    if (regime === "open-payments") body.push([r.id, "Covered Recipient Teaching Hospital", r.recipient.name, r.recipient.identifiers.ein ?? r.recipient.identifiers.ccn, r.recipient.address?.match(/,\s*([A-Z]{2})\s+\d{5}/)?.[1], r.amount, r.created_at.toISOString().slice(0, 10), "Cash or cash equivalent", r.category === "charitable-contribution" ? "Charitable contribution" : "Grant", r.period]);
    else if (regime === "efpia-hco") body.push([r.recipient.name, r.recipient.country, r.recipient.address, id, r.amount, 0, 0, r.amount, r.period]);
    else if (regime === "disclosure-uk") body.push([r.recipient.name, r.recipient.address, id, r.amount, 0, 0, r.amount, r.period]);
    else if (regime === "transparence-sante") body.push(["Personne morale", r.recipient.name, id, r.recipient.country, "Convention", r.amount, r.created_at.toISOString().slice(0, 10), r.data.title, r.period]);
    else body.push([r.recipient.name, r.category, r.amount, r.currency, r.period]);
  }
  return { filename: `${regime}-${period}.csv`, body: csv(body) };
}

export async function submitDisclosure(u: SessionUser, regime: string, period: string) {
  try { assertPersonForLockedAction("submit-disclosure", actorOf(u)); } catch (e) { throw new HttpError(403, (e as Error).message, "gate"); }
  const ready = (await readiness(u)).find((r) => r.id === regime);
  if (!ready) throw new HttpError(404, "Unknown regime for this tenant.");
  if (ready.unmatched.length) throw new HttpError(409, `${ready.unmatched.length} recipient(s) still need a ${ready.unmatched[0]!.needs}.`);
  return asUser(u, async (tx) => {
    const r = await tx.query("update transfers_of_value set state = 'submitted' where tenant_id = $1 and regime = $2 and period like $3 and state in ('recorded','in-file')", [u.tenantId, regime, `${period}%`]);
    await record(tx, { tenantId: u.tenantId!, actor: actorOf(u), entity: { type: "disclosure", id: `${regime}:${period}` }, action: "disclosure.submitted", data: { regime, period, records: r.rowCount, meaning: "I confirm this file is complete and accurate for submission." } });
    return { submitted: r.rowCount };
  });
}

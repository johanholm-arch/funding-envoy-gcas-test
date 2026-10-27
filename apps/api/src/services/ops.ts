// The managed-service operator's seat: every tenant at a glance, one queue across tenants, the rule library
// with adoption per tenant, and passports. Operators switch into a tenant explicitly; every switch is recorded
// in the trail of the tenant entered and the tenant left.
import { many, one, withContext } from "@fe/db";
import { actorOf, HttpError, type SessionUser } from "../auth.ts";
import { configVersion } from "../config.ts";
import { record } from "./requests.ts";
import { nextOccurrence } from "./disclosure.ts";
import type { Pack, Rulebook, AutonomyPolicy } from "@fe/core";

function requireOperator(u: SessionUser) {
  if (u.kind !== "operator") throw new HttpError(403, "Operations is for the managed-service team.");
}

export async function fleet(u: SessionUser) {
  requireOperator(u);
  return withContext({ operator: true }, async (tx) => {
    const tenants = await many<{ id: string; slug: string; name: string; region: string; residency: string; settings: { brand?: { color?: string } } }>(tx, "select id, slug, name, region, residency, settings from tenants where exists (select 1 from config_versions c where c.tenant_id = tenants.id and c.kind = 'catalogue' and c.status = 'published') order by name");
    const packs = await many<{ body: Pack }>(tx, "select distinct on (id) body from packs order by id, version desc");
    const out = [];
    for (const t of tenants) {
      const stats = await one<{ open: number; needs: number; late: number }>(tx, `
        select (select count(*)::int from requests where tenant_id = $1 and status not in ('draft','closed','declined','withdrawn')) as open,
               (select count(*)::int from tasks where tenant_id = $1 and status = 'open' and assignee_role <> 'requestor') as needs,
               (select count(*)::int from tasks where tenant_id = $1 and status = 'open' and due_at < now()) as late`, [t.id]);
      const rb = await configVersion<Rulebook>(tx, t.id, "rulebook");
      const au = await configVersion<AutonomyPolicy>(tx, t.id, "autonomy");
      const draft = await one<{ version: number }>(tx, "select version from config_versions where tenant_id = $1 and kind = 'rulebook' and status = 'draft'", [t.id]);
      const adopted = new Set((rb?.body.packs ?? []).map((p) => p.id));
      const tPacks = packs.map((p) => p.body).filter((p) => adopted.has(p.id));
      const next = tPacks.flatMap((p) => p.calendar.map((c) => ({ label: c.label, date: nextOccurrence(c.rule) }))).filter((c) => c.date).sort((a, b) => a.date!.localeCompare(b.date!))[0];
      out.push({
        id: t.id, slug: t.slug, name: t.name, color: t.settings.brand?.color, region: t.region, residency: t.residency,
        open: stats?.open ?? 0, needsPerson: stats?.needs ?? 0, pastSla: stats?.late ?? 0,
        assistantProfile: au?.body.profile ?? "standard", rulebook: { version: rb?.version, draft: draft?.version },
        packs: tPacks.map((p) => ({ id: p.id, version: p.version, verification: p.verification.status })),
        nextDeadline: next,
      });
    }
    return out;
  });
}

export async function crossQueue(u: SessionUser) {
  requireOperator(u);
  return withContext({ operator: true }, (tx) => many<{ tenant: string; slug: string; request_id: string | null; ref: string | null; title: string; kind: string; assignee_role: string | null; due_at: Date | null }>(tx, `
    select t.name as tenant, t.slug, k.request_id, r.ref, k.title, k.kind, k.assignee_role, k.due_at from tasks k join tenants t on t.id = k.tenant_id left join requests r on r.id = k.request_id
    where k.status = 'open' and coalesce(k.assignee_role, '') <> 'requestor' order by k.due_at nulls last, k.created_at limit 200`));
}

export async function ruleLibrary(u: SessionUser) {
  requireOperator(u);
  return withContext({ operator: true }, async (tx) => {
    const packs = await many<{ id: string; version: number; body: Pack; verification: string; loaded_at: Date }>(tx, "select id, version, body, verification, loaded_at from packs order by id, version desc");
    const tenants = await many<{ id: string; name: string }>(tx, "select id, name from tenants where exists (select 1 from config_versions c where c.tenant_id = tenants.id) order by name");
    const adoption: Record<string, { tenant: string; version: number }[]> = {};
    for (const t of tenants) {
      const rb = await configVersion<Rulebook>(tx, t.id, "rulebook");
      for (const p of rb?.body.packs ?? []) (adoption[p.id] ??= []).push({ tenant: t.name, version: p.version });
    }
    return packs.map((p) => ({
      id: p.id, version: p.version, name: p.body.name, jurisdiction: p.body.jurisdiction, effectiveFrom: p.body.effectiveFrom,
      verification: p.verification, verificationNotes: p.body.verification.notes, rules: p.body.rules.length, parameters: p.body.parameters.length,
      unverifiedParameters: p.body.parameters.filter((x) => !x.verified).map((x) => x.label), adoptedBy: adoption[p.id] ?? [], loadedAt: p.loaded_at,
    }));
  });
}

export async function passports(u: SessionUser) {
  requireOperator(u);
  return withContext({ operator: true }, async (tx) => {
    const r = await one<{ orgs: number; multi: number; docs: number; reused: number }>(tx, `
      select (select count(*)::int from organizations) as orgs,
             (select count(*)::int from (select org_id from org_shares group by org_id having count(*) > 1) x) as multi,
             (select count(*)::int from documents where tenant_id is null) as docs,
             (select count(*)::int from documents d where d.request_id is not null and exists (select 1 from documents p where p.tenant_id is null and p.org_id = d.org_id and p.sha256 = d.sha256)) as reused`);
    const top = await many<{ name: string; funders: number; country: string }>(tx, "select o.legal_name as name, o.country, count(s.tenant_id)::int as funders from organizations o join org_shares s on s.org_id = o.id group by o.id order by funders desc, name limit 20");
    return { organizations: r?.orgs ?? 0, sharedWithSeveralFunders: r?.multi ?? 0, passportDocuments: r?.docs ?? 0, documentsReused: r?.reused ?? 0, organizationsList: top };
  });
}

export async function switchTenant(u: SessionUser, tenantId: string | null) {
  requireOperator(u);
  await withContext({ operator: true }, async (tx) => {
    if (tenantId) {
      const t = await one<{ id: string }>(tx, "select id from tenants where id = $1", [tenantId]);
      if (!t) throw new HttpError(404, "No such tenant.");
    }
    const actor = { type: "person" as const, id: u.id, name: u.name, roles: u.roles };
    if (u.tenantId) await record(tx, { tenantId: u.tenantId, actor, entity: { type: "operator-session", id: u.sessionId }, action: "operator.switched-out", data: { to: tenantId } });
    if (tenantId) await record(tx, { tenantId, actor, entity: { type: "operator-session", id: u.sessionId }, action: "operator.switched-in", data: { from: u.tenantId ?? null } });
    await tx.query("update sessions set tenant_id = $2 where id = $1", [u.sessionId, tenantId]);
  });
}

// ─── Adding a funder ─────────────────────────────────────────────────────────

export interface NewFunder { name: string; color: string; countries: ("US" | "GB" | "FR")[]; processOwnerName?: string; templateTenantId?: string }

const PACKS_BY_COUNTRY: Record<string, string[]> = { US: ["us"], GB: ["uk", "efpia"], FR: ["fr", "efpia"] };
const ALWAYS_PACKS = ["core", "accredited-ce"];
const ENTITY_SUFFIX: Record<string, string> = { US: "Inc.", GB: "UK Ltd", FR: "France SAS" };
// A demo team for the new funder: every seat a grants office needs. Names are fictional.
const TEAM: [string, string, string[]][] = [
  ["Sam Rivera", "Grants Coordinator", ["coordinator"]],
  ["Dr. Lena Fischer", "Medical Reviewer (final medical signatory)", ["medical-reviewer"]],
  ["Tom Becker", "Compliance Reviewer", ["compliance-reviewer"]],
  ["Dr. Grace Ellis", "Chair, Grants Committee", ["committee-chair"]],
  ["Dr. Ken Mori", "Member, Grants Committee", ["committee-member"]],
  ["Ruth Adler", "Member, Grants Committee", ["committee-member"]],
  ["Nadia Rahman", "Counsel", ["legal"]],
  ["Joe Lindgren", "Finance Manager", ["finance"]],
  ["Maria Lopez", "Compliance Auditor", ["compliance-auditor"]],
  ["Chris Novak", "Identity and Access Administrator", ["access-admin"]],
];

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "funder";
const emailFor = (name: string, slug: string) => `${name.replace(/^(dr|pr|prof)\.?\s+/i, "").toLowerCase().normalize("NFKD").replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".")}@${slug}.example`;

/**
 * Create a funder from a template funder's signed setup. The new funder gets its own name, colour, countries and
 * people; the template's rules and workflow are copied as version 1 and can then be changed in its own Studio.
 */
export async function createFunder(u: SessionUser, input: NewFunder) {
  requireOperator(u);
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) throw new HttpError(400, "Give the funder a name of 2 to 60 characters.");
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new HttpError(400, "Choose a colour such as #1F6F8B.");
  const countries = [...new Set(input.countries)].filter((c) => c in PACKS_BY_COUNTRY);
  if (!countries.length) throw new HttpError(400, "Choose at least one country.");
  const ownerName = (input.processOwnerName ?? "").trim() || "Alex Morgan";

  return withContext({ operator: true }, async (tx) => {
    if (await one(tx, "select 1 from tenants where lower(name) = lower($1)", [name])) throw new HttpError(409, `There is already a funder called ${name}.`);
    const template = input.templateTenantId
      ? await one<{ id: string; name: string; slug: string; settings: Record<string, unknown> }>(tx, "select id, name, slug, settings from tenants where id = $1", [input.templateTenantId])
      : await one<{ id: string; name: string; slug: string; settings: Record<string, unknown> }>(tx, "select id, name, slug, settings from tenants where slug = 'halden'");
    if (!template) throw new HttpError(404, "The funder to copy from wasn't found.");
    const configs = await many<{ kind: string; body: Record<string, unknown> }>(tx, "select kind, body from config_versions where tenant_id = $1 and status = 'published'", [template.id]);
    if (!configs.some((c) => c.kind === "catalogue")) throw new HttpError(409, `${template.name} has no published setup to copy.`);

    let slug = slugify(name);
    for (let i = 2; await one(tx, "select 1 from tenants where slug = $1", [slug]); i++) slug = `${slugify(name)}-${i}`;
    const words = { ...(template.settings.words as Record<string, unknown> ?? {}), assistantName: "FundingEnvoy" };
    const brand = { logoText: name, color: input.color };
    const tenant = await one<{ id: string }>(tx, "insert into tenants (slug, name, region, residency, settings) values ($1,$2,$3,$4,$5) returning id", [
      slug, name, countries.includes("US") ? "us-east" : "eu-west", countries.includes("US") ? "US" : "EU",
      JSON.stringify({
        brand, words, languages: countries.includes("FR") ? ["en", "fr"] : ["en"], productNames: [],
        legalEntities: Object.fromEntries(countries.map((c) => [c, `${name} ${ENTITY_SUFFIX[c]}`])),
        demo: true, managedService: true, createdFrom: template.slug,
      }),
    ]);
    const id = tenant!.id;

    // The template's signed setup, renamed and narrowed to the chosen countries.
    const packs = new Set([...ALWAYS_PACKS, ...countries.flatMap((c) => PACKS_BY_COUNTRY[c]!)]);
    const short = template.name.split(/\s+/)[0]!;
    const rename = (body: unknown) => {
      let text = JSON.stringify(body).split(template.name).join(JSON.stringify(name).slice(1, -1));
      if (short.length >= 4) text = text.split(short).join(JSON.stringify(name).slice(1, -1));
      return JSON.parse(text) as Record<string, unknown>;
    };
    const signed = `${u.name} (set up from ${template.name})`;
    const copied: string[] = [];
    for (const c of configs) {
      if (c.kind === "brand" || c.kind === "words") continue;
      let body = rename(c.body);
      if (c.kind === "rulebook") body = { ...body, packs: ((body.packs as { id: string }[]) ?? []).filter((p) => packs.has(p.id)) };
      if (c.kind === "testset") body = { ...body, cases: ((body.cases as { country?: string }[]) ?? []).filter((t) => !t.country || countries.includes(t.country as NewFunder["countries"][number])) };
      await tx.query("insert into config_versions (tenant_id, kind, version, status, body, signed_name, signed_at, note) values ($1,$2,1,'published',$3,$4,now(),$5)",
        [id, c.kind, JSON.stringify(body), signed, `Copied from ${template.name}`]);
      copied.push(c.kind);
    }
    for (const [kind, body] of [["brand", brand], ["words", words]] as const) {
      await tx.query("insert into config_versions (tenant_id, kind, version, status, body, signed_name, signed_at, note) values ($1,$2,1,'published',$3,$4,now(),'New funder')", [id, kind, JSON.stringify(body), signed]);
    }

    // People: the process owner named in the form, and a demo team for every other seat.
    const team: [string, string, string[]][] = [[ownerName, "Head of Grants (process owner)", ["process-owner"]], ...TEAM];
    const people: { name: string; title: string; roles: string[] }[] = [];
    for (const [personName, title, roles] of team) {
      let email = emailFor(personName, slug);
      for (let i = 2; await one(tx, "select 1 from users where lower(email) = lower($1)", [email]); i++) email = email.replace(/(\.\d+)?@/, `.${i}@`);
      await tx.query("insert into users (email, name, title, kind, tenant_id, roles, attributes, source) values ($1,$2,$3,'internal',$4,$5,$6,'manual')",
        [email, personName, title, id, roles, JSON.stringify({ finalSignatory: roles.includes("medical-reviewer"), createdBy: u.name })]);
      people.push({ name: personName, title, roles });
    }

    // Requesting organizations in the chosen countries that already share their profile with the template funder.
    const shared = await tx.query("insert into org_shares (org_id, tenant_id) select s.org_id, $2 from org_shares s join organizations o on o.id = s.org_id where s.tenant_id = $1 and o.country = any($3) on conflict do nothing", [template.id, id, countries]);

    await record(tx, { tenantId: id, actor: actorOf(u), entity: { type: "tenant", id }, action: "tenant.created", data: {
      name, slug, countries, template: template.name, packs: [...packs], configuration: copied, people: people.length, organizationsShared: shared.rowCount ?? 0,
    } });
    return { id, slug, name, countries, packs: [...packs], people, organizationsShared: shared.rowCount ?? 0 };
  });
}

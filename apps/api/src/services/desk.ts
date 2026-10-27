// The coordinator's desk and the brief for one request: judgement items first, then the recommendation
// with its basis, then every check with its evidence.
import type { CheckResult, Role } from "@fe/core";
import { buildFacts, effectiveLevel, formatMoney, summarize, AUTONOMY_LABELS } from "@fe/core";
import { many, one } from "@fe/db";
import { asUser, HttpError, type SessionUser } from "../auth.ts";
import { tenantConfig } from "../config.ts";
import { loadRequest, runChecks, view } from "./requests.ts";

interface DeskRow {
  id: string; ref: string; title: string | null; status: string; stage: string; amount: number | null; currency: string | null; subtype: string | null; country: string;
  submitted_at: Date | null; updated_at: Date; stage_entered_at: Date; org_name: string; state: { checks?: CheckResult[]; flags?: unknown[]; judgements?: Record<string, unknown>; reviewingGroup?: { label: string }; coi?: Record<string, { answer: string }>; infoRequests?: { status: string; dueAt?: string; questions: { answer?: string }[] }[] };
  tasks: { kind: string; title: string; role: string | null; due_at: string | null }[] | null;
}

export interface DeskItem {
  id: string; ref: string; title: string; organization: string; subtype?: string; country: string; amount?: number; currency?: string; amountLabel: string;
  stage: string; stageName: string; status: string; submittedAt?: string; ageDays: number; forJudgement: number; passed: number; reviewingGroup?: string;
  line: string; // the one sentence that says why it is in this list
  tasks: { kind: string; title: string; role?: string; due?: string }[];
}

type DeskLite = Omit<DeskRow, "state"> & { judgement_open: number | null; group_label: string | null; passed: number | null; info_requests: NonNullable<DeskRow["state"]["infoRequests"]> | null };

const OPEN = "r.status not in ('draft', 'withdrawn', 'closed', 'declined')";
const SHOWN = { needsYou: 100, assistant: 50, waiting: 50 };

/**
 * A seat's desk. Open work is sorted into piles in one query over indexed columns (stage, open tasks, and the
 * stored judgement and information-request summaries), so it stays fast however much history the tenant has.
 * Full request state is loaded only for the items shown; counts cover everything.
 */
export async function desk(u: SessionUser) {
  return asUser(u, async (tx) => {
    const cfg = await tenantConfig(tx, u.tenantId!);
    const stages = new Map(cfg.workflow.stages.map((s) => [s.id, s]));
    const subtypes = new Map(cfg.catalogue.subtypes.map((s) => [s.id, s.name]));
    const myRoles = new Set<Role>(u.roles);
    const mine = cfg.workflow.stages.filter((s) => u.kind === "operator" ? false : s.ownerRoles.some((x) => myRoles.has(x))).map((s) => s.id);
    const handled = cfg.workflow.stages.filter((s) => !mine.includes(s.id) && effectiveLevel(s, cfg.autonomy, { family: undefined }) >= 3).map((s) => s.id);

    const piles = await many<{ id: string; pile: keyof typeof SHOWN; total: number }>(tx, `
      with mine as materialized (
        select distinct request_id from tasks where tenant_id = $1 and status = 'open' and assignee_role = any($3) and request_id is not null
      ), b as (
        select r.id, r.judgement_open, r.submitted_at, r.stage_entered_at,
          case when r.info_open then 'assistant'
               when r.stage = any($2) or m.request_id is not null then 'needsYou'
               when r.stage = any($4) then 'assistant' else 'waiting' end as pile
        from requests r left join mine m on m.request_id = r.id where r.tenant_id = $1 and ${OPEN}
      ), ranked as (
        select id, pile, count(*) over (partition by pile)::int as total,
          row_number() over (partition by pile order by case when pile = 'needsYou' then judgement_open end desc nulls last, submitted_at asc nulls last, stage_entered_at asc) as rn
        from b
      )
      select id, pile, total from ranked where rn <= case pile when 'needsYou' then ${SHOWN.needsYou} when 'assistant' then ${SHOWN.assistant} else ${SHOWN.waiting} end
      order by pile, rn`, [u.tenantId, mine, [...myRoles], handled]);
    const doneIds = await many<{ id: string }>(tx, `select r.id from requests r where r.tenant_id = $1 and r.status in ('closed', 'declined') order by r.updated_at desc limit 20`, [u.tenantId]);

    const ids = [...piles.map((p) => p.id), ...doneIds.map((d) => d.id)];
    const rows = ids.length ? await many<DeskLite>(tx, `
      select r.id, r.ref, r.title, r.status, r.stage, r.amount, r.currency, r.subtype, r.country, r.submitted_at, r.updated_at, r.stage_entered_at, o.legal_name as org_name,
        r.judgement_open, r.group_label, r.state->'infoRequests' as info_requests,
        (select count(*) from jsonb_array_elements(case when jsonb_typeof(r.state->'checks') = 'array' then r.state->'checks' else '[]'::jsonb end) c where c->>'status' = 'pass')::int as passed,
        (select json_agg(json_build_object('kind', t.kind, 'title', t.title, 'role', t.assignee_role, 'due_at', t.due_at)) from tasks t where t.request_id = r.id and t.status = 'open') as tasks
      from requests r join organizations o on o.id = r.org_id where r.id = any($1)`, [ids]) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));

    const build = (r: DeskLite): DeskItem => {
      const st = stages.get(r.stage);
      const forJudgement = r.judgement_open ?? 0;
      const tasks = (r.tasks ?? []).map((t) => ({ kind: t.kind, title: t.title, role: t.role ?? undefined, due: t.due_at ?? undefined }));
      return {
        id: r.id, ref: r.ref, title: r.title ?? "Untitled request", organization: r.org_name, subtype: r.subtype ? subtypes.get(r.subtype) : undefined, country: r.country,
        amount: r.amount ?? undefined, currency: r.currency ?? undefined, amountLabel: formatMoney(r.amount ?? undefined, r.currency ?? "USD"),
        stage: r.stage, stageName: st?.name ?? r.stage, status: r.status, submittedAt: r.submitted_at?.toISOString(),
        ageDays: Math.max(0, Math.round((Date.now() - (r.submitted_at ?? r.updated_at).getTime()) / 86400000)),
        forJudgement, passed: r.passed ?? 0, reviewingGroup: r.group_label ?? undefined,
        line: "", tasks,
      };
    };

    const out = { needsYou: [] as DeskItem[], assistant: [] as DeskItem[], waiting: [] as DeskItem[] };
    const counts = { needsYou: 0, assistant: 0, waiting: 0 };
    for (const p of piles) {
      counts[p.pile] = p.total;
      const r = byId.get(p.id);
      if (!r) continue;
      const item = build(r);
      const st = stages.get(r.stage);
      const openInfo = r.info_requests?.find((i) => i.status === "open");
      if (p.pile === "needsYou") {
        const myTask = item.tasks.find((t) => t.role && myRoles.has(t.role as Role));
        item.line = myTask?.title.replace(`${r.ref}: `, "") ?? (item.forJudgement ? `${item.forJudgement} item${item.forJudgement === 1 ? "" : "s"} for your judgement` : `${st?.name ?? r.stage}`);
      } else if (openInfo) {
        const answered = openInfo.questions.filter((q) => q.answer).length;
        item.line = `Waiting on the requestor: ${answered} of ${openInfo.questions.length} answered${openInfo.dueAt ? ` · due ${openInfo.dueAt}` : ""}`;
      } else if (p.pile === "assistant") {
        const lvl = st ? effectiveLevel(st, cfg.autonomy, { family: undefined }) : 0;
        item.line = `${st?.name}: FundingEnvoy is handling this (${AUTONOMY_LABELS[lvl as 3]})`;
      } else item.line = `${st?.name ?? r.stage} · with ${st?.ownerRoles.join(", ") ?? "others"}`;
      out[p.pile].push(item);
    }
    const done = doneIds.map((d) => byId.get(d.id)).filter((r): r is DeskLite => Boolean(r)).map((r) => ({ ...build(r), line: r.status === "declined" ? "Declined" : "Closed" }));
    return { ...out, done, counts, shown: SHOWN };
  });
}

export async function brief(u: SessionUser, requestId: string) {
  return asUser(u, async (tx) => {
    const l = await loadRequest(tx, requestId);
    if (l.state.status === "draft") throw new HttpError(404, "This request has not been submitted.");
    const checks = runChecks(l, "review");
    const sum = summarize(checks);
    const judged = l.state.judgements ?? {};
    const judgement = [
      ...checks.filter((c) => c.status === "judge" || c.acknowledged || (c.status === "fail" && c.severity === "judge")).map((c) => ({
        ruleId: c.ruleId, title: c.statement, text: c.acknowledged ? `${c.message} The requestor chose to submit with this flag${c.acknowledged.note ? `: "${c.acknowledged.note}"` : "."}` : c.message,
        basis: c.basis, evidence: c.evidence, decided: judged[c.ruleId],
        options: c.acknowledged ? [{ id: "accept-with-condition", label: "Accept with condition" }, { id: "ask-requestor", label: "Ask requestor" }] : [{ id: "allow", label: "Allow" }, { id: "exclude", label: "Exclude" }],
      })),
      ...Object.values(l.state.coi).filter((a) => a.answer === "yes").map((a) => ({
        ruleId: `coi:${a.questionId}`, title: "Conflict of interest: requestor answered yes",
        text: `${l.cfg.catalogue.coiQuestions.find((q) => q.id === a.questionId)?.text ?? a.questionId} — "${a.detail ?? "yes"}" (${a.by.name})`,
        basis: { layer: "policy" as const, ref: "Policy 7.3" }, evidence: [], decided: judged[`coi:${a.questionId}`],
        options: [{ id: "acceptable", label: "Acceptable as managed" }, { id: "refer", label: "Refer to compliance" }],
      })),
    ];
    const stage = l.cfg.workflow.stages.find((s) => s.id === l.state.stage);
    const level = stage ? effectiveLevel(stage, l.cfg.autonomy, buildFacts({ ...l.ctx, request: l.state })) : 0;
    const actions = (stage?.outcomes ?? []).filter((o) => o.actorRoles.some((r) => u.roles.includes(r)) || u.kind === "operator").map((o) => ({ id: o.id, label: o.label, requiresReason: Boolean(o.requiresReason), locked: o.locked }));
    const similar = await comparable(tx, l.row.tenant_id, l.state.subtype ?? "");
    const committeeStage = l.cfg.workflow.stages.find((s) => s.outcomes.some((o) => o.locked === "decide-funding"));
    const meeting = nextMeetingDate();
    const group = l.state.reviewingGroup?.label;
    const recommendation = level >= 2 ? {
      text: stage && /review|triage|completeness/.test(stage.id)
        ? `Route to ${group ?? "the reviewing group"}${committeeStage ? ` for the ${meeting} committee` : ""}${judgement.length ? `, with ${judgement.length} item${judgement.length === 1 ? "" : "s"} marked for discussion` : ""}.`
        : `${stage?.name ?? "This stage"}: ${judgement.length ? `${judgement.length} item${judgement.length === 1 ? "" : "s"} need a decision first.` : "nothing outstanding."}`,
      basis: `${l.state.reviewingGroup?.rule ? `Rule ${l.state.reviewingGroup.rule}` : "Routing rules"} · ${similar?.n ?? 0} comparable requests decided${similar?.median_days ? ` · median ${Math.round(similar.median_days)} days to decision` : ""}. Nothing here predicts the outcome.`,
      level, levelLabel: AUTONOMY_LABELS[level],
    } : undefined;
    const events = await one<{ agent: number; extracted: number; classified: number }>(tx, `
      select count(*) filter (where actor->>'type' = 'agent')::int as agent,
        count(*) filter (where action = 'assistant.extracted')::int as extracted,
        count(*) filter (where action = 'assistant.classified-document')::int as classified
      from events where tenant_id = $1 and request_id = $2`, [l.row.tenant_id, l.row.id]);
    const v = view(l, checks);
    const requestor = await one<{ id: string; name: string; title: string | null }>(tx, "select id, name, title from users where id = $1", [l.row.requestor_id]);
    return {
      requestor: requestor ? { id: requestor.id, name: requestor.name, title: requestor.title ?? undefined } : undefined,
      submittedBy: requestor?.name, submittedAt: l.state.submittedAt,
      ...v, judgement, recommendation, actions, reviewingGroup: l.state.reviewingGroup, summaryCounts: { passed: sum.passed.length, forYou: judgement.length, total: checks.length },
      assistantActivity: { actions: events?.agent ?? 0, extractions: events?.extracted ?? 0, documentsClassified: events?.classified ?? 0, proposedFields: Object.values(l.state.fields).filter((f) => f.proposedBy?.type === "agent").length },
      infoRequests: l.state.infoRequests ?? [], decision: l.state.decision, reviewSummary: l.state.reviewSummary,
      groups: (await import("./workflow.ts")).triageGroups(l, await (await import("./workflow.ts")).reviewingGroups(tx, l.row.tenant_id)).map((g) => ({ id: g.id, label: g.label })),
    };
  });
}

const comparableCache = new Map<string, { at: number; value: { n: number; median_days: number | null; approved: number } | undefined }>();

/** Requests of the same type decided in the last two years: how many, and the median days to a decision. Cached briefly. */
async function comparable(tx: Parameters<typeof one>[0], tenantId: string, subtype: string) {
  const key = `${tenantId}:${subtype}`;
  const hit = comparableCache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  const value = await one<{ n: number; median_days: number | null; approved: number }>(tx, `
    select count(*)::int as n, percentile_cont(0.5) within group (order by extract(epoch from decided_at - submitted_at) / 86400) as median_days,
      count(*) filter (where status not in ('declined'))::int as approved
    from requests where tenant_id = $1 and subtype = $2 and decided_at is not null and decided_at > now() - interval '2 years'`, [tenantId, subtype]);
  comparableCache.set(key, { at: Date.now(), value });
  return value;
}

/** Committee meets on the second and fourth Thursday of each month (demo tenant setting). */
export function nextMeetingDate(from = new Date()): string {
  for (let i = 1; i < 60; i++) {
    const d = new Date(from.getTime() + i * 86400000);
    if (d.getUTCDay() !== 4) continue;
    const nth = Math.ceil(d.getUTCDate() / 7);
    if (nth === 2 || nth === 4) return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })}`;
  }
  return "next";
}

export async function myRequests(u: SessionUser) {
  return asUser(u, async (tx) => {
    const cfg = await tenantConfig(tx, u.tenantId!);
    const rows = await many<Omit<DeskRow, "state"> & { decided_at: Date | null; info_requests: NonNullable<DeskRow["state"]["infoRequests"]> | null }>(tx, `
      select r.id, r.ref, r.title, r.status, r.stage, r.amount, r.currency, r.subtype, r.country, r.submitted_at, r.updated_at, r.stage_entered_at, r.decided_at, o.legal_name as org_name, r.state->'infoRequests' as info_requests,
        (select json_agg(json_build_object('kind', t.kind, 'title', t.title, 'role', t.assignee_role, 'due_at', t.due_at)) from tasks t where t.request_id = r.id and t.status = 'open' and t.assignee_role = 'requestor') as tasks
      from requests r join organizations o on o.id = r.org_id where r.org_id = $1 order by r.updated_at desc`, [u.orgId]);
    const stages = new Map(cfg.workflow.stages.map((s) => [s.id, s]));
    return rows.map((r) => {
      const st = stages.get(r.stage);
      const sub = cfg.catalogue.subtypes.find((s) => s.id === r.subtype);
      const openInfo = r.info_requests?.find((i) => i.status === "open");
      return {
        id: r.id, ref: r.ref, title: r.title ?? "Untitled request", status: r.status, stage: r.stage, stageName: st?.name, amountLabel: formatMoney(r.amount ?? undefined, r.currency ?? "USD"),
        plain: plainStatus(r.status, st?.name, sub?.typicalDecisionWeeks, r.submitted_at, r.decided_at),
        needsYou: Boolean(openInfo) || r.status === "draft" || (r.tasks ?? []).length > 0,
        action: openInfo ? `The grants team asked ${openInfo.questions.length} question${openInfo.questions.length === 1 ? "" : "s"}` : r.status === "draft" ? "Draft: continue where you left off" : (r.tasks ?? [])[0]?.title,
        due: openInfo?.dueAt ?? (r.tasks ?? [])[0]?.due_at ?? undefined,
        updatedAt: r.updated_at.toISOString(),
      };
    });
  });
}

function plainStatus(status: string, stageName: string | undefined, weeks: [number, number] | undefined, submitted: Date | null, decided: Date | null): string {
  switch (status) {
    case "draft": return "Draft. Nothing has been sent.";
    case "submitted": return "Submitted. A coordinator will pick it up shortly.";
    case "in-review": return `Being reviewed${weeks ? `. Decisions for this type usually take ${weeks[0]} to ${weeks[1]} weeks` : ""}${submitted ? ` from ${submitted.toISOString().slice(0, 10)}` : ""}.`;
    case "info-requested": return "The grants team has a question for you.";
    case "committee": return "With the committee for a decision.";
    case "agreement": return "Approved. The agreement is being prepared or is out for signature.";
    case "payment": return "Agreement signed. Payment is being released.";
    case "reconciliation": return "Reconciliation is due: how the funds were used.";
    case "outcomes": return "Outcomes report is due.";
    case "declined": return `Not funded${decided ? ` (decided ${decided.toISOString().slice(0, 10)})` : ""}.`;
    case "closed": return "Closed.";
    default: return stageName ?? status;
  }
}

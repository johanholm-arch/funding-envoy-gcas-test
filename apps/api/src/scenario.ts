// Demo scenario: after the seed, puts requests at different points of the process so every seat has something
// real on its desk. It drives the same HTTP endpoints people use, as the people who would use them, so every step
// is in the trail exactly as it would be in use. The flagship requestors (Dr. Elena Marsh and R. Delgado of the
// New England Cardiology Society) are left untouched for the live demo.
//
//   pnpm --filter @fe/api seed && pnpm --filter @fe/api scenario
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { closePool } from "@fe/db";
import { buildServer } from "./server.ts";
import { uuidFor } from "./seed.ts";

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../content/halden/scenario");

type Who = string;
interface Ask { kind: string; questionId?: string; options?: { id: string; label: string; subtype?: string }[] }

export class Driver {
  private cookies: Record<string, string> = {};
  constructor(private app: FastifyInstance) {}

  async login(who: Who, contentId: string) {
    const r = await this.app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { userId: uuidFor(contentId) } });
    if (r.statusCode !== 200) throw new Error(`login ${contentId}: ${r.body}`);
    this.cookies[who] = `fe_session=${r.cookies.find((x) => x.name === "fe_session")!.value}`;
  }

  async try(who: Who, method: "GET" | "POST", url: string, payload?: unknown) {
    const r = await this.app.inject({ method, url, payload: payload as object, headers: { cookie: this.cookies[who]! } });
    return { status: r.statusCode, body: r.body ? r.json() : undefined };
  }

  async call(who: Who, method: "GET" | "POST", url: string, payload?: unknown) {
    const r = await this.try(who, method, url, payload);
    if (r.status >= 400) throw new Error(`${who} ${method} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  }

  async upload(who: Who, requestId: string, set: string, files: string[]) {
    const boundary = "----fe" + Math.random().toString(16).slice(2);
    const parts: Buffer[] = [];
    for (const f of files) {
      const buf = await readFile(path.join(DOCS, set, f));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f}"\r\nContent-Type: ${f.endsWith(".csv") ? "text/csv" : "text/markdown"}\r\n\r\n`), buf, Buffer.from("\r\n"));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const r = await this.app.inject({ method: "POST", url: `/api/requests/${requestId}/documents`, payload: Buffer.concat(parts), headers: { cookie: this.cookies[who]!, "content-type": `multipart/form-data; boundary=${boundary}` } });
    if (r.statusCode >= 400) throw new Error(`upload → ${r.statusCode}: ${r.body}`);
  }

  private async lastAsk(who: Who, id: string): Promise<Ask | undefined> {
    const v = await this.call(who, "GET", `/api/requests/${id}`);
    return [...v.messages].reverse().find((m: { data?: { ask?: Ask } }) => m.data?.ask)?.data.ask;
  }

  /** Answers the assistant's questions the way the requestor would, then submits. Returns blockers if it cannot. */
  async prepareAndSubmit(who: Who, id: string, o: { subtype: string; typedName: string; flagNote: string }): Promise<{ ref?: string; blockers?: string[] }> {
    for (let i = 0; i < 4; i++) {
      const ask = await this.lastAsk(who, id);
      if (ask?.kind === "type") {
        const opt = ask.options?.find((x) => x.subtype === o.subtype || x.id === `subtype:${o.subtype}`) ?? ask.options?.[0];
        await this.call(who, "POST", `/api/requests/${id}/choice`, { questionId: ask.questionId ?? "type", optionId: opt!.id });
      } else if (ask?.kind === "budget") {
        await this.call(who, "POST", `/api/requests/${id}/choice`, { questionId: ask.questionId, optionId: "use-budget" });
      } else break;
    }
    await this.call(who, "POST", `/api/requests/${id}/confirm-all`);
    let p = await this.call(who, "GET", `/api/requests/${id}/preview`);
    const missing = p.progress.missing as { key: string; kind: string; options?: string[] }[];
    const filler = (f: { kind: string; options?: string[] }) => f.options?.[0] ?? (f.kind === "number" || f.kind === "money" ? 1 : f.kind === "boolean" ? true : f.kind.startsWith("date") ? "2027-06-10" : "As described in the attached programme.");
    if (missing.length) await this.call(who, "POST", `/api/requests/${id}/fields`, { changes: missing.map((f) => ({ key: f.key, value: filler(f) })) });
    for (const q of (p.subtype?.coi ?? []) as string[]) await this.call(who, "POST", `/api/requests/${id}/coi`, { questionId: q, answer: "no" });
    for (const a of (p.subtype?.attestations ?? []) as string[]) {
      const def = p.catalogue.attestations.find((x: { id: string }) => x.id === a);
      await this.call(who, "POST", `/api/requests/${id}/attestations`, { attestationId: a, typedName: def?.mode === "type" ? o.typedName : undefined });
    }
    p = await this.call(who, "GET", `/api/requests/${id}/preview`);
    for (const c of p.checks.filter((c: { status: string; severity: string; acknowledged?: unknown }) => c.status === "fail" && c.severity === "warn" && !c.acknowledged)) {
      await this.call(who, "POST", `/api/requests/${id}/flags`, { ruleId: c.ruleId, choice: "submit-with-flag", note: o.flagNote });
    }
    p = await this.call(who, "GET", `/api/requests/${id}/preview`);
    if (!p.canSubmit) return { blockers: (p.blockers as { ruleId: string; title?: string; message?: string }[]).map((b) => `${b.ruleId}: ${b.title ?? b.message ?? ""}`) };
    const r = await this.call(who, "POST", `/api/requests/${id}/submit`);
    return { ref: r.ref };
  }

  async stage(id: string): Promise<string> {
    return (await this.call("osei", "GET", `/api/requests/${id}/brief`)).request.stage;
  }

  /** Moves a submitted request forward through review, as the people at each stage, until it reaches `target`. */
  async advanceTo(id: string, target: string) {
    for (let i = 0; i < 10; i++) {
      const b = await this.call("osei", "GET", `/api/requests/${id}/brief`);
      const stage = b.request.stage as string;
      if (stage === target) return;
      if (stage === "completeness") await this.call("osei", "POST", `/api/requests/${id}/act`, { outcome: "complete" });
      else if (stage === "triage") await this.call("osei", "POST", `/api/requests/${id}/act`, { outcome: "route", groupId: b.reviewingGroup?.id });
      else if (stage === "medical-review" || stage === "compliance-review") {
        const reviewers = stage === "medical-review" ? ["patel", "ashworth"] : ["okafor"];
        let done = false;
        for (const r of reviewers) {
          const res = await this.try(r, "POST", `/api/requests/${id}/act`, { outcome: "accept", reason: stage === "medical-review" ? "Educational need is documented and the programme is balanced." : "Independence safeguards and the budget are in order." });
          if (res.status < 400) { done = true; break; }
        }
        if (!done) throw new Error(`no reviewer could accept ${id} at ${stage}`);
      } else throw new Error(`advanceTo: cannot move ${id} past ${stage} toward ${target}`);
    }
    throw new Error(`advanceTo: ${id} did not reach ${target}`);
  }
}

export async function runScenario(app?: FastifyInstance) {
  const own = !app;
  app ??= await buildServer();
  const d = new Driver(app);
  const people: [string, string][] = [["osei", "hp-osei"], ["patel", "hp-patel"], ["ashworth", "hp-ashworth"], ["okafor", "hp-okafor"], ["alvarez", "hp-alvarez"], ["haddad", "hp-haddad"],
    ["shah", "rq-shah"], ["mercier", "rq-mercier"], ["quinlan", "rq-quinlan"], ["dupuis", "rq-dupuis"]];
  for (const [who, id] of people) await d.login(who, id);
  const out: { who: string; ref?: string; id: string; stage: string; note?: string }[] = [];

  // 1. Pennine Heart Failure Society (UK): submitted this morning, waiting for medical review.
  {
    const r = await d.call("shah", "POST", "/api/requests", { text: "We are seeking GBP 18,000 towards our Heart Failure Masterclass 2027 in Leeds, an accredited two-day course for registrars and specialist nurses." });
    await d.upload("shah", r.id, "pennine", ["Pennine_Request_Letter.md", "Pennine_Prospectus.md", "Pennine_Budget.csv", "Pennine_Accounts_2025-26.md", "Pennine_CPD_Accreditation.md"]);
    const s = await d.prepareAndSubmit("shah", r.id, { subtype: "ime-accredited", typedName: "Dr. Amira Shah", flagNote: "Course dates are set by the deanery calendar." });
    if (s.ref) await d.advanceTo(r.id, "medical-review");
    out.push({ who: "Dr. Amira Shah, Pennine", id: r.id, ref: s.ref, stage: s.ref ? await d.stage(r.id) : "intake", note: s.blockers?.join("; ") });
  }

  // 2. AFIC (France): reviewed, waiting for the committee.
  {
    const r = await d.call("mercier", "POST", "/api/requests", { text: "Bonjour, nous sollicitons un soutien pour les Journées Francophones d'Insuffisance Cardiaque 2027 à Lyon." });
    await d.upload("mercier", r.id, "afic", ["AFIC_Lettre_de_demande.md", "AFIC_Programme.md", "AFIC_Budget.csv", "AFIC_Comptes_annuels_2025.md", "AFIC_Recepisse_Prefecture.md"]);
    const s = await d.prepareAndSubmit("mercier", r.id, { subtype: "ime-non-accredited", typedName: "Julien Mercier", flagNote: "Les dates sont fixées par le congrès." });
    if (s.ref) await d.advanceTo(r.id, "committee");
    out.push({ who: "Julien Mercier, AFIC", id: r.id, ref: s.ref, stage: s.ref ? await d.stage(r.id) : "intake", note: s.blockers?.join("; ") });
  }

  // 3. Heartline Patient Alliance (US): a small charitable contribution, as far through review as it goes.
  {
    const r = await d.call("quinlan", "POST", "/api/requests", { text: "Heartline would like to ask for $4,500 for our peer support groups for people living with heart failure." });
    await d.upload("quinlan", r.id, "heartline", ["Heartline_Request_Letter.md", "Heartline_Programme_Description.md", "Heartline_Budget.csv", "Heartline_Nonprofit_Letter_2019.md", "Heartline_W9_2026.md", "Heartline_Annual_Report_2025.md"]);
    const s = await d.prepareAndSubmit("quinlan", r.id, { subtype: "charitable-contribution", typedName: "Teresa Quinlan", flagNote: "Groups run year-round." });
    if (s.ref) {
      await d.advanceTo(r.id, "committee");
      // Approved, agreement signed by both sides; now with Finance, who must confirm the disclosure classification.
      await d.call("alvarez", "POST", `/api/requests/${r.id}/decision`, {
        outcome: "approve", amount: 4500, rationale: "Patient support programme with restricted use, diverse funding and no product link.",
        votes: [{ memberId: uuidFor("hp-alvarez"), vote: "for" }],
      });
      await d.call("haddad", "POST", `/api/requests/${r.id}/agreement/send`);
      await d.call("quinlan", "POST", `/api/requests/${r.id}/agreement/sign`, { typedName: "Teresa Quinlan" });
      await d.call("haddad", "POST", `/api/requests/${r.id}/agreement/sign`, { typedName: "Rania Haddad" });
      await d.call("haddad", "POST", `/api/requests/${r.id}/act`, { outcome: "complete" });
    }
    out.push({ who: "Teresa Quinlan, Heartline", id: r.id, ref: s.ref, stage: s.ref ? await d.stage(r.id) : "intake", note: s.blockers?.join("; ") });
  }

  // 4. A draft in progress: Karen Dupuis has started something but not finished.
  {
    const r = await d.call("dupuis", "POST", "/api/requests", { text: "We'd like support for our nurses' heart failure update day in Concord, about $12,000." });
    out.push({ who: "Karen Dupuis, Granite State Cardiovascular Nurses", id: r.id, stage: "intake", note: "draft: started in conversation, no documents yet" });
  }

  if (own) await app.close();
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.env.FE_TODAY ??= "2027-04-02";
  runScenario()
    .then((rows) => { for (const r of rows) console.log(`${(r.ref ?? "draft").padEnd(16)} ${r.stage.padEnd(18)} ${r.who}${r.note ? `  (${r.note})` : ""}`); })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => closePool());
}

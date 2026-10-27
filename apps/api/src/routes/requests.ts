import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { many } from "@fe/db";
import { asUser, HttpError, requireRole, requireTenantUser, requireUser } from "../auth.ts";
import { acknowledge, answerCoi, askPolicy, attest, confirmAll, nextAsk, onChoice, onMessage, onUpload, preview, reuseDocument, startRequest, submit, updateBudget, updateFields } from "../services/assistant.ts";
import { summarize } from "@fe/core";
import { loadRequest, runChecks, view } from "../services/requests.ts";
import { brief, desk, myRequests } from "../services/desk.ts";
import { act, answerInfo, committeeMembers, decide, judge, requestInfo } from "../services/workflow.ts";
import { getFile } from "../storage.ts";

const id = z.object({ id: z.string().uuid() });

export async function requestRoutes(app: FastifyInstance) {
  // ─── Requestor ───
  app.get("/api/my/requests", async (req) => myRequests(requireTenantUser(req)));

  app.post("/api/requests", async (req) => {
    const u = requireTenantUser(req);
    const body = z.object({ text: z.string().max(8000).optional(), country: z.string().length(2).optional() }).parse(req.body ?? {});
    return { id: await startRequest(u, body) };
  });

  app.get("/api/requests/:id", async (req) => {
    const u = requireTenantUser(req);
    const { id: rid } = id.parse(req.params);
    return asUser(u, async (tx) => {
      const l = await loadRequest(tx, rid);
      const internal = u.kind !== "requestor";
      const messages = await many<{ id: string; author: unknown; body: string; data: unknown; channel: string; created_at: Date }>(tx,
        `select id, author, body, data, channel, created_at from messages where request_id = $1 ${internal ? "" : "and channel = 'requestor'"} order by created_at, id`, [rid]);
      const open = l.state.status === "draft" || l.state.status === "info-requested";
      const checks = open ? runChecks(l, "draft") : l.state.checks;
      // Readiness without side effects: the preview re-screens when screening is stale; this does not.
      const sum = summarize(checks);
      const unacked = checks.filter((c) => c.status === "fail" && c.severity === "warn" && !c.acknowledged);
      const proposed = Object.values(l.state.fields).filter((v) => v.status === "proposed").length;
      return {
        ...view(l, checks), messages: messages.map((m) => ({ ...m, createdAt: m.created_at })),
        nextAsk: l.state.status === "draft" && l.state.typeConfirmed ? nextAsk(l, checks) : undefined,
        // Same three conditions as /submit: no must-fix check, every "your call" decided, every proposed value confirmed.
        readiness: open ? {
          canSubmit: sum.submittable && !unacked.length && !proposed,
          blockers: [
            ...checks.filter((c) => c.severity === "block" && (c.status === "fail" || c.status === "pending")).map((c) => ({ ruleId: c.ruleId, message: c.message })),
            ...unacked.map((c) => ({ ruleId: c.ruleId, message: `Your call: ${c.message}` })),
            ...(proposed ? [{ ruleId: "proposed", message: `Confirm or change ${proposed} proposed value${proposed === 1 ? "" : "s"}.` }] : []),
          ],
        } : undefined,
      };
    });
  });

  app.post("/api/requests/:id/messages", async (req) => {
    const u = requireTenantUser(req);
    const { id: rid } = id.parse(req.params);
    const { text } = z.object({ text: z.string().min(1).max(8000) }).parse(req.body);
    await onMessage(u, rid, text);
    return { ok: true };
  });

  app.post("/api/requests/:id/documents", async (req) => {
    const u = requireTenantUser(req);
    const { id: rid } = id.parse(req.params);
    const files: { name: string; mime: string; buf: Buffer; typeHint?: string }[] = [];
    let typeHint: string | undefined;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const buf = await part.toBuffer();
        if (buf.length > 25 * 1024 * 1024) throw new HttpError(413, `${part.filename} is larger than 25 MB.`);
        files.push({ name: part.filename, mime: part.mimetype, buf });
      } else if (part.fieldname === "type") typeHint = String(part.value);
    }
    if (!files.length) throw new HttpError(400, "No files were attached.");
    if (typeHint && files.length === 1) files[0]!.typeHint = typeHint;
    await onUpload(u, rid, files);
    return { ok: true, files: files.length };
  });

  app.get("/api/documents/:id/file", async (req, reply) => {
    const u = requireUser(req);
    const { id: did } = id.parse(req.params);
    const doc = await asUser(u, async (tx) => (await many<{ storage_key: string; mime: string; name: string }>(tx, "select storage_key, mime, name from documents where id = $1", [did]))[0]);
    if (!doc) throw new HttpError(404, "Document not found.");
    reply.header("content-type", doc.mime).header("content-disposition", `inline; filename="${doc.name.replace(/"/g, "")}"`);
    return reply.send(await getFile(doc.storage_key));
  });

  app.get("/api/documents/:id/pages", async (req) => {
    const u = requireUser(req);
    const { id: did } = id.parse(req.params);
    const doc = await asUser(u, async (tx) => (await many<{ name: string; type: string; pages_text: string[] | null }>(tx, "select name, type, pages_text from documents where id = $1", [did]))[0]);
    if (!doc) throw new HttpError(404, "Document not found.");
    return { name: doc.name, type: doc.type, pages: doc.pages_text ?? [] };
  });

  app.post("/api/requests/:id/choice", async (req) => {
    const u = requireTenantUser(req);
    const { id: rid } = id.parse(req.params);
    const b = z.object({ questionId: z.string(), optionId: z.string(), note: z.string().max(2000).optional() }).parse(req.body);
    await onChoice(u, rid, b.questionId, b.optionId, b.note);
    return { ok: true };
  });

  app.post("/api/requests/:id/fields", async (req) => {
    const u = requireTenantUser(req);
    const { id: rid } = id.parse(req.params);
    const b = z.object({ changes: z.array(z.object({ key: z.string(), value: z.unknown().optional(), confirm: z.boolean().optional(), reason: z.string().max(500).optional() })).min(1) }).parse(req.body);
    await updateFields(u, rid, b.changes);
    return { ok: true };
  });

  app.post("/api/requests/:id/confirm-all", async (req) => ({ confirmed: await confirmAll(requireTenantUser(req), id.parse(req.params).id) }));

  app.post("/api/requests/:id/budget", async (req) => {
    const b = z.object({ removeLine: z.number().int().optional(), addLine: z.object({ description: z.string().min(2).max(300), category: z.string().min(2).max(40), amount: z.number().nonnegative() }).optional(), note: z.string().max(1000).optional() }).parse(req.body);
    await updateBudget(requireTenantUser(req), id.parse(req.params).id, b);
    return { ok: true };
  });

  // Bring in a document the organization gave for an earlier request (the "reuse" action on a document check).
  app.post("/api/requests/:id/documents/reuse", async (req) => {
    const { type } = z.object({ type: z.string().min(2).max(60) }).parse(req.body);
    return reuseDocument(requireTenantUser(req), id.parse(req.params).id, type);
  });

  app.post("/api/requests/:id/coi", async (req) => {
    const b = z.object({ questionId: z.string(), answer: z.enum(["yes", "no"]), detail: z.string().max(4000).optional() }).parse(req.body);
    if (b.answer === "yes" && !b.detail?.trim()) throw new HttpError(400, "Please give the details of a yes in your own words.");
    await answerCoi(requireTenantUser(req), id.parse(req.params).id, b.questionId, b.answer, b.detail);
    return { ok: true };
  });

  app.post("/api/requests/:id/attestations", async (req) => {
    const b = z.object({ attestationId: z.string(), typedName: z.string().max(200).optional() }).parse(req.body);
    await attest(requireTenantUser(req), id.parse(req.params).id, b.attestationId, b.typedName);
    return { ok: true };
  });

  app.post("/api/requests/:id/flags", async (req) => {
    const b = z.object({ ruleId: z.string(), choice: z.string(), note: z.string().max(2000).optional() }).parse(req.body);
    await acknowledge(requireTenantUser(req), id.parse(req.params).id, b.ruleId, b.choice, b.note);
    return { ok: true };
  });

  app.get("/api/requests/:id/preview", async (req) => preview(requireTenantUser(req), id.parse(req.params).id));
  app.post("/api/requests/:id/submit", async (req) => submit(requireTenantUser(req), id.parse(req.params).id));

  app.post("/api/requests/:id/info/:infoId", async (req) => {
    const { id: rid, infoId } = z.object({ id: z.string().uuid(), infoId: z.string().uuid() }).parse(req.params);
    const b = z.object({ answers: z.array(z.object({ questionId: z.string(), answer: z.string().max(4000), documentIds: z.array(z.string().uuid()).max(20).optional() })) }).parse(req.body);
    await answerInfo(requireTenantUser(req), rid, infoId, b.answers);
    return { ok: true };
  });

  app.post("/api/policy/ask", async (req) => {
    const { question } = z.object({ question: z.string().min(2).max(1000) }).parse(req.body);
    return askPolicy(requireTenantUser(req), question);
  });

  // ─── Internal seats ───
  const internal = ["coordinator", "medical-reviewer", "compliance-reviewer", "legal", "committee-member", "committee-chair", "finance", "tax", "compliance-auditor", "process-owner"] as const;

  app.get("/api/desk", async (req) => desk(requireRole(req, [...internal])));
  app.get("/api/requests/:id/brief", async (req) => brief(requireRole(req, [...internal]), id.parse(req.params).id));

  app.post("/api/requests/:id/act", async (req) => {
    const u = requireRole(req, [...internal]);
    const b = z.object({ outcome: z.string(), reason: z.string().max(4000).optional(), groupId: z.string().optional(), note: z.string().max(4000).optional(), form: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    await act(u, id.parse(req.params).id, b.outcome, b);
    return { ok: true };
  });

  app.post("/api/requests/:id/judgements", async (req) => {
    const u = requireRole(req, ["coordinator", "medical-reviewer", "compliance-reviewer", "committee-member", "committee-chair"]);
    const b = z.object({ ruleId: z.string(), decision: z.string(), note: z.string().max(4000).optional() }).parse(req.body);
    await judge(u, id.parse(req.params).id, b.ruleId, b.decision, b.note);
    return { ok: true };
  });

  app.post("/api/requests/:id/info-request", async (req) => {
    const u = requireRole(req, ["coordinator", "medical-reviewer", "compliance-reviewer"]);
    const b = z.object({ questions: z.array(z.string().max(2000)).min(1).max(10), dueDays: z.number().int().min(1).max(60).optional() }).parse(req.body);
    await requestInfo(u, id.parse(req.params).id, b.questions, b.dueDays);
    return { ok: true };
  });

  app.get("/api/committee/members", async (req) => {
    const u = requireRole(req, [...internal]);
    return asUser(u, (tx) => committeeMembers(tx, u.tenantId!));
  });

  app.post("/api/requests/:id/decision", async (req) => {
    const u = requireRole(req, ["committee-member", "committee-chair"]);
    const b = z.object({
      outcome: z.enum(["approve", "approve-with-conditions", "decline", "defer"]), amount: z.number().positive().optional(), conditions: z.string().max(4000).optional(), rationale: z.string().min(1).max(8000),
      votes: z.array(z.object({ memberId: z.string(), vote: z.enum(["for", "against", "abstain"]) })).optional(),
      recusals: z.array(z.object({ memberId: z.string(), reason: z.string() })).optional(), meetingId: z.string().uuid().optional(),
    }).parse(req.body);
    await decide(u, id.parse(req.params).id, b);
    return { ok: true };
  });
}

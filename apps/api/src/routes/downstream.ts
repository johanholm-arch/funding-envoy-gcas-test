// Agreements, payments, reconciliation and disclosure.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole, requireTenantUser } from "../auth.ts";
import { agreementView, certifyAgreement, classifyTransfer, createAgreement, paymentDetail, paymentsList, releasePayment, sendAgreement, signAgreement, submitReconciliation } from "../services/contracting.ts";
import { calendar, disclosureFile, readiness, submitDisclosure } from "../services/disclosure.ts";
import { autoAdvance } from "../services/workflow.ts";

const id = z.object({ id: z.string().uuid() });

export async function downstreamRoutes(app: FastifyInstance) {
  app.get("/api/requests/:id/agreement", async (req) => agreementView(requireTenantUser(req), id.parse(req.params).id));
  app.post("/api/requests/:id/agreement", async (req) => ({ agreement: await createAgreement(requireRole(req, ["legal", "coordinator"]), id.parse(req.params).id) }));
  app.post("/api/requests/:id/agreement/send", async (req) => { await sendAgreement(requireRole(req, ["legal", "coordinator"]), id.parse(req.params).id); return { ok: true }; });
  app.post("/api/requests/:id/agreement/sign", async (req) => {
    const { typedName } = z.object({ typedName: z.string().min(2).max(200) }).parse(req.body);
    await signAgreement(requireTenantUser(req), id.parse(req.params).id, typedName);
    return { ok: true };
  });
  app.post("/api/requests/:id/agreement/certify", async (req) => { await certifyAgreement(requireRole(req, ["medical-reviewer", "legal"]), id.parse(req.params).id); return { ok: true }; });

  app.get("/api/payments", async (req) => paymentsList(requireRole(req, ["finance", "coordinator", "tax", "compliance-auditor"])));
  app.get("/api/requests/:id/payment", async (req) => paymentDetail(requireRole(req, ["finance", "coordinator", "tax", "compliance-auditor"]), id.parse(req.params).id));
  app.post("/api/requests/:id/payments/:paymentId/release", async (req) => {
    const p = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() }).parse(req.params);
    const u = requireRole(req, ["finance"]);
    await releasePayment(u, p.id, p.paymentId);
    await autoAdvance(p.id, u);
    return { ok: true };
  });

  app.post("/api/requests/:id/payment/classify", async (req) => {
    const b = z.object({ natureOfPayment: z.string().min(2), disclosureCategory: z.string().min(2) }).parse(req.body);
    await classifyTransfer(requireRole(req, ["finance", "tax"]), id.parse(req.params).id, b);
    return { ok: true };
  });

  app.post("/api/requests/:id/reconciliation", async (req) => {
    const b = z.object({ actualTotal: z.number().nonnegative(), attendees: z.number().int().nonnegative().optional(), unusedFunds: z.number().nonnegative(), notes: z.string().max(4000).optional(), outcomesSummary: z.string().max(8000).optional() }).parse(req.body);
    await submitReconciliation(requireTenantUser(req), id.parse(req.params).id, b);
    return { ok: true };
  });

  app.get("/api/disclosure", async (req) => readiness(requireRole(req, ["finance", "compliance-auditor", "process-owner", "coordinator", "tax"])));
  app.get("/api/calendar", async (req) => calendar(requireRole(req, ["finance", "compliance-auditor", "process-owner", "coordinator", "tax"])));
  app.get("/api/disclosure/:regime/:period/file", async (req, reply) => {
    const p = z.object({ regime: z.string(), period: z.string().regex(/^\d{4}(-H[12])?$/) }).parse(req.params);
    const f = await disclosureFile(requireRole(req, ["finance", "compliance-auditor", "process-owner"]), p.regime, p.period);
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${f.filename}"`);
    return f.body;
  });
  app.post("/api/disclosure/:regime/:period/submit", async (req) => {
    const p = z.object({ regime: z.string(), period: z.string() }).parse(req.params);
    return submitDisclosure(requireRole(req, ["finance", "compliance-auditor", "process-owner"]), p.regime, p.period);
  });
}

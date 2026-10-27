import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { anchorChain, eventsForRequest, verifyTenantChain } from "@fe/db";
import { asUser, requireRole, requireTenantUser } from "../auth.ts";

export async function auditRoutes(app: FastifyInstance) {
  // The trail of one request. Requestors see their own request's trail; internal seats see everything.
  app.get("/api/requests/:id/trail", async (req) => {
    const u = requireTenantUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return asUser(u, async (tx) => {
      const events = await eventsForRequest(tx, u.tenantId!, id);
      const counts = { people: 0, agent: 0, system: 0 };
      for (const e of events) {
        if (e.actor.type === "person") counts.people++;
        else if (e.actor.type === "agent") counts.agent++;
        else counts.system++;
      }
      return { events, counts };
    });
  });

  app.get("/api/audit/verify", async (req) => {
    const u = requireRole(req, ["compliance-auditor", "process-owner", "coordinator"]);
    return asUser(u, async (tx) => ({ ...(await verifyTenantChain(tx, u.tenantId!)), verifiedAt: new Date().toISOString() }));
  });

  app.post("/api/audit/anchor", async (req) => {
    const u = requireRole(req, ["compliance-auditor", "process-owner"]);
    return asUser(u, async (tx) => ({ anchored: await anchorChain(tx, u.tenantId!) }));
  });

  // Signed export for an auditor: the events plus a verification report.
  app.get("/api/requests/:id/trail/export", async (req, reply) => {
    const u = requireRole(req, ["compliance-auditor", "process-owner", "coordinator"]);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = await asUser(u, async (tx) => {
      const events = await eventsForRequest(tx, u.tenantId!, id);
      const chain = await verifyTenantChain(tx, u.tenantId!);
      return { exportedAt: new Date().toISOString(), exportedBy: u.name, requestId: id, chainVerification: chain, events };
    });
    reply.header("content-type", "application/json").header("content-disposition", `attachment; filename="trail-${id}.json"`);
    return body;
  });
}

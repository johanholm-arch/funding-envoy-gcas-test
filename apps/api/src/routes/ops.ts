import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { crossQueue, fleet, passports, ruleLibrary, switchTenant } from "../services/ops.ts";

export async function opsRoutes(app: FastifyInstance) {
  app.get("/api/ops/fleet", async (req) => fleet(requireUser(req)));
  app.get("/api/ops/queue", async (req) => crossQueue(requireUser(req)));
  app.get("/api/ops/library", async (req) => ruleLibrary(requireUser(req)));
  app.get("/api/ops/passports", async (req) => passports(requireUser(req)));
  app.post("/api/ops/switch", async (req) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid().nullable() }).parse(req.body);
    await switchTenant(requireUser(req), tenantId);
    return { ok: true };
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.ts";
import { liveView, readLive, removeCredentials, saveCredentials, testLive } from "../services/connector-live.ts";
import { connectView, readOrg, saveConfig, simAct, simConsole, testConnection, trialRun, type ConnectorConfig } from "../services/connector.ts";

const view = ["process-owner", "operator", "compliance-auditor", "coordinator"] as const;
const edit = ["process-owner", "operator"] as const;

export async function connectorRoutes(app: FastifyInstance) {
  // Studio: connecting the funder's Salesforce org and matching its fields.
  app.get("/api/connect/salesforce", async (req) => {
    const u = requireRole(req, [...view]);
    return { ...(await connectView(u)), live: await liveView(u) };
  });
  // The company's real org, read-only for now: credentials, a test, and a reading of its objects.
  app.post("/api/connect/salesforce/live/credentials", async (req) => {
    const b = z.object({ myDomain: z.string().min(3).max(200), clientId: z.string().max(300).optional(), clientSecret: z.string().max(300).optional() }).parse(req.body);
    return saveCredentials(requireRole(req, [...edit]), b);
  });
  app.post("/api/connect/salesforce/live/remove", async (req) => removeCredentials(requireRole(req, [...edit])));
  app.post("/api/connect/salesforce/live/test", async (req) => testLive(requireRole(req, [...edit])));
  app.post("/api/connect/salesforce/live/read", async (req) => readLive(requireRole(req, [...edit])));
  app.post("/api/connect/salesforce/test", async (req) => {
    const b = z.object({ mode: z.enum(["simulated", "live"]), myDomain: z.string().max(120) }).parse(req.body);
    return testConnection(requireRole(req, [...edit]), b);
  });
  app.post("/api/connect/salesforce/read", async (req) => {
    const b = z.object({ myDomain: z.string().max(120).optional() }).parse(req.body ?? {});
    return readOrg(requireRole(req, [...edit]), b.myDomain);
  });
  app.post("/api/connect/salesforce/config", async (req) => {
    const b = z.object({ config: z.record(z.string(), z.unknown()) }).parse(req.body);
    return saveConfig(requireRole(req, [...edit]), b.config as unknown as ConnectorConfig);
  });
  app.post("/api/connect/salesforce/trial", async (req) => {
    const b = z.object({ config: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
    return trialRun(requireRole(req, [...edit]), b.config as unknown as ConnectorConfig | undefined);
  });
  // The simulated org's own screens, for showing what the grants team sees in Salesforce.
  app.get("/api/salesforce-sim", async (req) => simConsole(requireRole(req, [...view, "committee-chair"])));
  app.post("/api/salesforce-sim/requests/:id/act", async (req) => {
    const p = z.object({ id: z.string().min(15).max(18) }).parse(req.params);
    const b = z.object({ action: z.enum(["request-info", "approve", "decline", "comment"]), text: z.string().max(4000).optional(), amount: z.number().positive().optional() }).parse(req.body);
    return simAct(requireRole(req, ["coordinator", "process-owner", "committee-chair", "operator"]), p.id, b);
  });
}

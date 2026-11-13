import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.ts";
import { chooseRequestObject, connectPractice, findRequests, mappingView, saveMapping, searchRequests, wizardState } from "../services/connect-wizard.ts";
import { liveReading, liveView, readLive, removeCredentials, saveCredentials, testLive } from "../services/connector-live.ts";
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
  // The Connect wizard: connect, find where grant requests live, match the details.
  app.get("/api/connect/salesforce/wizard", async (req) => wizardState(requireRole(req, [...view])));
  app.post("/api/connect/salesforce/practice/connect", async (req) => connectPractice(requireRole(req, [...edit])));
  app.post("/api/connect/salesforce/live/find", async (req) => findRequests(requireRole(req, [...edit])));
  app.get("/api/connect/salesforce/live/search", async (req) => {
    const q = z.object({ q: z.string().max(80) }).parse(req.query);
    return searchRequests(requireRole(req, [...edit]), q.q);
  });
  app.post("/api/connect/salesforce/live/choose", async (req) => {
    const b = z.object({ name: z.string().min(1).max(90) }).parse(req.body);
    return chooseRequestObject(requireRole(req, [...edit]), b.name);
  });
  app.get("/api/connect/salesforce/mapping", async (req) => {
    const q = z.object({ mode: z.enum(["simulated", "live"]) }).parse(req.query);
    return mappingView(requireRole(req, [...view]), q.mode);
  });
  app.post("/api/connect/salesforce/mapping", async (req) => {
    const b = z.object({ mode: z.enum(["simulated", "live"]), config: z.record(z.string(), z.unknown()) }).parse(req.body);
    return saveMapping(requireRole(req, [...edit]), b.mode, b.config as unknown as ConnectorConfig);
  });
  app.get("/api/connect/salesforce/live/reading", async (req, reply) => {
    const r = await liveReading(requireRole(req, [...view]));
    if ((req.query as { download?: string }).download) reply.header("content-disposition", `attachment; filename="salesforce-reading-${new Date().toISOString().slice(0, 10)}.json"`);
    return r;
  });
  app.post("/api/connect/salesforce/live/read", async (req) => {
    const b = z.object({ prefixes: z.array(z.string().max(60)).max(5).optional(), objects: z.array(z.string().max(90)).max(20).optional() }).parse(req.body ?? {});
    return readLive(requireRole(req, [...edit]), b.prefixes ?? [], b.objects ?? []);
  });
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

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole, requireTenantUser } from "../auth.ts";
import type { ConfigKind } from "../config.ts";
import { ask, library } from "../services/ask.ts";
import { autonomyView, createDraft, diff, discardDraft, draftFromSop, getVersion, LOGO_MAX_BYTES, logoFor, overview, publish, runTests, storeLogo, updateDraft, validate, versions } from "../services/studio.ts";

const kind = z.enum(["catalogue", "rulebook", "workflow", "autonomy", "brand", "words", "policy", "sop", "testset"]);
const studioRoles = ["process-owner", "operator", "compliance-auditor"] as const;
const editRoles = ["process-owner", "operator"] as const;

export async function studioRoutes(app: FastifyInstance) {
  const askRoles = ["coordinator", "medical-reviewer", "compliance-reviewer", "legal", "committee-member", "committee-chair", "finance", "tax", "compliance-auditor", "process-owner", "operator"] as const;
  app.get("/api/ask/library", async (req) => { requireRole(req, [...askRoles]); return library(); });
  app.post("/api/ask", async (req) => {
    const { question } = z.object({ question: z.string().min(3).max(500) }).parse(req.body);
    return ask(requireRole(req, [...askRoles]), question);
  });

  app.get("/api/studio", async (req) => overview(requireRole(req, [...studioRoles])));

  // Logo: upload one file; it is referenced by the brand draft that is saved next.
  app.post("/api/studio/brand/logo", async (req) => {
    const u = requireRole(req, [...editRoles]);
    const part = await req.file({ limits: { fileSize: LOGO_MAX_BYTES + 1 } });
    if (!part) throw new HttpError(400, "Choose an image to upload.");
    const buf = await part.toBuffer();
    return storeLogo(u, { buf, mime: part.mimetype, name: part.filename });
  });
  // The funder's logo for whoever is signed in; ?v= shows a draft's logo in Studio.
  app.get("/api/tenant/logo", async (req, reply) => {
    const u = requireTenantUser(req);
    const q = z.object({ v: z.coerce.number().int().optional() }).parse(req.query);
    const logo = await logoFor(u, q.v);
    if (!logo) throw new HttpError(404, "No logo.");
    // SVG can carry script; this policy and sandbox stop it from running even if the file is opened directly.
    reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "private, max-age=86400");
    return reply.type(logo.mime).send(logo.buf);
  });
  app.get("/api/studio/autonomy", async (req) => autonomyView(requireRole(req, [...studioRoles])));
  app.get("/api/studio/tests", async (req) => {
    const q = z.object({ rulebook: z.coerce.number().int().optional(), catalogue: z.coerce.number().int().optional() }).parse(req.query);
    return runTests(requireRole(req, [...studioRoles]), { rulebookVersion: q.rulebook, catalogueVersion: q.catalogue });
  });
  app.post("/api/studio/sop", async (req) => {
    const b = z.object({ title: z.string().min(3).max(200), markdown: z.string().min(50).max(400_000) }).parse(req.body);
    return draftFromSop(requireRole(req, [...editRoles]), b);
  });
  app.get("/api/studio/:kind", async (req) => {
    const p = z.object({ kind }).parse(req.params);
    return versions(requireRole(req, [...studioRoles]), p.kind as ConfigKind);
  });
  app.get("/api/studio/:kind/:version", async (req) => {
    const p = z.object({ kind, version: z.union([z.literal("published"), z.coerce.number().int()]) }).parse(req.params);
    return getVersion(requireRole(req, [...studioRoles]), p.kind as ConfigKind, p.version === "published" ? undefined : p.version);
  });
  app.post("/api/studio/:kind/drafts", async (req) => {
    const p = z.object({ kind }).parse(req.params);
    const b = z.object({ note: z.string().max(500).optional(), body: z.unknown().optional() }).parse(req.body ?? {});
    return createDraft(requireRole(req, [...editRoles]), p.kind as ConfigKind, b.note, b.body);
  });
  app.put("/api/studio/:kind/:version", async (req) => {
    const p = z.object({ kind, version: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ body: z.unknown() }).parse(req.body);
    return updateDraft(requireRole(req, [...editRoles]), p.kind as ConfigKind, p.version, b.body);
  });
  app.delete("/api/studio/:kind/:version", async (req) => {
    const p = z.object({ kind, version: z.coerce.number().int() }).parse(req.params);
    return discardDraft(requireRole(req, [...editRoles]), p.kind as ConfigKind, p.version);
  });
  app.get("/api/studio/:kind/:version/validate", async (req) => {
    const p = z.object({ kind, version: z.coerce.number().int() }).parse(req.params);
    return validate(requireRole(req, [...studioRoles]), p.kind as ConfigKind, p.version);
  });
  app.get("/api/studio/:kind/diff/:from/:to", async (req) => {
    const p = z.object({ kind, from: z.coerce.number().int(), to: z.coerce.number().int() }).parse(req.params);
    return diff(requireRole(req, [...studioRoles]), p.kind as ConfigKind, p.from, p.to);
  });
  app.post("/api/studio/:kind/:version/publish", async (req) => {
    const p = z.object({ kind, version: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ typedName: z.string().min(2), acceptDifferences: z.string().max(2000).optional() }).parse(req.body);
    return publish(requireRole(req, ["process-owner"]), p.kind as ConfigKind, p.version, b);
  });
}

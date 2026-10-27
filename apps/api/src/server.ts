import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { one, withContext } from "@fe/db";
import { HttpError, sessionHook } from "./auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { requestRoutes } from "./routes/requests.ts";
import { auditRoutes } from "./routes/audit.ts";
import { downstreamRoutes } from "./routes/downstream.ts";
import { studioRoutes } from "./routes/studio.ts";

export async function buildServer(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  if (process.env.NODE_ENV === "production") {
    const reset = await withContext({}, (tx) => one<{ n: number }>(tx, "select count(*)::int as n from pg_proc where proname = 'fe_demo_reset_tenant'"));
    if (reset?.n) throw new Error("Refusing to start: the demo reset function exists in a production database.");
    if (!process.env.FE_COOKIE_SECRET) throw new Error("FE_COOKIE_SECRET must be set in production.");
  }
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie, { secret: process.env.FE_COOKIE_SECRET ?? "fundingenvoy-demo-secret-change-me" });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
  app.addHook("onRequest", sessionHook);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err instanceof ZodError) return reply.status(400).send({ error: "Some fields are missing or invalid.", code: "invalid", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: err.message, code: "error" });
    app.log.error(err);
    return reply.status(500).send({ error: "Something went wrong on our side. It has been logged.", code: "internal", ...(process.env.NODE_ENV === "production" ? {} : { detail: (err as Error).message }) });
  });

  app.get("/api/health", async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(requestRoutes);
  await app.register(auditRoutes);
  await app.register(downstreamRoutes);
  await app.register(studioRoutes);

  // Serve the built web app when present.
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(web)) {
    await app.register(fastifyStatic, { root: web, prefix: "/", wildcard: false });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.status(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
  }
  return app;
}

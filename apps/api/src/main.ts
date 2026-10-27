import cluster from "node:cluster";
import { generateKeyPairSync } from "node:crypto";
import { closePool } from "@fe/db";

// FE_WORKERS > 1 runs that many server processes sharing the port (one per core is typical). Sessions, the audit
// chain and configuration live in the database, so any worker can serve any request.
const workers = Number(process.env.FE_WORKERS ?? 1);

if (workers > 1 && cluster.isPrimary) {
  process.env.FE_DEMO_IDP_KEY ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on("exit", (w, code) => { if (code !== 0) { console.error(`worker ${w.process.pid} exited (${code}); starting another`); cluster.fork(); } });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { for (const w of Object.values(cluster.workers ?? {})) w?.process.kill(sig); setTimeout(() => process.exit(0), 3000).unref(); });
} else {
  const { buildServer } = await import("./server.ts");
  const port = Number(process.env.PORT ?? 8787);
  const app = await buildServer({ logger: process.env.FE_LOG !== "0" });
  await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
  // Finish in-flight requests, release database connections, then exit.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, async () => {
      await app.close().catch(() => {});
      await closePool().catch(() => {});
      process.exit(0);
    });
  }
}

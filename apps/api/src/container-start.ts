// What the container runs when it starts (see Dockerfile and deploy/azure/GUIDE.md):
//   1. applies database migrations as the database administrator;
//   2. gives the application's own database account (fe_app) its private password;
//   3. loads the demo (tenants, people, documents, scenario) the first time, or again when FE_RESEED_TOKEN changes;
//   4. starts the web server.
//
// Database settings come either as two full URLs (DATABASE_ADMIN_URL, DATABASE_URL) or as parts:
//   FE_DB_HOST, FE_DB_NAME (default fundingenvoy), FE_DB_ADMIN_USER, FE_DB_ADMIN_PASSWORD, FE_DB_APP_PASSWORD,
//   FE_DB_SSL (require by default; "disable" for a local database).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env: NodeJS.ProcessEnv = { ...process.env };
const log = (m: string) => console.log(`[start] ${m}`);

function dbUrl(user: string, password: string): string {
  const host = need("FE_DB_HOST");
  const name = env.FE_DB_NAME ?? "fundingenvoy";
  const ssl = (env.FE_DB_SSL ?? "require") === "disable" ? "" : "?sslmode=require";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${env.FE_DB_PORT ?? "5432"}/${name}${ssl}`;
}

function need(name: string): string {
  const v = env[name];
  if (!v) { console.error(`[start] Missing setting ${name}. See deploy/azure/GUIDE.md.`); process.exit(1); }
  return v;
}

function run(label: string, file: string): Promise<void> {
  log(label);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", file], { cwd: ROOT, env, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`))));
  });
}

async function main() {
  env.DATABASE_ADMIN_URL ??= dbUrl(need("FE_DB_ADMIN_USER"), need("FE_DB_ADMIN_PASSWORD"));
  const appPassword = env.FE_DB_APP_PASSWORD;
  env.DATABASE_URL ??= dbUrl("fe_app", appPassword ?? "fe_app_dev");
  env.FE_UPLOADS ??= "/data/uploads";
  mkdirSync(env.FE_UPLOADS, { recursive: true });

  // The database server can take a minute to accept connections after it is created or restarted. If the server is
  // up but the database doesn't exist yet, create it as the administrator, so the administrator owns its schema.
  for (let i = 1; ; i++) {
    const c = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
    try { await c.connect(); await c.end(); break; } catch (e) {
      if ((e as { code?: string }).code === "3D000") {
        const u = new URL(env.DATABASE_ADMIN_URL);
        const dbName = decodeURIComponent(u.pathname.slice(1));
        u.pathname = "/postgres";
        const root = new pg.Client({ connectionString: u.toString() });
        await root.connect();
        const { rows } = await root.query<{ sql: string }>("select format('create database %I', $1::text) as sql", [dbName]);
        await root.query(rows[0]!.sql);
        await root.end();
        log(`created database ${dbName}`);
        continue;
      }
      if (i >= 30) throw e;
      log(`waiting for the database (${(e as Error).message})`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  await run("applying database migrations", "packages/db/src/migrate.ts");

  const admin = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
  await admin.connect();
  if (appPassword) {
    const { rows } = await admin.query<{ sql: string }>("select format('alter role fe_app password %L', $1::text) as sql", [appPassword]);
    await admin.query(rows[0]!.sql);
    log("application database account ready");
  }
  // Tenant tables enforce row-level security even for their owner, so look as the platform operator.
  await admin.query("begin");
  await admin.query("select set_config('app.operator', 'on', true)");
  const seeded = (await admin.query("select 1 from tenants where slug = 'halden'")).rowCount === 1;
  await admin.query("commit");
  await admin.end();

  const marker = path.join(path.dirname(env.FE_UPLOADS), "demo-seed-token");
  const lastToken = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  const wanted = env.FE_RESEED_TOKEN ?? "";
  // The marker is written only after a complete load, so a load interrupted part-way is redone on the next start.
  const complete = seeded && existsSync(marker);
  if (!complete || (wanted && wanted !== lastToken)) {
    await run(!seeded ? "loading the demo for the first time" : !complete ? "finishing an interrupted demo load" : "resetting the demo (new FE_RESEED_TOKEN)", "apps/api/src/seed.ts");
    await run("placing demo requests at review, committee and payment", "apps/api/src/scenario.ts");
    writeFileSync(marker, wanted);
  } else log("demo already loaded");

  log(`starting the server on port ${env.PORT ?? "8787"}`);
  const server = spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], { cwd: ROOT, env, stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.kill(sig));
  server.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => { console.error("[start] could not start:", e); process.exit(1); });

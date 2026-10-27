// Applies SQL migrations in order as the database owner (DATABASE_ADMIN_URL).
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres@localhost:5432/fundingenvoy?host=/tmp"): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(DIR, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [f]);
        await client.query("commit");
        applied.push(f);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().then((a) => console.log(a.length ? `Applied: ${a.join(", ")}` : "Up to date")).catch((e) => { console.error(e.message); process.exit(1); });
}

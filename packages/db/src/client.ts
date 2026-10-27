import pg from "pg";

// numeric → number (amounts are well inside double precision for this domain)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// int8 → number (event seq)
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// date → ISO string, not a JS Date shifted by timezone
pg.types.setTypeParser(1082, (v) => v);

export interface DbContext {
  tenantId?: string | null;
  orgId?: string | null;
  operator?: boolean;
}

export type Tx = pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? "postgres://fe_app:fe_app_dev@localhost:5432/fundingenvoy?host=/tmp",
      max: Number(process.env.DB_POOL_MAX ?? 20),
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Run `fn` in one transaction with the row-level-security context set.
 * The context is SET LOCAL, so it cannot leak to another request through the pool.
 */
export async function withContext<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.org_id', $2, true), set_config('app.operator', $3, true)",
      [ctx.tenantId ?? "", ctx.orgId ?? "", ctx.operator ? "on" : ""],
    );
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await tx.query<T>(sql, params)).rows[0];
}

export async function many<T extends pg.QueryResultRow>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query<T>(sql, params)).rows;
}

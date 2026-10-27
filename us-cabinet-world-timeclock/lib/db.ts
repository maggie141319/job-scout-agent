import "server-only";
import { Pool, types, type PoolClient, type QueryResultRow } from "pg";
import { requireEnv } from "./config";

// Keep DATE columns as 'YYYY-MM-DD' strings (no implicit local-time conversion).
types.setTypeParser(1082, (v: string) => v);

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

const globalForPool = globalThis as unknown as { __uscwPool?: Pool };

export function getPool(): Pool {
  if (!globalForPool.__uscwPool) {
    globalForPool.__uscwPool = new Pool({
      connectionString: requireEnv("DATABASE_URL"),
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForPool.__uscwPool;
}

export async function query<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
  const res = await getPool().query<R>(text, params);
  return res.rows;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Closes the pool (used by tests and scripts). */
export async function closePool(): Promise<void> {
  if (globalForPool.__uscwPool) {
    await globalForPool.__uscwPool.end();
    globalForPool.__uscwPool = undefined;
  }
}

import "server-only";
import type { Queryable } from "../db";

/** Fixed-window failure counter stored in Postgres (works across serverless instances). */
export async function isRateLimited(db: Queryable, key: string, limit: number, windowSeconds: number, now: Date): Promise<boolean> {
  const res = await db.query<{ count: number }>(
    `select count from rate_limits where key = $1 and window_start > $2`,
    [key, new Date(now.getTime() - windowSeconds * 1000)],
  );
  return (res.rows[0]?.count ?? 0) >= limit;
}

export async function recordFailure(db: Queryable, key: string, windowSeconds: number, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - windowSeconds * 1000);
  const res = await db.query<{ count: number }>(
    `insert into rate_limits (key, window_start, count) values ($1, $2, 1)
     on conflict (key) do update set
       count = case when rate_limits.window_start <= $3 then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start <= $3 then $2 else rate_limits.window_start end
     returning count`,
    [key, now, cutoff],
  );
  return res.rows[0].count;
}

export async function clearRateLimit(db: Queryable, key: string): Promise<void> {
  await db.query(`delete from rate_limits where key = $1`, [key]);
}

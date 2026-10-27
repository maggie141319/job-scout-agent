import "server-only";
import type { Queryable } from "../db";

export interface Actor {
  type: "admin" | "employee" | "kiosk" | "system";
  id: string | null;
  label: string;
  ip?: string | null;
}

export async function writeAudit(
  db: Queryable,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | null,
  data: { before?: unknown; after?: unknown; reason?: string | null } = {},
): Promise<void> {
  await db.query(
    `insert into audit_log (actor_type, actor_id, actor_label, action, entity_type, entity_id, reason, before, after, ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor.type,
      actor.id,
      actor.label,
      action,
      entityType,
      entityId,
      data.reason ?? null,
      data.before === undefined ? null : JSON.stringify(data.before),
      data.after === undefined ? null : JSON.stringify(data.after),
      actor.ip ?? null,
    ],
  );
}

export interface AuditEntry {
  id: string;
  occurred_at: Date;
  actor_type: string;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
}

export async function listAudit(db: Queryable, opts: { limit?: number; entityId?: string } = {}): Promise<AuditEntry[]> {
  const params: unknown[] = [Math.min(opts.limit ?? 200, 1000)];
  let where = "";
  if (opts.entityId) {
    params.push(opts.entityId);
    where = "where entity_id = $2";
  }
  const res = await db.query<AuditEntry>(
    `select id, occurred_at, actor_type, actor_label, action, entity_type, entity_id, reason, before, after
     from audit_log ${where} order by occurred_at desc, id desc limit $1`,
    params,
  );
  return res.rows;
}

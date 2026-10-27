import "server-only";
import type { Queryable } from "../db";
import { AppError } from "../errors";
import { hashToken, newToken } from "../security";
import { writeAudit, type Actor } from "./audit";

export interface KioskDevice {
  id: string;
  name: string;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

/** Authorizes the current browser as a shared kiosk. The token is returned once and stored only as a hash. */
export async function registerKiosk(db: Queryable, name: string, actor: Actor): Promise<{ token: string; device: KioskDevice }> {
  if (actor.type !== "admin" || !actor.id) throw new AppError("FORBIDDEN", "Not allowed.", 403);
  const clean = name.trim().slice(0, 60);
  if (clean.length < 2) throw new AppError("INVALID_INPUT", "Give the kiosk a name, e.g. Warehouse Tablet.");
  const token = newToken();
  const res = await db.query<KioskDevice>(
    `insert into kiosk_devices (name, token_hash, created_by) values ($1, $2, $3) returning id, name, created_at, last_seen_at, revoked_at`,
    [clean, hashToken(token), actor.id],
  );
  await writeAudit(db, actor, "kiosk.register", "kiosk_device", res.rows[0].id, { after: { name: clean } });
  return { token, device: res.rows[0] };
}

export async function kioskByToken(db: Queryable, token: string | undefined): Promise<KioskDevice | null> {
  if (!token || token.length > 200) return null;
  const res = await db.query<KioskDevice>(
    `update kiosk_devices set last_seen_at = now() where token_hash = $1 and revoked_at is null
     returning id, name, created_at, last_seen_at, revoked_at`,
    [hashToken(token)],
  );
  return res.rows[0] ?? null;
}

export async function listKiosks(db: Queryable): Promise<KioskDevice[]> {
  const res = await db.query<KioskDevice>(`select id, name, created_at, last_seen_at, revoked_at from kiosk_devices order by revoked_at nulls first, created_at desc`);
  return res.rows;
}

export async function revokeKiosk(db: Queryable, id: string, actor: Actor): Promise<void> {
  const res = await db.query(`update kiosk_devices set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null`, [id, actor.id]);
  if (!res.rowCount) throw new AppError("NOT_FOUND", "Kiosk not found or already revoked.", 404);
  await writeAudit(db, actor, "kiosk.revoke", "kiosk_device", id);
}

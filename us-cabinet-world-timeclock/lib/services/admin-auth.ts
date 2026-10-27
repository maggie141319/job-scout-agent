import "server-only";
import type { Queryable } from "../db";
import { AppError } from "../errors";
import { hashPassword, hashToken, MIN_PASSWORD_LENGTH, newToken, verifyPassword } from "../security";
import { writeAudit, type Actor } from "./audit";
import { isRateLimited, recordFailure } from "./rate-limit";

export type AdminRole = "admin" | "manager";

export interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  role: AdminRole;
  active: boolean;
}

export const SESSION_TTL_HOURS = 12;
const LOCK_AFTER_FAILURES = 5;
const LOCK_MINUTES = 15;
const IP_FAILURE_LIMIT = 20;
const IP_WINDOW_S = 15 * 60;

// Used to keep timing similar when the username does not exist.
let dummyHash: Promise<string> | null = null;

export async function login(
  db: Queryable,
  usernameInput: string,
  password: string,
  client: { ip: string; userAgent: string | null },
  now = new Date(),
): Promise<{ token: string; user: AdminUser; expiresAt: Date }> {
  const username = usernameInput.trim().toLowerCase();
  const ipKey = `admin-login:ip:${client.ip}`;
  if (await isRateLimited(db, ipKey, IP_FAILURE_LIMIT, IP_WINDOW_S, now)) {
    throw new AppError("RATE_LIMITED", "Too many failed sign-in attempts. Try again in 15 minutes.", 429);
  }
  const res = await db.query<AdminUser & { password_hash: string; locked_until: Date | null; failed_logins: number }>(
    `select id, username, display_name, role, active, password_hash, locked_until, failed_logins from admin_users where username = $1`,
    [username],
  );
  const user = res.rows[0];
  const generic = new AppError("INVALID_LOGIN", "Incorrect username or password.", 401);
  if (!user) {
    dummyHash ??= hashPassword("not-a-real-password-placeholder");
    await verifyPassword(password, await dummyHash);
    await recordFailure(db, ipKey, IP_WINDOW_S, now);
    throw generic;
  }
  if (user.locked_until && user.locked_until > now) {
    throw new AppError("LOCKED", "Account temporarily locked after failed attempts. Try again later.", 423);
  }
  const ok = user.active && (await verifyPassword(password, user.password_hash));
  if (!ok) {
    await recordFailure(db, ipKey, IP_WINDOW_S, now);
    const failures = user.failed_logins + 1;
    await db.query(`update admin_users set failed_logins = $2, locked_until = $3 where id = $1`, [
      user.id,
      failures >= LOCK_AFTER_FAILURES ? 0 : failures,
      failures >= LOCK_AFTER_FAILURES ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null,
    ]);
    throw generic;
  }
  await db.query(`update admin_users set failed_logins = 0, locked_until = null where id = $1`, [user.id]);
  const token = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 3600_000);
  await db.query(
    `insert into admin_sessions (admin_user_id, token_hash, expires_at, ip, user_agent) values ($1, $2, $3, $4, $5)`,
    [user.id, hashToken(token), expiresAt, client.ip.slice(0, 64), client.userAgent?.slice(0, 300) ?? null],
  );
  await writeAudit(db, { type: "admin", id: user.id, label: user.display_name, ip: client.ip }, "admin.login", "admin_user", user.id);
  const { id, display_name, role, active } = user;
  return { token, user: { id, username: user.username, display_name, role, active }, expiresAt };
}

export async function sessionUser(db: Queryable, token: string | undefined, now = new Date()): Promise<AdminUser | null> {
  if (!token || token.length > 200) return null;
  const res = await db.query<AdminUser & { session_id: string; last_seen_at: Date }>(
    `select u.id, u.username, u.display_name, u.role, u.active, s.id as session_id, s.last_seen_at
     from admin_sessions s join admin_users u on u.id = s.admin_user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2 and u.active`,
    [hashToken(token), now],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (now.getTime() - row.last_seen_at.getTime() > 5 * 60_000) {
    await db.query(`update admin_sessions set last_seen_at = $2 where id = $1`, [row.session_id, now]);
  }
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role, active: row.active };
}

export async function logout(db: Queryable, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.query(`update admin_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`, [hashToken(token)]);
}

export function actorFor(user: AdminUser, ip?: string | null): Actor {
  return { type: "admin", id: user.id, label: `${user.display_name} (${user.username})`, ip: ip ?? null };
}

export async function listAdminUsers(db: Queryable): Promise<AdminUser[]> {
  const res = await db.query<AdminUser>(`select id, username, display_name, role, active from admin_users order by active desc, username`);
  return res.rows;
}

export async function createAdminUser(
  db: Queryable,
  input: { username: string; displayName: string; password: string; role: AdminRole },
  actor: Actor,
): Promise<void> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new AppError("INVALID_INPUT", "Username must be 3–64 characters: letters, digits, . _ -");
  if (!["admin", "manager"].includes(input.role)) throw new AppError("INVALID_INPUT", "Invalid role.");
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new AppError("INVALID_INPUT", `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const displayName = input.displayName.trim() || username;
  const exists = await db.query(`select 1 from admin_users where username = $1`, [username]);
  if (exists.rowCount) throw new AppError("USERNAME_TAKEN", "That username is already used.");
  const res = await db.query<{ id: string }>(
    `insert into admin_users (username, display_name, password_hash, role) values ($1, $2, $3, $4) returning id`,
    [username, displayName, await hashPassword(input.password), input.role],
  );
  await writeAudit(db, actor, "admin_user.create", "admin_user", res.rows[0].id, { after: { username, display_name: displayName, role: input.role } });
}

export async function setAdminActive(db: Queryable, userId: string, active: boolean, actor: Actor): Promise<void> {
  if (userId === actor.id && !active) throw new AppError("INVALID_INPUT", "You cannot deactivate your own account.");
  const res = await db.query(`update admin_users set active = $2, updated_at = now() where id = $1`, [userId, active]);
  if (!res.rowCount) throw new AppError("NOT_FOUND", "User not found.", 404);
  if (!active) await db.query(`update admin_sessions set revoked_at = now() where admin_user_id = $1 and revoked_at is null`, [userId]);
  await writeAudit(db, actor, active ? "admin_user.reactivate" : "admin_user.deactivate", "admin_user", userId);
}

export async function changePassword(db: Queryable, userId: string, newPassword: string, actor: Actor): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) throw new AppError("INVALID_INPUT", `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const res = await db.query(`update admin_users set password_hash = $2, failed_logins = 0, locked_until = null, updated_at = now() where id = $1`, [
    userId,
    await hashPassword(newPassword),
  ]);
  if (!res.rowCount) throw new AppError("NOT_FOUND", "User not found.", 404);
  await writeAudit(db, actor, "admin_user.password_change", "admin_user", userId);
}

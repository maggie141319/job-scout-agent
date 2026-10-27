import "server-only";
import { transaction, type Queryable } from "../db";
import { AppError } from "../errors";
import { isPunchType, type PunchType } from "../punch-rules";
import { writeAudit, type Actor } from "./audit";
import { isUuid } from "./employees";
import type { PunchRow } from "./punches";

function requireReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 5) throw new AppError("INVALID_INPUT", "A reason of at least 5 characters is required for every correction.");
  return r.slice(0, 500);
}

function requireAdminActor(actor: Actor) {
  if (actor.type !== "admin" || !actor.id) throw new AppError("FORBIDDEN", "Not allowed.", 403);
}

function checkTime(at: Date, now: Date) {
  if (Number.isNaN(at.getTime())) throw new AppError("INVALID_INPUT", "Invalid date/time.");
  if (at.getTime() > now.getTime() + 5 * 60_000) throw new AppError("INVALID_INPUT", "Corrected time cannot be in the future.");
}

async function lockPunch(db: Queryable, punchId: string): Promise<PunchRow> {
  if (!isUuid(punchId)) throw new AppError("NOT_FOUND", "Punch not found.", 404);
  const res = await db.query<PunchRow>(`select * from punches where id = $1 for update`, [punchId]);
  const punch = res.rows[0];
  if (!punch) throw new AppError("NOT_FOUND", "Punch not found.", 404);
  return punch;
}

const snapshot = (p: PunchRow) => ({
  punch_type: p.punch_type,
  punched_at: p.punched_at.toISOString(),
  source: p.source,
  review_status: p.review_status,
  voided: p.voided_at !== null,
});

/** Approves or rejects a location exception. Rejection removes the punch from pay (it is voided, not deleted). */
export async function reviewException(punchId: string, decision: "approve" | "reject", note: string, actor: Actor): Promise<void> {
  requireAdminActor(actor);
  const cleanNote = note.trim().slice(0, 500);
  if (decision === "reject" && cleanNote.length < 5) throw new AppError("INVALID_INPUT", "Explain why the exception is rejected.");
  await transaction(async (db) => {
    const p = await lockPunch(db, punchId);
    if (p.review_status !== "pending") throw new AppError("ALREADY_REVIEWED", "This exception was already reviewed.", 409);
    if (decision === "approve") {
      await db.query(`update punches set review_status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3 where id = $1`, [p.id, actor.id, cleanNote || null]);
    } else {
      await db.query(
        `update punches set review_status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3,
           voided_at = now(), voided_by = $2, void_reason = $4 where id = $1`,
        [p.id, actor.id, cleanNote, `Exception rejected: ${cleanNote}`],
      );
    }
    await writeAudit(db, actor, `punch.exception_${decision}`, "punch", p.id, {
      reason: cleanNote || null,
      before: snapshot(p),
      after: { ...snapshot(p), review_status: decision === "approve" ? "approved" : "rejected", voided: decision === "reject" },
    });
  });
}

export async function addPunch(employeeId: string, type: string, at: Date, reason: string, actor: Actor, now = new Date()): Promise<string> {
  requireAdminActor(actor);
  if (!isPunchType(type)) throw new AppError("INVALID_INPUT", "Unknown punch type.");
  if (!isUuid(employeeId)) throw new AppError("NOT_FOUND", "Employee not found.", 404);
  checkTime(at, now);
  const why = requireReason(reason);
  return transaction(async (db) => {
    const emp = await db.query(`select id from employees where id = $1 for update`, [employeeId]);
    if (!emp.rowCount) throw new AppError("NOT_FOUND", "Employee not found.", 404);
    const res = await db.query<{ id: string }>(
      `insert into punches (employee_id, punch_type, punched_at, source, created_by_admin, correction_reason, geofence_result)
       values ($1, $2, $3, 'admin', $4, $5, 'not_required') returning id`,
      [employeeId, type, at, actor.id, why],
    );
    const id = res.rows[0].id;
    await writeAudit(db, actor, "punch.add", "punch", id, { reason: why, after: { employee_id: employeeId, punch_type: type, punched_at: at.toISOString() } });
    return id;
  });
}

/** Corrects a punch: the original is voided (kept for history) and a replacement is inserted. */
export async function replacePunch(punchId: string, type: string, at: Date, reason: string, actor: Actor, now = new Date()): Promise<string> {
  requireAdminActor(actor);
  if (!isPunchType(type)) throw new AppError("INVALID_INPUT", "Unknown punch type.");
  checkTime(at, now);
  const why = requireReason(reason);
  return transaction(async (db) => {
    const orig = await lockPunch(db, punchId);
    if (orig.voided_at) throw new AppError("ALREADY_VOIDED", "This punch was already voided or replaced.", 409);
    if (orig.punch_type === type && orig.punched_at.getTime() === at.getTime()) throw new AppError("INVALID_INPUT", "Nothing changed.");
    await db.query(`update punches set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1`, [orig.id, actor.id, `Corrected: ${why}`]);
    const res = await db.query<{ id: string }>(
      `insert into punches (employee_id, punch_type, punched_at, source, created_by_admin, correction_reason, replaces_punch_id,
         geofence_result, review_status)
       values ($1, $2, $3, 'admin', $4, $5, $6, 'not_required', $7) returning id`,
      // A corrected pending exception counts as reviewed by the correcting manager.
      [orig.employee_id, type as PunchType, at, actor.id, why, orig.id, orig.review_status === "pending" ? "approved" : "none"],
    );
    const id = res.rows[0].id;
    await writeAudit(db, actor, "punch.replace", "punch", orig.id, {
      reason: why,
      before: snapshot(orig),
      after: { replacement_id: id, punch_type: type, punched_at: at.toISOString() },
    });
    return id;
  });
}

export async function voidPunch(punchId: string, reason: string, actor: Actor): Promise<void> {
  requireAdminActor(actor);
  const why = requireReason(reason);
  await transaction(async (db) => {
    const orig = await lockPunch(db, punchId);
    if (orig.voided_at) throw new AppError("ALREADY_VOIDED", "This punch was already voided.", 409);
    await db.query(`update punches set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1`, [orig.id, actor.id, why]);
    await writeAudit(db, actor, "punch.void", "punch", orig.id, { reason: why, before: snapshot(orig), after: { ...snapshot(orig), voided: true } });
  });
}

export interface PendingException {
  id: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  punch_type: PunchType;
  punched_at: Date;
  exception_reason: string | null;
  gps_error: string | null;
  geofence_result: string | null;
  distance_m: number | null;
  accuracy_m: number | null;
}

export async function listPendingExceptions(db: Queryable): Promise<PendingException[]> {
  const res = await db.query<PendingException>(
    `select p.id, p.employee_id, e.first_name, e.last_name, p.punch_type, p.punched_at, p.exception_reason, p.gps_error,
            p.geofence_result, p.distance_m, p.accuracy_m
     from punches p join employees e on e.id = p.employee_id
     where p.review_status = 'pending' and p.voided_at is null order by p.punched_at`,
  );
  return res.rows;
}

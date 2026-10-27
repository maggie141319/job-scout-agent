import "server-only";
import { getPool, transaction, type Queryable } from "../db";
import { AppError } from "../errors";
import { evaluateGeofence, isValidReading, type GeofenceResult, type LocationReading } from "../geo";
import {
  allowedActions,
  currentState,
  isPunchType,
  validatePunch,
  type CurrentState,
  type PunchType,
} from "../punch-rules";
import { hashPin, isValidPinFormat } from "../security";
import { chicagoDate, chicagoMidnight, addDays } from "../time";
import { writeAudit } from "./audit";
import { isRateLimited, recordFailure } from "./rate-limit";
import { getSettings, type SiteSettings } from "./settings";

/** Failed PIN attempts allowed per client key (IP or kiosk device) per window. */
export const PIN_FAILURE_LIMIT = 15;
export const PIN_FAILURE_WINDOW_S = 15 * 60;

export interface PunchRow {
  id: string;
  employee_id: string;
  punch_type: PunchType;
  punched_at: Date;
  source: "phone" | "kiosk" | "admin";
  kiosk_device_id: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  location_age_s: number | null;
  distance_m: number | null;
  geofence_result: string | null;
  geofence_mode: string | null;
  review_status: "none" | "pending" | "approved" | "rejected";
  exception_reason: string | null;
  gps_error: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  replaces_punch_id: string | null;
  created_by_admin: string | null;
  correction_reason: string | null;
  client_request_id: string | null;
  created_at: Date;
}

interface EmployeeIdentity {
  id: string;
  first_name: string;
  last_name: string;
  active: boolean;
}

/** A punch is "effective" (counts for state and pay) unless voided or rejected. */
export const EFFECTIVE_PUNCH = "voided_at is null and review_status <> 'rejected'";

export async function lastEffectivePunch(db: Queryable, employeeId: string): Promise<PunchRow | null> {
  const res = await db.query<PunchRow>(
    `select * from punches where employee_id = $1 and ${EFFECTIVE_PUNCH} order by punched_at desc, created_at desc limit 1`,
    [employeeId],
  );
  return res.rows[0] ?? null;
}

export async function employeeState(db: Queryable, employeeId: string, now: Date, settings: SiteSettings): Promise<CurrentState> {
  const last = await lastEffectivePunch(db, employeeId);
  return currentState(last ? { type: last.punch_type, at: last.punched_at } : null, now, settings.max_shift_hours);
}

export interface ClientContext {
  ip: string;
  userAgent: string | null;
  /** Set when the request comes from an administrator-authorized kiosk device. */
  kioskDeviceId: string | null;
}

function rateKey(ctx: ClientContext): string {
  return ctx.kioskDeviceId ? `pin:kiosk:${ctx.kioskDeviceId}` : `pin:ip:${ctx.ip}`;
}

async function authenticatePin(db: Queryable, pepper: string, pin: unknown, ctx: ClientContext, now: Date): Promise<EmployeeIdentity> {
  const key = rateKey(ctx);
  if (await isRateLimited(db, key, PIN_FAILURE_LIMIT, PIN_FAILURE_WINDOW_S, now)) {
    throw new AppError("RATE_LIMITED", "Too many incorrect PIN attempts. Please wait 15 minutes or ask a manager.", 429);
  }
  const res = isValidPinFormat(pin)
    ? await db.query<EmployeeIdentity>(`select id, first_name, last_name, active from employees where pin_lookup = $1`, [hashPin(pin, pepper)])
    : { rows: [] as EmployeeIdentity[] };
  const emp = res.rows[0];
  if (!emp || !emp.active) {
    await recordFailure(db, key, PIN_FAILURE_WINDOW_S, now);
    throw new AppError("INVALID_PIN", "PIN not recognized. Please try again.", 401);
  }
  return emp;
}

export interface TodayPunch {
  type: PunchType;
  at: string;
  pendingReview: boolean;
}

async function todaysPunches(db: Queryable, employeeId: string, now: Date): Promise<TodayPunch[]> {
  const today = chicagoDate(now);
  const res = await db.query<PunchRow>(
    `select punch_type, punched_at, review_status from punches
     where employee_id = $1 and ${EFFECTIVE_PUNCH} and punched_at >= $2 and punched_at < $3 order by punched_at`,
    [employeeId, chicagoMidnight(today), chicagoMidnight(addDays(today, 1))],
  );
  return res.rows.map((r) => ({ type: r.punch_type, at: r.punched_at.toISOString(), pendingReview: r.review_status === "pending" }));
}

export interface EmployeeStatusView {
  employee: { firstName: string; lastName: string };
  state: CurrentState["state"];
  since: string | null;
  staleOpenShift: boolean;
  allowedActions: PunchType[];
  today: TodayPunch[];
  /** Whether this punch must include a GPS reading (false for kiosk devices). */
  locationRequired: boolean;
  geofenceMode: SiteSettings["geofence_mode"];
}

/** Step 1 of punching: verify the PIN and return only this employee's own status. */
export async function identify(db: Queryable, pepper: string, pin: unknown, ctx: ClientContext, now = new Date()): Promise<EmployeeStatusView> {
  const emp = await authenticatePin(db, pepper, pin, ctx, now);
  const settings = await getSettings(db);
  const cs = await employeeState(db, emp.id, now, settings);
  return {
    employee: { firstName: emp.first_name, lastName: emp.last_name },
    state: cs.state,
    since: cs.since?.toISOString() ?? null,
    staleOpenShift: cs.stale,
    allowedActions: allowedActions(cs),
    today: await todaysPunches(db, emp.id, now),
    locationRequired: !ctx.kioskDeviceId,
    geofenceMode: settings.geofence_mode,
  };
}

export interface PunchRequest {
  pin: unknown;
  action: unknown;
  clientRequestId: unknown;
  location?: unknown;
  /** Present when the employee asks for manager review because location could not be verified. */
  exception?: { reason?: unknown; gpsError?: unknown } | null;
}

export interface PunchResult {
  duplicate: boolean;
  punch: { id: string; type: PunchType; at: string; pendingReview: boolean; geofenceResult: string | null };
  status: EmployeeStatusView;
}

const LOCATION_ERRORS: Record<Exclude<GeofenceResult, "inside">, { code: string; message: string }> = {
  outside: { code: "GPS_OUTSIDE", message: "Your location is outside the warehouse area." },
  low_accuracy: { code: "GPS_LOW_ACCURACY", message: "Your GPS reading is not accurate enough. Move near a window or outside and try again." },
  stale: { code: "GPS_STALE", message: "The location reading was too old. Please try again." },
};

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : null;
}

/**
 * Records a punch with a server-generated timestamp. Serialized per employee with a row lock;
 * retried requests with the same clientRequestId return the original punch.
 */
export async function recordPunch(
  pepper: string,
  req: PunchRequest,
  ctx: ClientContext,
  opts: { now?: () => Date } = {},
): Promise<PunchResult> {
  const clock = opts.now ?? (() => new Date());
  if (!isPunchType(req.action)) throw new AppError("INVALID_INPUT", "Unknown action.");
  const action = req.action;
  if (typeof req.clientRequestId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(req.clientRequestId)) {
    throw new AppError("INVALID_INPUT", "Missing request id.");
  }
  const clientRequestId = req.clientRequestId;

  // PIN check runs outside the transaction so failed attempts are counted even though the punch is not saved.
  const emp = await authenticatePin(getPool(), pepper, req.pin, ctx, clock());
  return transaction(async (client) => {
  await client.query(`select id from employees where id = $1 for update`, [emp.id]);

  const prior = await client.query<PunchRow>(`select * from punches where client_request_id = $1`, [clientRequestId]);
  if (prior.rows[0]) {
    const p = prior.rows[0];
    if (p.employee_id !== emp.id || p.punch_type !== action) throw new AppError("INVALID_INPUT", "Request id reuse.", 409);
    const settings = await getSettings(client);
    return {
      duplicate: true,
      punch: { id: p.id, type: p.punch_type, at: p.punched_at.toISOString(), pendingReview: p.review_status === "pending", geofenceResult: p.geofence_result },
      status: await statusAfter(client, emp, clock(), settings, ctx),
    };
  }

  if (ctx.kioskDeviceId) {
    const dev = await client.query(`select 1 from kiosk_devices where id = $1 and revoked_at is null`, [ctx.kioskDeviceId]);
    if (!dev.rowCount) throw new AppError("KIOSK_REVOKED", "This kiosk is no longer authorized. Ask an administrator.", 403);
  }

  const settings = await getSettings(client);
  // Timestamp is taken after acquiring the lock so concurrent requests are strictly ordered.
  const now = clock();
  const cs = await employeeState(client, emp.id, now, settings);
  const violation = validatePunch(action, cs, now, settings.duplicate_window_s);
  if (violation) {
    throw new AppError(violation.code, violation.message, 409, {
      state: cs.state,
      allowedActions: allowedActions(cs),
      ...(violation.code === "DUPLICATE_PUNCH" ? { retryAfterSeconds: violation.retryAfterSeconds } : {}),
    });
  }

  let source: PunchRow["source"] = "phone";
  let geofenceResult: string;
  let reviewStatus: PunchRow["review_status"] = "none";
  let reading: LocationReading | null = null;
  let distance: number | null = null;
  let exceptionReason: string | null = null;
  let gpsError: string | null = null;

  if (ctx.kioskDeviceId) {
    source = "kiosk";
    geofenceResult = "not_required";
  } else {
    reading = isValidReading(req.location) ? req.location : null;
    const evaluation = reading
      ? evaluateGeofence(reading, {
          latitude: settings.latitude,
          longitude: settings.longitude,
          radiusM: settings.radius_m,
          maxAccuracyM: settings.max_accuracy_m,
          maxLocationAgeS: settings.max_location_age_s,
        })
      : null;
    distance = evaluation?.distanceM ?? null;
    geofenceResult = evaluation?.result ?? "unavailable";

    if (req.exception) {
      exceptionReason = cleanText(req.exception.reason, 500);
      gpsError = cleanText(req.exception.gpsError, 200);
      if (!exceptionReason || exceptionReason.length < 5) {
        throw new AppError("INVALID_INPUT", "Please describe briefly why location could not be verified.");
      }
      reviewStatus = "pending";
    } else if (!evaluation) {
      throw new AppError("LOCATION_REQUIRED", "A fresh location reading is required to punch from a phone.", 422, { canRequestException: true });
    } else if (evaluation.result !== "inside" && settings.geofence_mode === "enforce") {
      const err = LOCATION_ERRORS[evaluation.result];
      throw new AppError(err.code, err.message, 422, {
        canRequestException: true,
        distanceM: Math.round(evaluation.distanceM),
        accuracyM: Math.round(reading!.accuracy),
      });
    }
    // In monitor mode an outside/low-accuracy reading is recorded and flagged, not rejected.
  }

  const inserted = await client.query<PunchRow>(
    `insert into punches (employee_id, punch_type, punched_at, source, kiosk_device_id, latitude, longitude, accuracy_m,
       location_age_s, distance_m, geofence_result, geofence_mode, review_status, exception_reason, gps_error,
       client_request_id, ip, user_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
    [
      emp.id,
      action,
      now,
      source,
      ctx.kioskDeviceId,
      reading?.latitude ?? null,
      reading?.longitude ?? null,
      reading?.accuracy ?? null,
      reading?.ageSeconds ?? null,
      distance,
      geofenceResult,
      source === "kiosk" ? null : settings.geofence_mode,
      reviewStatus,
      exceptionReason,
      gpsError,
      clientRequestId,
      ctx.ip.slice(0, 64),
      ctx.userAgent?.slice(0, 300) ?? null,
    ],
  );
  const p = inserted.rows[0];
  if (reviewStatus === "pending") {
    await writeAudit(client, { type: "employee", id: emp.id, label: `${emp.first_name} ${emp.last_name}`, ip: ctx.ip }, "punch.exception_request", "punch", p.id, {
      reason: exceptionReason,
      after: { punch_type: action, punched_at: now.toISOString(), gps_error: gpsError, geofence_result: geofenceResult },
    });
  }
  return {
    duplicate: false,
    punch: { id: p.id, type: p.punch_type, at: p.punched_at.toISOString(), pendingReview: reviewStatus === "pending", geofenceResult },
    status: await statusAfter(client, emp, now, settings, ctx),
  };
  });
}

async function statusAfter(db: Queryable, emp: EmployeeIdentity, now: Date, settings: SiteSettings, ctx: ClientContext): Promise<EmployeeStatusView> {
  const cs = await employeeState(db, emp.id, now, settings);
  return {
    employee: { firstName: emp.first_name, lastName: emp.last_name },
    state: cs.state,
    since: cs.since?.toISOString() ?? null,
    staleOpenShift: cs.stale,
    allowedActions: allowedActions(cs),
    today: await todaysPunches(db, emp.id, now),
    locationRequired: !ctx.kioskDeviceId,
    geofenceMode: settings.geofence_mode,
  };
}

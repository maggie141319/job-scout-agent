/**
 * End-to-end service tests against a real PostgreSQL database.
 * Requires TEST_DATABASE_URL (a disposable database: all tables are dropped and recreated).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS helper shared with the CLI scripts
import { loadEnvFile } from "../scripts/load-env.mjs";

loadEnvFile();
const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
process.env.PIN_PEPPER ??= "integration-test-pepper-0123456789abcdef";
const PEPPER = process.env.PIN_PEPPER!;

const { getPool, closePool, transaction, query } = await import("@/lib/db");
const { recordPunch, identify } = await import("@/lib/services/punches");
const { createEmployee, setRate, setEmployeeActive, resetPin } = await import("@/lib/services/employees");
const { verifyCoordinates, setGeofenceMode, updateSettings, getSettings } = await import("@/lib/services/settings");
const { reviewException, replacePunch, addPunch, voidPunch, listPendingExceptions } = await import("@/lib/services/corrections");
const { weeklySettlement, employeeTimecard, statusBoard, finalizeWeek } = await import("@/lib/services/reports");
const { login, sessionUser, logout, actorFor } = await import("@/lib/services/admin-auth");
const { registerKiosk, revokeKiosk } = await import("@/lib/services/devices");
const { hashPassword } = await import("@/lib/security");
const { chicagoWallTimeToInstant: ct } = await import("@/lib/time");
const { AppError } = await import("@/lib/errors");

const SITE = { latitude: 35.442, longitude: -97.673 };
const inside = { latitude: 35.4421, longitude: -97.6731, accuracy: 12, ageSeconds: 2 };
const outside = { latitude: 35.47, longitude: -97.673, accuracy: 12, ageSeconds: 2 };
const phone = { ip: "203.0.113.10", userAgent: "test-phone", kioskDeviceId: null };

let adminActor: ReturnType<typeof actorFor>;
let managerActor: ReturnType<typeof actorFor>;
let reqSeq = 0;
const rid = () => `req-${Date.now()}-${++reqSeq}`;

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as InstanceType<typeof AppError>).code).toBe(code);
    return e as InstanceType<typeof AppError>;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

async function resetDatabase() {
  const pool = getPool();
  await pool.query("drop schema public cascade; create schema public;");
  // @ts-expect-error plain JS migration runner
  const { migrate } = await import("../scripts/migrate.mjs");
  await migrate(TEST_DB, { log: () => {} });
}

async function makeAdmin(username: string, role: "admin" | "manager") {
  const rows = await query<{ id: string; username: string; display_name: string; role: "admin" | "manager"; active: boolean }>(
    `insert into admin_users (username, display_name, password_hash, role) values ($1, $1, $2, $3) returning id, username, display_name, role, active`,
    [username, await hashPassword("a-very-long-password"), role],
  );
  return actorFor(rows[0], "127.0.0.1");
}

async function newEmployee(code: string, pin: string, rate = "20.00") {
  return transaction((db) =>
    createEmployee(db, PEPPER, { employeeCode: code, firstName: code, lastName: "Tester", pin, rate, rateEffectiveDate: "2026-01-01" }, adminActor),
  );
}

const punch = (pin: string, action: string, at: Date, extra: Record<string, unknown> = {}, ctx = phone) =>
  recordPunch(PEPPER, { pin, action, clientRequestId: rid(), location: inside, ...extra }, ctx, { now: () => at });

async function enforce() {
  await transaction(async (db) => {
    await updateSettings(db, { ...SITE, radius_m: 100, max_accuracy_m: 100, max_location_age_s: 120, duplicate_window_s: 60, max_shift_hours: 16, overtime_policy: "apply" }, adminActor);
    await verifyCoordinates(db, adminActor, "Measured on site at the front door");
    await setGeofenceMode(db, "enforce", adminActor);
  });
}

describe.skipIf(!TEST_DB)("time clock workflow (PostgreSQL)", () => {
  beforeAll(async () => {
    await resetDatabase();
    adminActor = await makeAdmin("owner", "admin");
    managerActor = await makeAdmin("floor.manager", "manager");
  });
  afterAll(async () => {
    await closePool();
  });
  beforeEach(async () => {
    await query("delete from rate_limits");
  });

  it("stores only a keyed hash of the PIN and keeps rates out of the employee view", async () => {
    const { employee, pin } = await newEmployee("E100", "482913");
    expect(pin).toBe("482913");
    const row = (await query<{ pin_lookup: string }>("select pin_lookup from employees where id = $1", [employee.id]))[0];
    expect(row.pin_lookup).not.toContain("482913");
    expect(row.pin_lookup).toHaveLength(64);
    await expectCode(newEmployee("E101", "482913"), "PIN_TAKEN");
    const view = await identify(getPool(), PEPPER, "482913", phone);
    expect(JSON.stringify(view)).not.toMatch(/rate|cents|pin|code|notes/i);
    expect(view.employee.firstName).toBe("E100");
  });

  it("refuses to enforce the geofence before coordinates are verified", async () => {
    await expectCode(transaction((db) => setGeofenceMode(db, "enforce", adminActor)), "COORDINATES_NOT_VERIFIED");
    // The database constraint backs this up even if the app check were bypassed.
    await expect(query("update site_settings set geofence_mode = 'enforce', coordinates_verified_at = null")).rejects.toThrow(/enforce_requires_verified/);
  });

  it("runs a full day: clock in, lunch out, lunch in, clock out (with idempotent retry)", async () => {
    await enforce();
    await newEmployee("E200", "731864");
    const day = "2026-10-23";
    const id = "retry-same-request-0001";
    const first = await recordPunch(PEPPER, { pin: "731864", action: "clock_in", clientRequestId: id, location: inside }, phone, { now: () => ct(day, 8, 0) });
    expect(first.duplicate).toBe(false);
    expect(first.status.state).toBe("working");
    const retry = await recordPunch(PEPPER, { pin: "731864", action: "clock_in", clientRequestId: id, location: inside }, phone, { now: () => ct(day, 8, 0, 5) });
    expect(retry.duplicate).toBe(true);
    expect(retry.punch.id).toBe(first.punch.id);

    expect((await punch("731864", "lunch_out", ct(day, 12, 0))).status.state).toBe("lunch");
    expect((await punch("731864", "lunch_in", ct(day, 12, 41))).status.state).toBe("working");
    const out = await punch("731864", "clock_out", ct(day, 16, 30));
    expect(out.status.state).toBe("off");
    expect(out.status.allowedActions).toEqual(["clock_in"]);

    const tc = await employeeTimecard(getPool(), (await query<{ id: string }>("select id from employees where employee_code='E200'"))[0].id, day);
    expect(tc.punches).toHaveLength(4);
    expect(tc.settlement.totalSeconds).toBe(8.5 * 3600 - 41 * 60);
    expect(tc.settlement.flags).toEqual([]);
  });

  it("rejects invalid sequences and accidental duplicates", async () => {
    await newEmployee("E300", "590172");
    const t = ct("2026-10-24", 9, 0);
    await expectCode(punch("590172", "clock_out", t), "INVALID_SEQUENCE");
    await expectCode(punch("590172", "lunch_in", t), "INVALID_SEQUENCE");
    await punch("590172", "clock_in", t);
    const dup = await expectCode(punch("590172", "lunch_out", new Date(t.getTime() + 15_000)), "DUPLICATE_PUNCH");
    expect(dup.details.retryAfterSeconds).toBe(45);
    await expectCode(punch("590172", "clock_in", new Date(t.getTime() + 120_000)), "INVALID_SEQUENCE");
    await punch("590172", "lunch_out", new Date(t.getTime() + 3 * 3600_000));
    await expectCode(punch("590172", "clock_out", new Date(t.getTime() + 3.5 * 3600_000)), "INVALID_SEQUENCE");
  });

  it("rejects bad PINs, rate-limits guessing and blocks deactivated employees", async () => {
    const { employee } = await newEmployee("E400", "264801");
    await expectCode(identify(getPool(), PEPPER, "000000", phone), "INVALID_PIN");
    await expectCode(identify(getPool(), PEPPER, "12ab", phone), "INVALID_PIN");
    for (let i = 0; i < 13; i++) await expectCode(identify(getPool(), PEPPER, "999998", phone), "INVALID_PIN");
    await expectCode(identify(getPool(), PEPPER, "264801", phone), "RATE_LIMITED");
    await query("delete from rate_limits");
    await transaction((db) => setEmployeeActive(db, employee.id, false, adminActor, "left company"));
    await expectCode(identify(getPool(), PEPPER, "264801", phone), "INVALID_PIN");
    // Records are kept after deactivation.
    expect((await query("select 1 from employees where id = $1", [employee.id])).length).toBe(1);
  });

  it("enforces GPS: requires a reading, rejects outside / inaccurate / stale readings", async () => {
    await newEmployee("E500", "318275");
    const t = ct("2026-10-25", 7, 0);
    await expectCode(punch("318275", "clock_in", t, { location: undefined }), "LOCATION_REQUIRED");
    const outsideErr = await expectCode(punch("318275", "clock_in", t, { location: outside }), "GPS_OUTSIDE");
    expect(outsideErr.details.canRequestException).toBe(true);
    expect(outsideErr.details.distanceM).toBeGreaterThan(2000);
    await expectCode(punch("318275", "clock_in", t, { location: { ...inside, accuracy: 900 } }), "GPS_LOW_ACCURACY");
    await expectCode(punch("318275", "clock_in", t, { location: { ...inside, ageSeconds: 3600 } }), "GPS_STALE");
    const ok = await punch("318275", "clock_in", t);
    expect(ok.punch.geofenceResult).toBe("inside");
    const stored = (await query<{ latitude: number; accuracy_m: number; punched_at: Date }>("select latitude, accuracy_m, punched_at from punches where id = $1", [ok.punch.id]))[0];
    expect(stored.accuracy_m).toBe(12);
    expect(stored.punched_at.toISOString()).toBe(t.toISOString());
  });

  it("lets employees request a manager exception when GPS fails; managers approve or reject", async () => {
    const { employee } = await newEmployee("E600", "847120");
    const t = ct("2026-10-26", 7, 0);
    await expectCode(punch("847120", "clock_in", t, { location: undefined, exception: { reason: "no" } }), "INVALID_INPUT");
    const exc = await punch("847120", "clock_in", t, { location: undefined, exception: { reason: "Phone GPS kept timing out at the dock", gpsError: "TIMEOUT" } });
    expect(exc.punch.pendingReview).toBe(true);
    expect(exc.status.state).toBe("working"); // time is not lost; the day can continue
    const out = await punch("847120", "clock_out", ct("2026-10-26", 15, 0), { location: outside, exception: { reason: "Delivering cabinets to a customer site" } });

    const pending = await listPendingExceptions(getPool());
    expect(pending.map((p) => p.id)).toEqual(expect.arrayContaining([exc.punch.id, out.punch.id]));

    await reviewException(exc.punch.id, "approve", "Confirmed with supervisor", managerActor);
    await expectCode(reviewException(exc.punch.id, "approve", "", managerActor), "ALREADY_REVIEWED");
    await expectCode(reviewException(out.punch.id, "reject", "", managerActor), "INVALID_INPUT");
    await reviewException(out.punch.id, "reject", "Was not working at that time", managerActor);

    const tc = await employeeTimecard(getPool(), employee.id, "2026-10-26");
    expect(tc.settlement.flags.map((f) => f.code)).toContain("MISSING_CLOCK_OUT");
    const audit = await query<{ action: string }>("select action from audit_log where entity_id = any($1) order by id", [[exc.punch.id, out.punch.id]]);
    expect(audit.map((a) => a.action)).toEqual(["punch.exception_request", "punch.exception_request", "punch.exception_approve", "punch.exception_reject"]);
  });

  it("records but flags outside punches in monitor mode", async () => {
    await transaction((db) => setGeofenceMode(db, "monitor", adminActor));
    const { employee } = await newEmployee("E700", "605938");
    const r = await punch("605938", "clock_in", ct("2026-10-27", 7, 0), { location: outside });
    expect(r.punch.geofenceResult).toBe("outside");
    const tc = await employeeTimecard(getPool(), employee.id, "2026-10-27", ct("2026-10-27", 9, 0));
    expect(tc.settlement.flags.map((f) => f.code)).toContain("OUTSIDE_GEOFENCE");
    await enforce();
  });

  it("supports an administrator-authorized kiosk without GPS, and revocation", async () => {
    await newEmployee("E800", "417396");
    const { device } = await transaction((db) => registerKiosk(db, "Warehouse Tablet", adminActor));
    const kiosk = { ip: "198.51.100.7", userAgent: "tablet", kioskDeviceId: device.id };
    const view = await identify(getPool(), PEPPER, "417396", kiosk);
    expect(view.locationRequired).toBe(false);
    const r = await punch("417396", "clock_in", ct("2026-10-27", 6, 0), { location: undefined }, kiosk);
    expect(r.punch.geofenceResult).toBe("not_required");
    expect((await query<{ source: string }>("select source from punches where id = $1", [r.punch.id]))[0].source).toBe("kiosk");
    await transaction((db) => revokeKiosk(db, device.id, adminActor));
    await expectCode(punch("417396", "clock_out", ct("2026-10-27", 14, 0), { location: undefined }, kiosk), "KIOSK_REVOKED");
    // Same employee continues on a phone; history is kept.
    const fromPhone = await punch("417396", "clock_out", ct("2026-10-27", 14, 0));
    expect(fromPhone.status.today.map((t) => t.type)).toEqual(["clock_in", "clock_out"]);
  });

  it("settles overnight shifts across the Friday week boundary", async () => {
    const { employee } = await newEmployee("E900", "953027", "18.00");
    await punch("953027", "clock_in", ct("2026-10-29", 22, 0)); // Thursday night
    await punch("953027", "clock_out", ct("2026-10-30", 6, 30)); // Friday morning
    const now = ct("2026-11-10", 12, 0);
    const wk1 = await weeklySettlement(getPool(), "2026-10-23", now);
    const wk2 = await weeklySettlement(getPool(), "2026-10-30", now);
    const r1 = wk1.rows.find((r) => r.employeeId === employee.id)!;
    const r2 = wk2.rows.find((r) => r.employeeId === employee.id)!;
    expect(wk1.week).toMatchObject({ startDate: "2026-10-23", endDate: "2026-10-29", payDate: "2026-10-30" });
    expect(r1.totalHours).toBe(2);
    expect(r1.amountDueCents).toBe(3600);
    expect(r2.totalHours).toBe(6.5);
    expect(r2.amountDueCents).toBe(11700);
    expect(r1.flags).toEqual([]);
  });

  it("allows a new clock-in after a forgotten clock-out and flags the open shift", async () => {
    const { employee } = await newEmployee("E950", "380519");
    await punch("380519", "clock_in", ct("2026-11-02", 7, 0));
    const next = await punch("380519", "clock_in", ct("2026-11-03", 7, 0));
    expect(next.status.state).toBe("working");
    const tc = await employeeTimecard(getPool(), employee.id, "2026-11-02", ct("2026-11-03", 9, 0));
    expect(tc.settlement.flags.map((f) => f.code)).toContain("MISSING_CLOCK_OUT");
  });

  it("corrects records with an audit trail and keeps raw punches immutable", async () => {
    const { employee } = await newEmployee("E990", "726154");
    const a = await punch("726154", "clock_in", ct("2026-11-04", 8, 0));
    await punch("726154", "clock_out", ct("2026-11-04", 12, 0));
    await expectCode(replacePunch(a.punch.id, "clock_in", ct("2026-11-04", 7, 30), "x", managerActor), "INVALID_INPUT");
    const newId = await replacePunch(a.punch.id, "clock_in", ct("2026-11-04", 7, 30), "Forgot to punch at arrival, confirmed by camera", managerActor, ct("2026-11-05", 9, 0));
    await expectCode(replacePunch(a.punch.id, "clock_in", ct("2026-11-04", 7, 45), "second edit attempt", managerActor, ct("2026-11-05", 9, 0)), "ALREADY_VOIDED");
    const addId = await addPunch(employee.id, "clock_in", ct("2026-11-05", 8, 0), "Missed punch, approved by owner", managerActor, ct("2026-11-05", 18, 0));
    await addPunch(employee.id, "clock_out", ct("2026-11-05", 17, 0), "Missed punch, approved by owner", managerActor, ct("2026-11-05", 18, 0));
    await expectCode(addPunch(employee.id, "clock_out", new Date(Date.now() + 86400_000), "future punch attempt", managerActor), "INVALID_INPUT");

    const tc = await employeeTimecard(getPool(), employee.id, "2026-11-04", ct("2026-11-06", 9, 0));
    expect(tc.settlement.totalHours).toBe(4.5 + 9);
    const orig = tc.punches.find((p) => p.id === a.punch.id)!;
    expect(orig.voided_at).not.toBeNull();
    expect(orig.punched_at.toISOString()).toBe(ct("2026-11-04", 8, 0).toISOString()); // original preserved
    expect(tc.punches.find((p) => p.id === newId)?.replaces_punch_id).toBe(a.punch.id);

    await voidPunch(addId, "Duplicate entry created in error", managerActor);
    const actions = await query<{ action: string; actor_label: string }>("select action, actor_label from audit_log where entity_type = 'punch' and (entity_id = $1 or entity_id = $2) order by id", [a.punch.id, addId]);
    expect(actions.map((x) => x.action)).toEqual(["punch.replace", "punch.add", "punch.void"]);
    expect(actions[0].actor_label).toContain("floor.manager");

    await expect(query("update punches set punched_at = now() where id = $1", [a.punch.id])).rejects.toThrow(/immutable/);
    await expect(query("delete from punches where id = $1", [a.punch.id])).rejects.toThrow(/append-only/);
    await expect(query("update punches set voided_at = null where id = $1", [a.punch.id])).rejects.toThrow(/cannot be restored/);
    await expect(query("delete from audit_log")).rejects.toThrow(/append-only/);
  });

  it("keeps old weeks on the old rate after a rate change; finalizes snapshots", async () => {
    const { employee } = await newEmployee("E995", "158340", "15.00");
    await punch("158340", "clock_in", ct("2026-11-06", 8, 0));
    await punch("158340", "clock_out", ct("2026-11-06", 16, 0));
    await transaction((db) => setRate(db, employee.id, "17.50", "2026-11-13", adminActor));
    const report = await weeklySettlement(getPool(), "2026-11-06", ct("2026-11-20", 9, 0));
    expect(report.rows.find((r) => r.employeeId === employee.id)?.amountDueCents).toBe(12000);
    const snapId = await transaction((db) => finalizeWeek(db, "2026-11-06", "Paid 11/13", adminActor, ct("2026-11-20", 9, 0)));
    const snap = await query<{ data: { rows: unknown[] } }>("select data from settlement_snapshots where id = $1", [snapId]);
    expect(snap[0].data.rows.length).toBeGreaterThan(0);
  });

  it("resets PINs without exposing the old one", async () => {
    const { employee } = await newEmployee("E996", "293847");
    const newPin = await transaction((db) => resetPin(db, PEPPER, employee.id, null, adminActor));
    expect(newPin).toMatch(/^\d{6}$/);
    await expectCode(identify(getPool(), PEPPER, "293847", phone), "INVALID_PIN");
    expect((await identify(getPool(), PEPPER, newPin, phone)).employee.firstName).toBe("E996");
  });

  it("authenticates administrators with lockout, sessions and logout", async () => {
    const client = { ip: "192.0.2.1", userAgent: "test" };
    await expectCode(login(getPool(), "owner", "wrong-password-123", client), "INVALID_LOGIN");
    await expectCode(login(getPool(), "nobody", "wrong-password-123", client), "INVALID_LOGIN");
    const { token, user } = await login(getPool(), "OWNER", "a-very-long-password", client);
    expect(user.role).toBe("admin");
    expect((await sessionUser(getPool(), token))?.username).toBe("owner");
    const stored = await query<{ token_hash: string }>("select token_hash from admin_sessions");
    expect(stored.every((s) => s.token_hash !== token)).toBe(true);
    await logout(getPool(), token);
    expect(await sessionUser(getPool(), token)).toBeNull();
    for (let i = 0; i < 5; i++) await expectCode(login(getPool(), "floor.manager", "bad-password-xyz", client), "INVALID_LOGIN");
    await expectCode(login(getPool(), "floor.manager", "a-very-long-password", client), "LOCKED");
  });

  it("shows a live status board", async () => {
    const board = await statusBoard(getPool(), ct("2026-11-03", 10, 0));
    expect(board.find((b) => b.employee_code === "E950")?.state).toBe("working");
    const settings = await getSettings(getPool());
    expect(settings.geofence_mode).toBe("enforce");
  });
});

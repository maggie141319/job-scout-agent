import "server-only";
import type { Queryable } from "../db";
import { AppError } from "../errors";
import type { PayEstimateMethod } from "../settlement";
import { writeAudit, type Actor } from "./audit";

export interface SiteSettings {
  site_name: string;
  address: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  geofence_mode: "monitor" | "enforce";
  coordinates_verified_at: Date | null;
  coordinates_verified_by: string | null;
  max_accuracy_m: number;
  max_location_age_s: number;
  duplicate_window_s: number;
  max_shift_hours: number;
  pay_estimate_method: PayEstimateMethod;
  overtime_multiplier: number;
  updated_at: Date;
}

// pg returns NUMERIC columns as strings.
const normalize = (row: SiteSettings): SiteSettings => ({ ...row, overtime_multiplier: Number(row.overtime_multiplier) });

export async function getSettings(db: Queryable): Promise<SiteSettings> {
  const res = await db.query<SiteSettings>(`select * from site_settings where id = 1`);
  if (!res.rows[0]) throw new Error("site_settings row missing; run migrations");
  return normalize(res.rows[0]);
}

export interface SettingsUpdate {
  latitude: number;
  longitude: number;
  radius_m: number;
  max_accuracy_m: number;
  max_location_age_s: number;
  duplicate_window_s: number;
  max_shift_hours: number;
  pay_estimate_method: PayEstimateMethod;
  overtime_multiplier: number;
}

function intInRange(name: string, v: number, min: number, max: number) {
  if (!Number.isInteger(v) || v < min || v > max) throw new AppError("INVALID_INPUT", `${name} must be a whole number between ${min} and ${max}.`);
}

/**
 * Updates site settings. Changing the coordinates clears their verification and, if
 * enforcement was on, returns geofencing to monitor mode until re-verified.
 */
export async function updateSettings(db: Queryable, update: SettingsUpdate, actor: Actor): Promise<SiteSettings> {
  if (!Number.isFinite(update.latitude) || Math.abs(update.latitude) > 90) throw new AppError("INVALID_INPUT", "Latitude is invalid.");
  if (!Number.isFinite(update.longitude) || Math.abs(update.longitude) > 180) throw new AppError("INVALID_INPUT", "Longitude is invalid.");
  intInRange("Radius (m)", update.radius_m, 25, 2000);
  intInRange("Max GPS accuracy (m)", update.max_accuracy_m, 10, 1000);
  intInRange("Max location age (s)", update.max_location_age_s, 10, 900);
  intInRange("Duplicate window (s)", update.duplicate_window_s, 0, 600);
  intInRange("Max shift hours", update.max_shift_hours, 8, 24);
  if (!["flat_rate", "overtime_premium"].includes(update.pay_estimate_method)) throw new AppError("INVALID_INPUT", "Invalid payment estimate method.");
  if (!Number.isFinite(update.overtime_multiplier) || update.overtime_multiplier < 1 || update.overtime_multiplier > 3 || Math.round(update.overtime_multiplier * 100) !== update.overtime_multiplier * 100) {
    throw new AppError("INVALID_INPUT", "Overtime multiplier must be between 1.00 and 3.00 (e.g. 1.5).");
  }

  const before = await getSettings(db);
  const moved = before.latitude !== update.latitude || before.longitude !== update.longitude;
  const res = await db.query<SiteSettings>(
    `update site_settings set latitude = $1, longitude = $2, radius_m = $3, max_accuracy_m = $4,
       max_location_age_s = $5, duplicate_window_s = $6, max_shift_hours = $7, pay_estimate_method = $8,
       overtime_multiplier = $11,
       coordinates_verified_at = case when $9 then null else coordinates_verified_at end,
       coordinates_verified_by = case when $9 then null else coordinates_verified_by end,
       geofence_mode = case when $9 then 'monitor' else geofence_mode end,
       updated_at = now(), updated_by = $10
     where id = 1 returning *`,
    [
      update.latitude,
      update.longitude,
      update.radius_m,
      update.max_accuracy_m,
      update.max_location_age_s,
      update.duplicate_window_s,
      update.max_shift_hours,
      update.pay_estimate_method,
      moved,
      actor.id,
      update.overtime_multiplier,
    ],
  );
  const after = normalize(res.rows[0]);
  await writeAudit(db, actor, "settings.update", "site_settings", "1", { before, after });
  return after;
}

/** Records that an administrator confirmed the warehouse coordinates (e.g. on site). */
export async function verifyCoordinates(db: Queryable, actor: Actor, note: string): Promise<void> {
  if (actor.type !== "admin" || !actor.id) throw new AppError("FORBIDDEN", "Only administrators can verify coordinates.", 403);
  if (note.trim().length < 5) throw new AppError("INVALID_INPUT", "Describe how the coordinates were verified.");
  const before = await getSettings(db);
  await db.query(`update site_settings set coordinates_verified_at = now(), coordinates_verified_by = $1, updated_at = now(), updated_by = $1 where id = 1`, [actor.id]);
  await writeAudit(db, actor, "settings.verify_coordinates", "site_settings", "1", {
    reason: note.trim(),
    after: { latitude: before.latitude, longitude: before.longitude },
  });
}

export async function setGeofenceMode(db: Queryable, mode: "monitor" | "enforce", actor: Actor): Promise<void> {
  const before = await getSettings(db);
  if (mode === "enforce" && !before.coordinates_verified_at) {
    throw new AppError("COORDINATES_NOT_VERIFIED", "Verify the warehouse coordinates on site before enabling enforcement.");
  }
  await db.query(`update site_settings set geofence_mode = $1, updated_at = now(), updated_by = $2 where id = 1`, [mode, actor.id]);
  await writeAudit(db, actor, "settings.geofence_mode", "site_settings", "1", {
    before: { geofence_mode: before.geofence_mode },
    after: { geofence_mode: mode },
  });
}

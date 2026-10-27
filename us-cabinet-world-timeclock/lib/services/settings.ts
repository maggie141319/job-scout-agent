import "server-only";
import type { Queryable } from "../db";
import { AppError } from "../errors";
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
  overtime_policy: "apply" | "report_only";
  updated_at: Date;
}

export async function getSettings(db: Queryable): Promise<SiteSettings> {
  const res = await db.query<SiteSettings>(`select * from site_settings where id = 1`);
  if (!res.rows[0]) throw new Error("site_settings row missing; run migrations");
  return res.rows[0];
}

export interface SettingsUpdate {
  latitude: number;
  longitude: number;
  radius_m: number;
  max_accuracy_m: number;
  max_location_age_s: number;
  duplicate_window_s: number;
  max_shift_hours: number;
  overtime_policy: "apply" | "report_only";
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
  if (!["apply", "report_only"].includes(update.overtime_policy)) throw new AppError("INVALID_INPUT", "Invalid overtime policy.");

  const before = await getSettings(db);
  const moved = before.latitude !== update.latitude || before.longitude !== update.longitude;
  const res = await db.query<SiteSettings>(
    `update site_settings set latitude = $1, longitude = $2, radius_m = $3, max_accuracy_m = $4,
       max_location_age_s = $5, duplicate_window_s = $6, max_shift_hours = $7, overtime_policy = $8,
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
      update.overtime_policy,
      moved,
      actor.id,
    ],
  );
  await writeAudit(db, actor, "settings.update", "site_settings", "1", { before, after: res.rows[0] });
  return res.rows[0];
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

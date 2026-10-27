/**
 * Geofence evaluation. GPS can be spoofed or inaccurate; this is a reasonable-effort
 * location check that supports manager review, not a fraud-proof control.
 */

export interface LocationReading {
  latitude: number;
  longitude: number;
  /** Reported accuracy radius in meters (from the browser Geolocation API). */
  accuracy: number;
  /** Age of the reading in seconds, measured on the device (send time - position time). */
  ageSeconds: number;
}

export interface GeofenceConfig {
  latitude: number;
  longitude: number;
  radiusM: number;
  maxAccuracyM: number;
  maxLocationAgeS: number;
}

export type GeofenceResult = "inside" | "outside" | "low_accuracy" | "stale";

export interface GeofenceEvaluation {
  result: GeofenceResult;
  distanceM: number;
}

const EARTH_RADIUS_M = 6371008.8;

export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isValidReading(r: unknown): r is LocationReading {
  if (!r || typeof r !== "object") return false;
  const v = r as Record<string, unknown>;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  return (
    num(v.latitude) &&
    num(v.longitude) &&
    num(v.accuracy) &&
    num(v.ageSeconds) &&
    Math.abs(v.latitude as number) <= 90 &&
    Math.abs(v.longitude as number) <= 180 &&
    (v.accuracy as number) >= 0
  );
}

/**
 * Order of checks: stale reading, then poor accuracy, then distance from the site.
 * A reading is "inside" only when its center is within the configured radius.
 */
export function evaluateGeofence(reading: LocationReading, config: GeofenceConfig): GeofenceEvaluation {
  const distanceM = distanceMeters(reading.latitude, reading.longitude, config.latitude, config.longitude);
  // Small negative ages happen from clock jitter on the device; treat anything beyond -5s as invalid.
  if (reading.ageSeconds > config.maxLocationAgeS || reading.ageSeconds < -5) {
    return { result: "stale", distanceM };
  }
  if (reading.accuracy > config.maxAccuracyM) return { result: "low_accuracy", distanceM };
  if (distanceM > config.radiusM) return { result: "outside", distanceM };
  return { result: "inside", distanceM };
}

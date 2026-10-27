/**
 * Time helpers for America/Chicago. All instants are stored in UTC (timestamptz);
 * these helpers only decide calendar days, week boundaries and display formatting.
 * Durations are always computed from real instants, so DST changes are handled exactly.
 */
export const TIME_ZONE = "America/Chicago";

/** Day of week index used for the start of the pay week (0 = Sunday ... 5 = Friday). */
export const WEEK_START_DOW = 5;

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function zonedParts(date: Date) {
  const out: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of America/Chicago from UTC at the given instant, in minutes (e.g. -300 for CDT). */
export function chicagoOffsetMinutes(date: Date): number {
  const p = zonedParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60000);
}

/** Calendar date (YYYY-MM-DD) in Chicago for an instant. */
export function chicagoDate(date: Date): string {
  const p = zonedParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Converts a Chicago wall-clock time to a UTC instant. Wall times that do not exist (spring-forward gap) resolve to an adjacent valid instant. */
export function chicagoWallTimeToInstant(ymd: string, hour = 0, minute = 0, second = 0): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, second);
  const off1 = chicagoOffsetMinutes(new Date(guess));
  let t = guess - off1 * 60000;
  const off2 = chicagoOffsetMinutes(new Date(t));
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

/** Instant of midnight at the start of the given Chicago date. */
export function chicagoMidnight(ymd: string): Date {
  return chicagoWallTimeToInstant(ymd, 0, 0, 0);
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function dayOfWeek(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Friday that starts the Friday–Thursday pay week containing the given date. */
export function weekStartFor(ymd: string): string {
  const back = (dayOfWeek(ymd) - WEEK_START_DOW + 7) % 7;
  return addDays(ymd, -back);
}

export interface PayWeek {
  /** Friday (inclusive) */
  startDate: string;
  /** Thursday (inclusive) */
  endDate: string;
  /** Friday payment day following the week */
  payDate: string;
  /** UTC instant of Friday 00:00 Chicago */
  start: Date;
  /** UTC instant of the following Friday 00:00 Chicago (exclusive end) */
  end: Date;
  days: string[];
}

export function payWeek(anyDateInWeek: string): PayWeek {
  const startDate = weekStartFor(anyDateInWeek);
  const days = Array.from({ length: 7 }, (_, i) => addDays(startDate, i));
  return {
    startDate,
    endDate: days[6],
    payDate: addDays(startDate, 7),
    start: chicagoMidnight(startDate),
    end: chicagoMidnight(addDays(startDate, 7)),
    days,
  };
}

export function payWeekForInstant(date: Date): PayWeek {
  return payWeek(chicagoDate(date));
}

const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dateLabelFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatTime(date: Date): string {
  return timeFmt.format(date);
}

export function formatDateTime(date: Date): string {
  return dateTimeFmt.format(date);
}

/** Formats a YYYY-MM-DD calendar date, e.g. "Fri, Oct 23, 2026". */
export function formatYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return dateLabelFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

/** Value for an <input type="datetime-local"> in Chicago time. */
export function toChicagoLocalInput(date: Date): string {
  const p = zonedParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Parses an <input type="datetime-local"> value interpreted as Chicago time. */
export function fromChicagoLocalInput(value: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m || !isYmd(m[1])) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return null;
  return chicagoWallTimeToInstant(m[1], hour, minute, Number(m[4] ?? 0));
}

export function hoursFromSeconds(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

/**
 * Pure weekly settlement calculation. Inputs are raw punches (never modified here);
 * outputs are derived totals. Nothing in this module writes to the database.
 *
 * Rules:
 * - Worked time = clock-in → clock-out minus actual lunch periods (lunch out → lunch in).
 *   No fixed lunch deduction is ever applied.
 * - Time is attributed to the Chicago calendar day and pay week in which it was actually
 *   worked, so overnight shifts are split at midnight and at the Friday 00:00 week boundary.
 * - Open shifts (no clock-out) only count their completed segments and are flagged for review.
 * - Hours over 40 in the Friday–Thursday week are always tracked and reported separately.
 * - The estimated amount is an INTERNAL PAYMENT ESTIMATE, not a determination of legal payroll
 *   obligations. Default method "flat_rate": total hours × each day's hourly rate (hours over 40
 *   are paid at the regular rate). Method "overtime_premium" adds (multiplier − 1) × regular rate
 *   for hours over 40. The premium at the configured multiplier is always computed for reference.
 */
import { addDays, chicagoMidnight, hoursFromSeconds, type PayWeek } from "./time";
import type { PunchType } from "./punch-rules";

export type PayEstimateMethod = "flat_rate" | "overtime_premium";

export const PAY_ESTIMATE_DISCLAIMER =
  "Internal payment estimate only. Not a determination of legal payroll obligations (worker classification, overtime and other requirements must be confirmed with your accountant).";

export function payEstimateLabel(method: PayEstimateMethod, multiplier: number): string {
  return method === "flat_rate"
    ? "Flat rate: total hours × hourly rate (hours over 40 at the regular rate)"
    : `Overtime premium: hours over 40 at ${multiplier}× the regular rate`;
}

export interface SettlementPunch {
  id: string;
  type: PunchType;
  at: Date;
  reviewStatus: "none" | "pending" | "approved" | "rejected";
  geofenceResult: string | null;
  source: string;
}

export interface RatePeriod {
  /** YYYY-MM-DD, inclusive */
  effectiveDate: string;
  rateCents: number;
}

export interface SettlementOptions {
  week: PayWeek;
  now: Date;
  maxShiftHours: number;
  payEstimateMethod: PayEstimateMethod;
  /** e.g. 1.5 for time-and-a-half; only added to the estimate when payEstimateMethod is "overtime_premium". */
  overtimeMultiplier: number;
  overtimeThresholdHours?: number;
  longShiftHours?: number;
}

export type FlagCode =
  | "MISSING_CLOCK_OUT"
  | "MISSING_CLOCK_IN"
  | "MISSING_LUNCH_IN"
  | "UNEXPECTED_PUNCH"
  | "IN_PROGRESS"
  | "PENDING_EXCEPTION"
  | "OUTSIDE_GEOFENCE"
  | "LONG_SHIFT"
  | "NO_RATE";

export interface SettlementFlag {
  code: FlagCode;
  message: string;
  at: Date | null;
  punchId: string | null;
}

export interface ShiftSummary {
  clockIn: Date | null;
  clockOut: Date | null;
  lunchSeconds: number;
  workedSeconds: number;
  workedSecondsInWeek: number;
  status: "complete" | "in_progress" | "missing_clock_out" | "missing_lunch_in";
  punchIds: string[];
}

export interface DayTotal {
  date: string;
  seconds: number;
  hours: number;
  rateCents: number;
  amountCents: number;
}

export interface EmployeeSettlement {
  days: DayTotal[];
  shifts: ShiftSummary[];
  flags: SettlementFlag[];
  totalSeconds: number;
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
  straightPayCents: number;
  /** Extra cost of hours over 40 at the configured multiplier (reference; included only for "overtime_premium"). */
  overtimePremiumCents: number;
  /** Internal payment estimate (see PAY_ESTIMATE_DISCLAIMER). */
  estimatedAmountCents: number;
  pendingExceptions: number;
}

type Segment = [Date, Date];

interface OpenShift {
  clockIn: SettlementPunch;
  segments: Segment[];
  workStart: Date | null;
  lunchStart: Date | null;
  lunchSeconds: number;
  lastAt: Date;
  punchIds: string[];
}

export function rateForDate(rates: RatePeriod[], ymd: string): number | null {
  let rate: number | null = null;
  for (const r of rates) {
    if (r.effectiveDate <= ymd) rate = r.rateCents;
  }
  return rate;
}

const seconds = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 1000);

/** Builds shifts from a time-ordered list of active punches. */
export function buildShifts(
  punches: SettlementPunch[],
  now: Date,
  maxShiftHours: number,
): { shifts: Array<ShiftSummary & { segments: Segment[] }>; orphanFlags: SettlementFlag[] } {
  const shifts: Array<ShiftSummary & { segments: Segment[] }> = [];
  const orphanFlags: SettlementFlag[] = [];
  let open: OpenShift | null = null;

  const close = (o: OpenShift, clockOut: Date | null, status: ShiftSummary["status"]) => {
    const workedSeconds = o.segments.reduce((s, [a, b]) => s + seconds(a, b), 0);
    shifts.push({
      clockIn: o.clockIn.at,
      clockOut,
      lunchSeconds: o.lunchSeconds,
      workedSeconds,
      workedSecondsInWeek: 0,
      status,
      punchIds: o.punchIds,
      segments: o.segments,
    });
  };

  const orphan = (p: SettlementPunch, code: FlagCode, message: string) =>
    orphanFlags.push({ code, message, at: p.at, punchId: p.id });

  for (const p of punches) {
    switch (p.type) {
      case "clock_in":
        if (open) close(open, null, open.lunchStart ? "missing_lunch_in" : "missing_clock_out");
        open = { clockIn: p, segments: [], workStart: p.at, lunchStart: null, lunchSeconds: 0, lastAt: p.at, punchIds: [p.id] };
        break;
      case "lunch_out":
        if (!open || !open.workStart) {
          orphan(p, "UNEXPECTED_PUNCH", "Lunch Out without an open shift.");
          break;
        }
        open.segments.push([open.workStart, p.at]);
        open.workStart = null;
        open.lunchStart = p.at;
        open.lastAt = p.at;
        open.punchIds.push(p.id);
        break;
      case "lunch_in":
        if (!open || !open.lunchStart) {
          orphan(p, "UNEXPECTED_PUNCH", "Lunch In without a Lunch Out.");
          break;
        }
        open.lunchSeconds += seconds(open.lunchStart, p.at);
        open.lunchStart = null;
        open.workStart = p.at;
        open.lastAt = p.at;
        open.punchIds.push(p.id);
        break;
      case "clock_out":
        if (!open) {
          orphan(p, "MISSING_CLOCK_IN", "Clock Out without a matching Clock In.");
          break;
        }
        open.punchIds.push(p.id);
        if (open.lunchStart) {
          // Time between Lunch Out and Clock Out is not counted as work.
          close(open, p.at, "missing_lunch_in");
        } else {
          open.segments.push([open.workStart as Date, p.at]);
          close(open, p.at, "complete");
        }
        open = null;
        break;
    }
  }

  if (open) {
    const recent = now.getTime() - open.lastAt.getTime() <= maxShiftHours * 3600_000;
    close(open, null, recent ? "in_progress" : open.lunchStart ? "missing_lunch_in" : "missing_clock_out");
  }
  return { shifts, orphanFlags };
}

export function calculateEmployeeWeek(
  punches: SettlementPunch[],
  rates: RatePeriod[],
  opts: SettlementOptions,
): EmployeeSettlement {
  const { week } = opts;
  const thresholdSeconds = (opts.overtimeThresholdHours ?? 40) * 3600;
  const longShiftSeconds = (opts.longShiftHours ?? 12) * 3600;
  const sorted = [...punches]
    .filter((p) => p.reviewStatus !== "rejected")
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const { shifts, orphanFlags } = buildShifts(sorted, opts.now, opts.maxShiftHours);

  const inWeek = (d: Date) => d >= week.start && d < week.end;
  const dayBounds = week.days.map((d) => ({ date: d, start: chicagoMidnight(d), end: chicagoMidnight(addDays(d, 1)) }));
  const daySeconds = new Map<string, number>(week.days.map((d) => [d, 0]));
  const flags: SettlementFlag[] = orphanFlags.filter((f) => f.at && inWeek(f.at));
  const relevant: ShiftSummary[] = [];

  for (const shift of shifts) {
    const shiftStart = shift.clockIn as Date;
    const shiftEnd = shift.clockOut ?? shift.segments.at(-1)?.[1] ?? shiftStart;
    if (!(shiftStart < week.end && shiftEnd >= week.start)) continue;

    let inWeekSeconds = 0;
    for (const [a, b] of shift.segments) {
      for (const day of dayBounds) {
        const s = a > day.start ? a : day.start;
        const e = b < day.end ? b : day.end;
        if (e > s) {
          const sec = seconds(s, e);
          daySeconds.set(day.date, (daySeconds.get(day.date) ?? 0) + sec);
          inWeekSeconds += sec;
        }
      }
    }
    const { segments: _segments, ...summary } = shift;
    void _segments;
    relevant.push({ ...summary, workedSecondsInWeek: inWeekSeconds });

    if (shift.status === "missing_clock_out") {
      flags.push({ code: "MISSING_CLOCK_OUT", message: "Shift has no Clock Out. Only completed segments are counted until corrected.", at: shiftStart, punchId: shift.punchIds[0] });
    } else if (shift.status === "missing_lunch_in") {
      flags.push({ code: "MISSING_LUNCH_IN", message: "Lunch Out without Lunch In. Time after Lunch Out is not counted until corrected.", at: shiftStart, punchId: shift.punchIds[0] });
    } else if (shift.status === "in_progress") {
      flags.push({ code: "IN_PROGRESS", message: "Shift in progress; the open segment is not yet counted.", at: shiftStart, punchId: shift.punchIds[0] });
    }
    if (shift.workedSeconds > longShiftSeconds) {
      flags.push({ code: "LONG_SHIFT", message: `Shift longer than ${opts.longShiftHours ?? 12} hours.`, at: shiftStart, punchId: shift.punchIds[0] });
    }
  }

  let pendingExceptions = 0;
  for (const p of sorted) {
    if (!inWeek(p.at)) continue;
    if (p.reviewStatus === "pending") {
      pendingExceptions++;
      flags.push({ code: "PENDING_EXCEPTION", message: "Location exception awaiting manager review.", at: p.at, punchId: p.id });
    }
    if (p.geofenceResult && ["outside", "low_accuracy", "stale"].includes(p.geofenceResult) && p.reviewStatus === "none") {
      flags.push({ code: "OUTSIDE_GEOFENCE", message: `Location check result "${p.geofenceResult}" (recorded in monitor mode).`, at: p.at, punchId: p.id });
    }
  }

  const days: DayTotal[] = week.days.map((date) => {
    const sec = daySeconds.get(date) ?? 0;
    const rate = rateForDate(rates, date);
    if (sec > 0 && rate === null) {
      flags.push({ code: "NO_RATE", message: `No hourly rate in effect on ${date}.`, at: chicagoMidnight(date), punchId: null });
    }
    const rateCents = rate ?? 0;
    return { date, seconds: sec, hours: hoursFromSeconds(sec), rateCents, amountCents: Math.round((sec * rateCents) / 3600) };
  });

  const totalSeconds = days.reduce((s, d) => s + d.seconds, 0);
  const straightPayCents = days.reduce((s, d) => s + d.amountCents, 0);
  const overtimeSeconds = Math.max(0, totalSeconds - thresholdSeconds);
  // Regular rate = straight-time pay / total hours (weighted when rates differ during the week).
  const premiumFactor = Math.max(0, opts.overtimeMultiplier - 1);
  const overtimePremiumCents = totalSeconds > 0 ? Math.round((premiumFactor * straightPayCents * overtimeSeconds) / totalSeconds) : 0;
  flags.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));

  return {
    days,
    shifts: relevant,
    flags,
    totalSeconds,
    totalHours: hoursFromSeconds(totalSeconds),
    regularHours: hoursFromSeconds(totalSeconds - overtimeSeconds),
    overtimeHours: hoursFromSeconds(overtimeSeconds),
    straightPayCents,
    overtimePremiumCents,
    estimatedAmountCents: straightPayCents + (opts.payEstimateMethod === "overtime_premium" ? overtimePremiumCents : 0),
    pendingExceptions,
  };
}

/** Punch query window needed to settle a week: overnight shifts may start before or end after it. */
export function settlementQueryWindow(week: PayWeek, maxShiftHours: number): { from: Date; to: Date } {
  const pad = maxShiftHours * 2 * 3600_000;
  return { from: new Date(week.start.getTime() - pad), to: new Date(week.end.getTime() + pad) };
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}


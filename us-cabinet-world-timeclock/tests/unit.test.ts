import { describe, expect, it } from "vitest";
import { distanceMeters, evaluateGeofence, isValidReading } from "@/lib/geo";
import { allowedActions, currentState, validatePunch } from "@/lib/punch-rules";
import { calculateEmployeeWeek, type SettlementPunch } from "@/lib/settlement";
import { csvCell, toCsv } from "@/lib/csv";
import { hashPin, hashPassword, isWeakPin, verifyPassword, generatePin } from "@/lib/security";
import {
  chicagoDate,
  chicagoMidnight,
  chicagoWallTimeToInstant as ct,
  fromChicagoLocalInput,
  payWeek,
  weekStartFor,
} from "@/lib/time";

describe("America/Chicago time and Friday–Thursday pay weeks", () => {
  it("maps any day to the Friday that starts its week", () => {
    expect(weekStartFor("2026-10-23")).toBe("2026-10-23"); // Friday
    expect(weekStartFor("2026-10-24")).toBe("2026-10-23"); // Saturday (weekend included)
    expect(weekStartFor("2026-10-29")).toBe("2026-10-23"); // Thursday
    expect(weekStartFor("2026-10-30")).toBe("2026-10-30"); // next Friday
  });

  it("returns start/end/pay dates", () => {
    const w = payWeek("2026-10-27");
    expect(w.startDate).toBe("2026-10-23");
    expect(w.endDate).toBe("2026-10-29");
    expect(w.payDate).toBe("2026-10-30");
    expect(w.start.toISOString()).toBe("2026-10-23T05:00:00.000Z"); // CDT midnight
    expect(w.end.toISOString()).toBe("2026-10-30T05:00:00.000Z");
  });

  it("handles DST: week containing the fall-back change is 169 hours long", () => {
    const w = payWeek("2026-11-01");
    expect(w.start.toISOString()).toBe("2026-10-30T05:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-06T06:00:00.000Z"); // CST midnight
    expect((w.end.getTime() - w.start.getTime()) / 3600_000).toBe(169);
  });

  it("converts instants to Chicago calendar dates around midnight", () => {
    expect(chicagoDate(new Date("2026-10-24T04:59:00Z"))).toBe("2026-10-23");
    expect(chicagoDate(new Date("2026-10-24T05:00:00Z"))).toBe("2026-10-24");
    expect(chicagoMidnight("2026-01-15").toISOString()).toBe("2026-01-15T06:00:00.000Z");
  });

  it("parses datetime-local input as Chicago time", () => {
    expect(fromChicagoLocalInput("2026-10-23T08:30")?.toISOString()).toBe("2026-10-23T13:30:00.000Z");
    expect(fromChicagoLocalInput("2026-02-30T08:30")).toBeNull();
    expect(fromChicagoLocalInput("garbage")).toBeNull();
  });
});

describe("punch sequencing", () => {
  const now = new Date("2026-10-23T15:00:00Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

  it("allows the right actions for each state", () => {
    expect(allowedActions(currentState(null, now, 16))).toEqual(["clock_in"]);
    expect(allowedActions(currentState({ type: "clock_in", at: at(60) }, now, 16))).toEqual(["lunch_out", "clock_out"]);
    expect(allowedActions(currentState({ type: "lunch_out", at: at(30) }, now, 16))).toEqual(["lunch_in"]);
    expect(allowedActions(currentState({ type: "lunch_in", at: at(30) }, now, 16))).toEqual(["lunch_out", "clock_out"]);
    expect(allowedActions(currentState({ type: "clock_out", at: at(30) }, now, 16))).toEqual(["clock_in"]);
  });

  it("rejects invalid sequences with clear messages", () => {
    const off = currentState(null, now, 16);
    expect(validatePunch("clock_out", off, now, 60)?.code).toBe("INVALID_SEQUENCE");
    expect(validatePunch("lunch_out", off, now, 60)?.code).toBe("INVALID_SEQUENCE");
    const lunch = currentState({ type: "lunch_out", at: at(30) }, now, 16);
    expect(validatePunch("clock_out", lunch, now, 60)?.message).toMatch(/Lunch In before clocking out/);
    const working = currentState({ type: "clock_in", at: at(30) }, now, 16);
    expect(validatePunch("clock_in", working, now, 60)?.message).toMatch(/already clocked in/);
    expect(validatePunch("lunch_out", working, now, 60)).toBeNull();
  });

  it("blocks accidental duplicate punches inside the window", () => {
    const justIn = currentState({ type: "clock_in", at: new Date(now.getTime() - 20_000) }, now, 16);
    const v = validatePunch("lunch_out", justIn, now, 60);
    expect(v?.code).toBe("DUPLICATE_PUNCH");
    expect(v && "retryAfterSeconds" in v ? v.retryAfterSeconds : 0).toBe(40);
  });

  it("lets an employee clock in when yesterday's shift was never closed", () => {
    const stale = currentState({ type: "clock_in", at: at(17 * 60) }, now, 16);
    expect(stale.stale).toBe(true);
    expect(validatePunch("clock_in", stale, now, 60)).toBeNull();
  });
});

describe("geofence", () => {
  const site = { latitude: 35.442, longitude: -97.673, radiusM: 100, maxAccuracyM: 100, maxLocationAgeS: 120 };

  it("computes distances", () => {
    // ~0.001 degree latitude ≈ 111 m
    expect(distanceMeters(35.442, -97.673, 35.443, -97.673)).toBeGreaterThan(110);
    expect(distanceMeters(35.442, -97.673, 35.443, -97.673)).toBeLessThan(112);
  });

  it("accepts a fresh, accurate reading inside the radius", () => {
    expect(evaluateGeofence({ latitude: 35.4425, longitude: -97.673, accuracy: 15, ageSeconds: 3 }, site).result).toBe("inside");
  });

  it("rejects outside, inaccurate and stale readings", () => {
    expect(evaluateGeofence({ latitude: 35.45, longitude: -97.673, accuracy: 10, ageSeconds: 3 }, site).result).toBe("outside");
    expect(evaluateGeofence({ latitude: 35.442, longitude: -97.673, accuracy: 500, ageSeconds: 3 }, site).result).toBe("low_accuracy");
    expect(evaluateGeofence({ latitude: 35.442, longitude: -97.673, accuracy: 10, ageSeconds: 600 }, site).result).toBe("stale");
  });

  it("validates reading shape", () => {
    expect(isValidReading({ latitude: 1, longitude: 2, accuracy: 3, ageSeconds: 0 })).toBe(true);
    expect(isValidReading({ latitude: "1", longitude: 2, accuracy: 3, ageSeconds: 0 })).toBe(false);
    expect(isValidReading({ latitude: 91, longitude: 2, accuracy: 3, ageSeconds: 0 })).toBe(false);
    expect(isValidReading(null)).toBe(false);
  });
});

describe("weekly settlement", () => {
  let n = 0;
  const p = (type: SettlementPunch["type"], at: Date, extra: Partial<SettlementPunch> = {}): SettlementPunch => ({
    id: `p${++n}`,
    type,
    at,
    reviewStatus: "none",
    geofenceResult: "inside",
    source: "phone",
    ...extra,
  });
  const rate20 = [{ effectiveDate: "2026-01-01", rateCents: 2000 }];
  const opts = (weekDate: string, now = new Date("2026-12-01T00:00:00Z")) => ({
    week: payWeek(weekDate),
    now,
    maxShiftHours: 16,
    payEstimateMethod: "flat_rate" as const,
    overtimeMultiplier: 1.5,
  });

  it("subtracts the actual lunch, not a fixed deduction", () => {
    const r = calculateEmployeeWeek(
      [
        p("clock_in", ct("2026-10-23", 8, 0)),
        p("lunch_out", ct("2026-10-23", 12, 0)),
        p("lunch_in", ct("2026-10-23", 12, 47)),
        p("clock_out", ct("2026-10-23", 17, 0)),
      ],
      rate20,
      opts("2026-10-23"),
    );
    expect(r.totalSeconds).toBe(9 * 3600 - 47 * 60);
    expect(r.days[0].hours).toBe(8.22);
    expect(r.straightPayCents).toBe(Math.round((8 * 3600 + 13 * 60) * 2000 / 3600));
    expect(r.shifts[0].lunchSeconds).toBe(47 * 60);
    expect(r.flags).toEqual([]);
  });

  it("counts a shift with no lunch fully", () => {
    const r = calculateEmployeeWeek([p("clock_in", ct("2026-10-24", 9, 0)), p("clock_out", ct("2026-10-24", 13, 30))], rate20, opts("2026-10-24"));
    expect(r.totalHours).toBe(4.5);
    expect(r.days.find((d) => d.date === "2026-10-24")?.hours).toBe(4.5); // Saturday counts
  });

  it("splits an overnight shift across days and across the Thursday→Friday week boundary", () => {
    const punches = [p("clock_in", ct("2026-10-29", 22, 0)), p("clock_out", ct("2026-10-30", 6, 0))];
    const thisWeek = calculateEmployeeWeek(punches, rate20, opts("2026-10-29"));
    const nextWeek = calculateEmployeeWeek(punches, rate20, opts("2026-10-30"));
    expect(thisWeek.totalHours).toBe(2);
    expect(thisWeek.days.at(-1)).toMatchObject({ date: "2026-10-29", hours: 2 });
    expect(nextWeek.totalHours).toBe(6);
    expect(nextWeek.days[0]).toMatchObject({ date: "2026-10-30", hours: 6 });
  });

  it("uses real elapsed time across the DST fall-back night", () => {
    const r = calculateEmployeeWeek([p("clock_in", ct("2026-10-31", 22, 0)), p("clock_out", ct("2026-11-01", 6, 0))], rate20, opts("2026-11-01"));
    expect(r.totalHours).toBe(9); // 22:00 CDT → 06:00 CST is 9 real hours
    expect(r.days.find((d) => d.date === "2026-10-31")?.hours).toBe(2);
    expect(r.days.find((d) => d.date === "2026-11-01")?.hours).toBe(7);
  });

  const fortyFive = () => {
    const punches: SettlementPunch[] = [];
    for (const d of ["2026-10-23", "2026-10-24", "2026-10-26", "2026-10-27", "2026-10-28"]) {
      punches.push(p("clock_in", ct(d, 7, 0)), p("clock_out", ct(d, 16, 0)));
    }
    return punches;
  };

  it("flat-rate estimate: all hours (including over 40) × regular rate, over-40 hours still reported", () => {
    const flat = calculateEmployeeWeek(fortyFive(), rate20, opts("2026-10-23"));
    expect(flat.totalHours).toBe(45);
    expect(flat.regularHours).toBe(40);
    expect(flat.overtimeHours).toBe(5);
    expect(flat.straightPayCents).toBe(90000);
    expect(flat.estimatedAmountCents).toBe(90000); // 45 h × $20
    expect(flat.overtimePremiumCents).toBe(5000); // reference only: 5 h × $20 × 0.5
  });

  it("keeps the overtime multiplier configurable for future use", () => {
    const premium = calculateEmployeeWeek(fortyFive(), rate20, { ...opts("2026-10-23"), payEstimateMethod: "overtime_premium" });
    expect(premium.overtimePremiumCents).toBe(5000);
    expect(premium.estimatedAmountCents).toBe(95000);
    const double = calculateEmployeeWeek(fortyFive(), rate20, { ...opts("2026-10-23"), payEstimateMethod: "overtime_premium", overtimeMultiplier: 2 });
    expect(double.overtimePremiumCents).toBe(10000);
    expect(double.estimatedAmountCents).toBe(100000);
    const flatAt2 = calculateEmployeeWeek(fortyFive(), rate20, { ...opts("2026-10-23"), overtimeMultiplier: 2 });
    expect(flatAt2.overtimePremiumCents).toBe(10000);
    expect(flatAt2.estimatedAmountCents).toBe(90000); // multiplier never changes the flat-rate estimate
  });

  it("has no over-40 hours or premium for a normal week", () => {
    const r = calculateEmployeeWeek(fortyFive().slice(0, 8), rate20, { ...opts("2026-10-23"), payEstimateMethod: "overtime_premium" });
    expect(r.totalHours).toBe(36);
    expect(r.overtimeHours).toBe(0);
    expect(r.overtimePremiumCents).toBe(0);
    expect(r.estimatedAmountCents).toBe(72000);
  });

  it("uses the rate in effect on each worked day", () => {
    const rates = [
      { effectiveDate: "2026-01-01", rateCents: 2000 },
      { effectiveDate: "2026-10-26", rateCents: 2200 },
    ];
    const r = calculateEmployeeWeek(
      [p("clock_in", ct("2026-10-23", 8, 0)), p("clock_out", ct("2026-10-23", 16, 0)), p("clock_in", ct("2026-10-26", 8, 0)), p("clock_out", ct("2026-10-26", 16, 0))],
      rates,
      opts("2026-10-23"),
    );
    expect(r.straightPayCents).toBe(8 * 2000 + 8 * 2200);
  });

  it("flags a missing clock-out and counts only completed segments", () => {
    const r = calculateEmployeeWeek(
      [p("clock_in", ct("2026-10-23", 8, 0)), p("lunch_out", ct("2026-10-23", 12, 0)), p("lunch_in", ct("2026-10-23", 12, 30))],
      rate20,
      opts("2026-10-23"),
    );
    expect(r.totalHours).toBe(4);
    expect(r.flags.map((f) => f.code)).toContain("MISSING_CLOCK_OUT");
  });

  it("treats a recent open shift as in progress", () => {
    const r = calculateEmployeeWeek([p("clock_in", ct("2026-10-23", 8, 0))], rate20, opts("2026-10-23", ct("2026-10-23", 10, 0)));
    expect(r.totalHours).toBe(0);
    expect(r.flags.map((f) => f.code)).toEqual(["IN_PROGRESS"]);
  });

  it("flags pending exceptions, monitor-mode outside punches, missing rates and orphan punches", () => {
    const r = calculateEmployeeWeek(
      [
        p("clock_out", ct("2026-10-23", 7, 0)),
        p("clock_in", ct("2026-10-23", 8, 0), { reviewStatus: "pending", geofenceResult: "unavailable" }),
        p("clock_out", ct("2026-10-23", 16, 0), { geofenceResult: "outside" }),
      ],
      [],
      opts("2026-10-23"),
    );
    expect(r.totalHours).toBe(8); // pending punches still count, but are flagged
    expect(r.pendingExceptions).toBe(1);
    expect(r.flags.map((f) => f.code).sort()).toEqual(["MISSING_CLOCK_IN", "NO_RATE", "OUTSIDE_GEOFENCE", "PENDING_EXCEPTION"]);
  });

  it("ignores rejected punches", () => {
    const r = calculateEmployeeWeek(
      [p("clock_in", ct("2026-10-23", 8, 0)), p("clock_out", ct("2026-10-23", 16, 0), { reviewStatus: "rejected" })],
      rate20,
      opts("2026-10-23"),
    );
    expect(r.flags.map((f) => f.code)).toContain("MISSING_CLOCK_OUT");
  });
});

describe("security helpers", () => {
  it("hashes PINs deterministically with a secret and never returns the PIN", () => {
    const a = hashPin("482913", "pepper-one-xxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(a).toHaveLength(64);
    expect(a).not.toContain("482913");
    expect(hashPin("482913", "pepper-one-xxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(a);
    expect(hashPin("482913", "pepper-two-xxxxxxxxxxxxxxxxxxxxxxxxxx")).not.toBe(a);
  });

  it("rejects weak PINs and generates strong ones", () => {
    expect(isWeakPin("111111")).toBe(true);
    expect(isWeakPin("123456")).toBe(true);
    expect(isWeakPin("654321")).toBe(true);
    expect(isWeakPin("482913")).toBe(false);
    for (let i = 0; i < 50; i++) expect(generatePin()).toMatch(/^\d{6}$/);
  });

  it("verifies scrypt password hashes", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong password!!", h)).toBe(false);
  });
});

describe("CSV", () => {
  it("quotes and neutralizes formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(-5)).toBe("-5");
    expect(toCsv(["a", "b"], [[1, null]])).toBe("a,b\r\n1,\r\n");
  });
});

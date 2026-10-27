/** Pure punch sequencing rules shared by the API, the admin views and settlement. */

export const PUNCH_TYPES = ["clock_in", "lunch_out", "lunch_in", "clock_out"] as const;
export type PunchType = (typeof PUNCH_TYPES)[number];

export const PUNCH_LABELS: Record<PunchType, string> = {
  clock_in: "Clock In",
  lunch_out: "Lunch Out",
  lunch_in: "Lunch In",
  clock_out: "Clock Out",
};

export type ClockState = "off" | "working" | "lunch";

export const STATE_LABELS: Record<ClockState, string> = {
  off: "Clocked out",
  working: "Working",
  lunch: "On lunch",
};

export function isPunchType(value: unknown): value is PunchType {
  return typeof value === "string" && (PUNCH_TYPES as readonly string[]).includes(value);
}

export interface LastPunch {
  type: PunchType;
  at: Date;
}

export interface CurrentState {
  state: ClockState;
  /** Time of the punch that put the employee in this state. */
  since: Date | null;
  /**
   * True when the employee appears to be on the clock but the last punch is older than the
   * maximum shift length (usually a forgotten clock-out). A new Clock In is then allowed and
   * the open shift is reported as irregular for manager correction.
   */
  stale: boolean;
}

export function stateFromPunch(type: PunchType): ClockState {
  if (type === "clock_out") return "off";
  if (type === "lunch_out") return "lunch";
  return "working";
}

export function currentState(last: LastPunch | null, now: Date, maxShiftHours: number): CurrentState {
  if (!last) return { state: "off", since: null, stale: false };
  const state = stateFromPunch(last.type);
  const stale = state !== "off" && now.getTime() - last.at.getTime() > maxShiftHours * 3600_000;
  return { state, since: last.at, stale };
}

export function allowedActions(cs: CurrentState): PunchType[] {
  const base: Record<ClockState, PunchType[]> = {
    off: ["clock_in"],
    working: ["lunch_out", "clock_out"],
    lunch: ["lunch_in"],
  };
  const actions = [...base[cs.state]];
  if (cs.stale && !actions.includes("clock_in")) actions.unshift("clock_in");
  return actions;
}

export type RuleViolation =
  | { code: "INVALID_SEQUENCE"; message: string }
  | { code: "DUPLICATE_PUNCH"; message: string; retryAfterSeconds: number };

const SEQUENCE_MESSAGES: Record<ClockState, Partial<Record<PunchType, string>>> = {
  off: {
    lunch_out: "You are not clocked in. Tap Clock In first.",
    lunch_in: "You are not on lunch. Tap Clock In to start your shift.",
    clock_out: "You are already clocked out.",
  },
  working: {
    clock_in: "You are already clocked in.",
    lunch_in: "You are not on lunch.",
  },
  lunch: {
    clock_in: "You are on lunch. Tap Lunch In first.",
    lunch_out: "You are already on lunch.",
    clock_out: "You are on lunch. Tap Lunch In before clocking out.",
  },
};

/** Validates a requested punch against the current state and the duplicate-punch window. */
export function validatePunch(
  action: PunchType,
  cs: CurrentState,
  now: Date,
  duplicateWindowSeconds: number,
): RuleViolation | null {
  if (cs.since) {
    const elapsed = (now.getTime() - cs.since.getTime()) / 1000;
    if (elapsed < duplicateWindowSeconds) {
      const retryAfterSeconds = Math.max(1, Math.ceil(duplicateWindowSeconds - elapsed));
      return {
        code: "DUPLICATE_PUNCH",
        message: `Your last punch was recorded ${Math.max(0, Math.floor(elapsed))} seconds ago. To prevent accidental double punches, wait ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
      };
    }
  }
  if (allowedActions(cs).includes(action)) return null;
  return {
    code: "INVALID_SEQUENCE",
    message: SEQUENCE_MESSAGES[cs.state][action] ?? "That action is not allowed right now.",
  };
}

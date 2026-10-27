import "server-only";
import type { Queryable } from "../db";
import { currentState, type ClockState, type PunchType } from "../punch-rules";
import {
  calculateEmployeeWeek,
  settlementQueryWindow,
  type EmployeeSettlement,
  type RatePeriod,
  type SettlementPunch,
} from "../settlement";
import { payWeek, type PayWeek } from "../time";
import { writeAudit, type Actor } from "./audit";
import { EFFECTIVE_PUNCH, type PunchRow } from "./punches";
import { getSettings, type SiteSettings } from "./settings";

export interface StatusBoardRow {
  employee_id: string;
  employee_code: string;
  first_name: string;
  last_name: string;
  state: ClockState;
  since: Date | null;
  stale: boolean;
  last_punch_type: PunchType | null;
  last_review_status: string | null;
}

export async function statusBoard(db: Queryable, now = new Date()): Promise<StatusBoardRow[]> {
  const settings = await getSettings(db);
  const res = await db.query<{
    id: string;
    employee_code: string;
    first_name: string;
    last_name: string;
    punch_type: PunchType | null;
    punched_at: Date | null;
    review_status: string | null;
  }>(
    `select e.id, e.employee_code, e.first_name, e.last_name, p.punch_type, p.punched_at, p.review_status
     from employees e
     left join lateral (
       select punch_type, punched_at, review_status from punches
       where employee_id = e.id and ${EFFECTIVE_PUNCH} order by punched_at desc, created_at desc limit 1
     ) p on true
     where e.active order by e.last_name, e.first_name`,
  );
  return res.rows.map((r) => {
    const cs = currentState(r.punch_type && r.punched_at ? { type: r.punch_type, at: r.punched_at } : null, now, settings.max_shift_hours);
    return {
      employee_id: r.id,
      employee_code: r.employee_code,
      first_name: r.first_name,
      last_name: r.last_name,
      state: cs.state,
      since: cs.since,
      stale: cs.stale,
      last_punch_type: r.punch_type,
      last_review_status: r.review_status,
    };
  });
}

function toSettlementPunch(p: PunchRow): SettlementPunch {
  return {
    id: p.id,
    type: p.punch_type,
    at: p.punched_at,
    reviewStatus: p.review_status,
    geofenceResult: p.geofence_result,
    source: p.source,
  };
}

async function ratesFor(db: Queryable, employeeIds: string[]): Promise<Map<string, RatePeriod[]>> {
  const map = new Map<string, RatePeriod[]>();
  if (!employeeIds.length) return map;
  const res = await db.query<{ employee_id: string; hourly_rate_cents: number; effective_date: string }>(
    `select employee_id, hourly_rate_cents, effective_date from employee_rates where employee_id = any($1) order by effective_date`,
    [employeeIds],
  );
  for (const r of res.rows) {
    const list = map.get(r.employee_id) ?? [];
    list.push({ effectiveDate: r.effective_date, rateCents: r.hourly_rate_cents });
    map.set(r.employee_id, list);
  }
  return map;
}

export interface SettlementRow extends EmployeeSettlement {
  employeeId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  active: boolean;
  /** Rate in effect on the last day of the week (for display). */
  currentRateCents: number | null;
}

export interface WeeklySettlement {
  week: { startDate: string; endDate: string; payDate: string; days: string[] };
  generatedAt: string;
  overtimePolicy: SiteSettings["overtime_policy"];
  rows: SettlementRow[];
  totals: { totalHours: number; overtimeHours: number; straightPayCents: number; overtimePremiumCents: number; amountDueCents: number };
}

/** Computes the live weekly settlement from raw punches (nothing is stored). */
export async function weeklySettlement(db: Queryable, weekDate: string, now = new Date()): Promise<WeeklySettlement> {
  const week = payWeek(weekDate);
  const settings = await getSettings(db);
  const { from, to } = settlementQueryWindow(week, settings.max_shift_hours);
  const punchRes = await db.query<PunchRow>(
    `select * from punches where ${EFFECTIVE_PUNCH} and punched_at >= $1 and punched_at < $2 order by punched_at, created_at`,
    [from, to],
  );
  const byEmployee = new Map<string, SettlementPunch[]>();
  for (const p of punchRes.rows) {
    const list = byEmployee.get(p.employee_id) ?? [];
    list.push(toSettlementPunch(p));
    byEmployee.set(p.employee_id, list);
  }
  const empRes = await db.query<{ id: string; employee_code: string; first_name: string; last_name: string; active: boolean }>(
    `select id, employee_code, first_name, last_name, active from employees where active or id = any($1) order by last_name, first_name`,
    [[...byEmployee.keys()]],
  );
  const rates = await ratesFor(db, empRes.rows.map((e) => e.id));
  const rows: SettlementRow[] = [];
  for (const e of empRes.rows) {
    const empRates = rates.get(e.id) ?? [];
    const calc = calculateEmployeeWeek(byEmployee.get(e.id) ?? [], empRates, {
      week,
      now,
      maxShiftHours: settings.max_shift_hours,
      overtimePolicy: settings.overtime_policy,
    });
    if (!e.active && calc.totalSeconds === 0 && calc.flags.length === 0) continue;
    const lastRate = empRates.filter((r) => r.effectiveDate <= week.endDate).at(-1);
    rows.push({
      employeeId: e.id,
      employeeCode: e.employee_code,
      firstName: e.first_name,
      lastName: e.last_name,
      active: e.active,
      currentRateCents: lastRate?.rateCents ?? null,
      ...calc,
    });
  }
  const sum = (f: (r: SettlementRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    week: { startDate: week.startDate, endDate: week.endDate, payDate: week.payDate, days: week.days },
    generatedAt: now.toISOString(),
    overtimePolicy: settings.overtime_policy,
    rows,
    totals: {
      totalHours: Math.round(sum((r) => r.totalHours) * 100) / 100,
      overtimeHours: Math.round(sum((r) => r.overtimeHours) * 100) / 100,
      straightPayCents: sum((r) => r.straightPayCents),
      overtimePremiumCents: sum((r) => r.overtimePremiumCents),
      amountDueCents: sum((r) => r.amountDueCents),
    },
  };
}

export interface TimecardPunch extends PunchRow {
  created_by_admin_name: string | null;
  reviewed_by_name: string | null;
}

/** All punches (including voided ones, for history) touching an employee's pay week. */
export async function employeeTimecard(db: Queryable, employeeId: string, weekDate: string, now = new Date()) {
  const week: PayWeek = payWeek(weekDate);
  const settings = await getSettings(db);
  const { from, to } = settlementQueryWindow(week, settings.max_shift_hours);
  const res = await db.query<TimecardPunch>(
    `select p.*, ca.display_name as created_by_admin_name, rv.display_name as reviewed_by_name
     from punches p
     left join admin_users ca on ca.id = p.created_by_admin
     left join admin_users rv on rv.id = p.reviewed_by
     where p.employee_id = $1 and p.punched_at >= $2 and p.punched_at < $3
     order by p.punched_at, p.created_at`,
    [employeeId, from, to],
  );
  const effective = res.rows.filter((p) => p.voided_at === null && p.review_status !== "rejected");
  const rates = (await ratesFor(db, [employeeId])).get(employeeId) ?? [];
  const settlement = calculateEmployeeWeek(effective.map(toSettlementPunch), rates, {
    week,
    now,
    maxShiftHours: settings.max_shift_hours,
    overtimePolicy: settings.overtime_policy,
  });
  const inWeek = res.rows.filter((p) => p.punched_at >= week.start && p.punched_at < week.end);
  return { week, punches: inWeek, settlement };
}

export async function finalizeWeek(db: Queryable, weekDate: string, note: string, actor: Actor, now = new Date()): Promise<string> {
  const report = await weeklySettlement(db, weekDate, now);
  const res = await db.query<{ id: string }>(
    `insert into settlement_snapshots (week_start, finalized_by, note, data) values ($1, $2, $3, $4) returning id`,
    [report.week.startDate, actor.id, note.trim() || null, JSON.stringify(report)],
  );
  await writeAudit(db, actor, "settlement.finalize", "settlement_snapshot", res.rows[0].id, {
    reason: note.trim() || null,
    after: { week_start: report.week.startDate, totals: report.totals },
  });
  return res.rows[0].id;
}

export async function listSnapshots(db: Queryable, weekStart: string) {
  const res = await db.query<{ id: string; finalized_at: Date; note: string | null; display_name: string | null; amount_due_cents: string }>(
    `select s.id, s.finalized_at, s.note, a.display_name, (s.data->'totals'->>'amountDueCents') as amount_due_cents
     from settlement_snapshots s left join admin_users a on a.id = s.finalized_by
     where s.week_start = $1 order by s.finalized_at desc`,
    [weekStart],
  );
  return res.rows;
}

import "server-only";
import type { Queryable } from "../db";
import { AppError } from "../errors";
import { generatePin, hashPin, isValidPinFormat, isWeakPin } from "../security";
import { isYmd } from "../time";
import { writeAudit, type Actor } from "./audit";

export interface EmployeeRow {
  id: string;
  employee_code: string;
  first_name: string;
  last_name: string;
  active: boolean;
  notes: string | null;
  created_at: Date;
  deactivated_at: Date | null;
}

export interface EmployeeWithRate extends EmployeeRow {
  current_rate_cents: number | null;
  current_rate_effective: string | null;
}

export interface RateRow {
  id: string;
  hourly_rate_cents: number;
  effective_date: string;
  created_at: Date;
}

const PUBLIC_COLUMNS = "id, employee_code, first_name, last_name, active, notes, created_at, deactivated_at";

export async function listEmployees(db: Queryable, today: string, opts: { includeInactive?: boolean } = {}): Promise<EmployeeWithRate[]> {
  const res = await db.query<EmployeeWithRate>(
    `select e.id, e.employee_code, e.first_name, e.last_name, e.active, e.notes, e.created_at, e.deactivated_at,
            r.hourly_rate_cents as current_rate_cents, r.effective_date as current_rate_effective
     from employees e
     left join lateral (
       select hourly_rate_cents, effective_date from employee_rates
       where employee_id = e.id and effective_date <= $1 order by effective_date desc limit 1
     ) r on true
     ${opts.includeInactive ? "" : "where e.active"}
     order by e.active desc, e.last_name, e.first_name`,
    [today],
  );
  return res.rows;
}

export async function getEmployee(db: Queryable, id: string): Promise<EmployeeRow | null> {
  if (!isUuid(id)) return null;
  const res = await db.query<EmployeeRow>(`select ${PUBLIC_COLUMNS} from employees where id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function listRates(db: Queryable, employeeId: string): Promise<RateRow[]> {
  const res = await db.query<RateRow>(
    `select id, hourly_rate_cents, effective_date, created_at from employee_rates where employee_id = $1 order by effective_date`,
    [employeeId],
  );
  return res.rows;
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function cleanName(v: string, label: string): string {
  const s = v.trim().replace(/\s+/g, " ");
  if (s.length < 1 || s.length > 60) throw new AppError("INVALID_INPUT", `${label} is required (max 60 characters).`);
  return s;
}

function cleanCode(v: string): string {
  const s = v.trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,20}$/.test(s)) throw new AppError("INVALID_INPUT", "Employee code must be 1–20 letters, digits or dashes.");
  return s;
}

export function parseRateToCents(v: string): number {
  const s = v.trim().replace(/^\$/, "");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) throw new AppError("INVALID_INPUT", "Hourly rate must be a dollar amount like 18.50.");
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

function checkPin(pin: string) {
  if (!isValidPinFormat(pin)) throw new AppError("INVALID_INPUT", "PIN must be exactly 6 digits.");
  if (isWeakPin(pin)) throw new AppError("INVALID_INPUT", "PIN is too easy to guess (repeated or sequential digits).");
}

async function pinTaken(db: Queryable, lookup: string, exceptId?: string): Promise<boolean> {
  const res = await db.query(`select 1 from employees where pin_lookup = $1 and id is distinct from $2`, [lookup, exceptId ?? null]);
  return (res.rowCount ?? 0) > 0;
}

/** Picks a random unused PIN, or validates a requested one. */
async function choosePin(db: Queryable, pepper: string, requested: string | null, exceptId?: string): Promise<string> {
  if (requested) {
    checkPin(requested);
    if (await pinTaken(db, hashPin(requested, pepper), exceptId)) throw new AppError("PIN_TAKEN", "That PIN is not available. Choose another or leave blank to generate one.");
    return requested;
  }
  for (let i = 0; i < 50; i++) {
    const pin = generatePin();
    if (!(await pinTaken(db, hashPin(pin, pepper), exceptId))) return pin;
  }
  throw new Error("Could not generate a unique PIN");
}

export interface NewEmployeeInput {
  employeeCode: string;
  firstName: string;
  lastName: string;
  pin: string | null;
  rate: string;
  rateEffectiveDate: string;
  notes?: string | null;
}

/** Creates an employee. Returns the PIN once so the administrator can give it to the employee. */
export async function createEmployee(db: Queryable, pepper: string, input: NewEmployeeInput, actor: Actor): Promise<{ employee: EmployeeRow; pin: string }> {
  const code = cleanCode(input.employeeCode);
  const first = cleanName(input.firstName, "First name");
  const last = cleanName(input.lastName, "Last name");
  const rateCents = parseRateToCents(input.rate);
  if (!isYmd(input.rateEffectiveDate)) throw new AppError("INVALID_INPUT", "Rate effective date is invalid.");
  const existing = await db.query(`select 1 from employees where employee_code = $1`, [code]);
  if (existing.rowCount) throw new AppError("CODE_TAKEN", `Employee code ${code} is already used.`);
  const pin = await choosePin(db, pepper, input.pin?.trim() || null);
  const res = await db.query<EmployeeRow>(
    `insert into employees (employee_code, first_name, last_name, pin_lookup, notes)
     values ($1, $2, $3, $4, $5) returning ${PUBLIC_COLUMNS}`,
    [code, first, last, hashPin(pin, pepper), input.notes?.trim() || null],
  );
  const employee = res.rows[0];
  await db.query(
    `insert into employee_rates (employee_id, hourly_rate_cents, effective_date, created_by) values ($1, $2, $3, $4)`,
    [employee.id, rateCents, input.rateEffectiveDate, actor.id],
  );
  await writeAudit(db, actor, "employee.create", "employee", employee.id, {
    after: { employee_code: code, first_name: first, last_name: last, hourly_rate_cents: rateCents, rate_effective_date: input.rateEffectiveDate },
  });
  return { employee, pin };
}

export async function updateEmployee(
  db: Queryable,
  id: string,
  input: { employeeCode: string; firstName: string; lastName: string; notes: string | null },
  actor: Actor,
): Promise<void> {
  const before = await getEmployee(db, id);
  if (!before) throw new AppError("NOT_FOUND", "Employee not found.", 404);
  const code = cleanCode(input.employeeCode);
  const first = cleanName(input.firstName, "First name");
  const last = cleanName(input.lastName, "Last name");
  const dup = await db.query(`select 1 from employees where employee_code = $1 and id <> $2`, [code, id]);
  if (dup.rowCount) throw new AppError("CODE_TAKEN", `Employee code ${code} is already used.`);
  await db.query(
    `update employees set employee_code = $2, first_name = $3, last_name = $4, notes = $5, updated_at = now() where id = $1`,
    [id, code, first, last, input.notes?.trim() || null],
  );
  await writeAudit(db, actor, "employee.update", "employee", id, {
    before: { employee_code: before.employee_code, first_name: before.first_name, last_name: before.last_name, notes: before.notes },
    after: { employee_code: code, first_name: first, last_name: last, notes: input.notes?.trim() || null },
  });
}

export async function setEmployeeActive(db: Queryable, id: string, active: boolean, actor: Actor, reason: string): Promise<void> {
  const before = await getEmployee(db, id);
  if (!before) throw new AppError("NOT_FOUND", "Employee not found.", 404);
  await db.query(
    `update employees set active = $2, deactivated_at = case when $2 then null else now() end, updated_at = now() where id = $1`,
    [id, active],
  );
  await writeAudit(db, actor, active ? "employee.reactivate" : "employee.deactivate", "employee", id, {
    before: { active: before.active },
    after: { active },
    reason: reason.trim() || null,
  });
}

export async function resetPin(db: Queryable, pepper: string, id: string, requested: string | null, actor: Actor): Promise<string> {
  const before = await getEmployee(db, id);
  if (!before) throw new AppError("NOT_FOUND", "Employee not found.", 404);
  const pin = await choosePin(db, pepper, requested?.trim() || null, id);
  await db.query(`update employees set pin_lookup = $2, updated_at = now() where id = $1`, [id, hashPin(pin, pepper)]);
  await writeAudit(db, actor, "employee.reset_pin", "employee", id, {});
  return pin;
}

/** Adds or replaces the rate effective on a date. Earlier weeks keep their original rates. */
export async function setRate(db: Queryable, id: string, rate: string, effectiveDate: string, actor: Actor): Promise<void> {
  const emp = await getEmployee(db, id);
  if (!emp) throw new AppError("NOT_FOUND", "Employee not found.", 404);
  if (!isYmd(effectiveDate)) throw new AppError("INVALID_INPUT", "Effective date is invalid.");
  const cents = parseRateToCents(rate);
  const prev = await db.query<{ hourly_rate_cents: number }>(
    `select hourly_rate_cents from employee_rates where employee_id = $1 and effective_date = $2`,
    [id, effectiveDate],
  );
  await db.query(
    `insert into employee_rates (employee_id, hourly_rate_cents, effective_date, created_by) values ($1, $2, $3, $4)
     on conflict (employee_id, effective_date) do update set hourly_rate_cents = excluded.hourly_rate_cents, created_by = excluded.created_by, created_at = now()`,
    [id, cents, effectiveDate, actor.id],
  );
  await writeAudit(db, actor, "employee.set_rate", "employee", id, {
    before: prev.rows[0] ? { hourly_rate_cents: prev.rows[0].hourly_rate_cents, effective_date: effectiveDate } : null,
    after: { hourly_rate_cents: cents, effective_date: effectiveDate },
  });
}

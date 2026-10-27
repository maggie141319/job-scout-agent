import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { requireAdmin } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { PUNCH_LABELS, PUNCH_TYPES } from "@/lib/punch-rules";
import { formatCents, PAY_ESTIMATE_DISCLAIMER } from "@/lib/settlement";
import { getEmployee, isUuid, listEmployees } from "@/lib/services/employees";
import { employeeTimecard } from "@/lib/services/reports";
import { addDays, chicagoDate, formatDateTime, formatTime, formatYmd, hoursFromSeconds, isYmd, toChicagoLocalInput, weekStartFor } from "@/lib/time";
import { addPunchAction, replacePunchAction, voidPunchAction } from "../../actions";

export default async function TimecardsPage({ searchParams }: { searchParams: Promise<{ employee?: string; week?: string }> }) {
  const { user } = await requireAdmin();
  const isAdmin = user.role === "admin";
  const sp = await searchParams;
  const db = getPool();
  const now = new Date();
  const week = weekStartFor(sp.week && isYmd(sp.week) ? sp.week : chicagoDate(now));
  const employees = await listEmployees(db, chicagoDate(now), { includeInactive: true });
  const employee = sp.employee && isUuid(sp.employee) ? await getEmployee(db, sp.employee) : null;
  const tc = employee ? await employeeTimecard(db, employee.id, week, now) : null;
  const qs = (w: string) => `/admin/timecards?employee=${employee?.id ?? ""}&week=${w}`;

  return (
    <div className="space-y-5">
      <form className="card flex flex-wrap items-end gap-3" action="/admin/timecards">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="employee">Employee</label>
          <select id="employee" name="employee" defaultValue={employee?.id ?? ""} className="input">
            <option value="">Select…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.last_name}, {e.first_name} ({e.employee_code}){e.active ? "" : " – inactive"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="week">Any date in week</label>
          <input id="week" name="week" type="date" defaultValue={week} className="input" />
        </div>
        <button className="btn-primary">Show</button>
      </form>

      {employee && tc && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-xl font-bold">
              {employee.first_name} {employee.last_name} · {formatYmd(tc.week.startDate)} – {formatYmd(tc.week.endDate)}
            </h1>
            <div className="flex gap-2">
              <Link className="btn-secondary btn-sm" href={qs(addDays(week, -7))}>← Previous week</Link>
              <Link className="btn-secondary btn-sm" href={qs(addDays(week, 7))}>Next week →</Link>
            </div>
          </div>

          <section className="card overflow-x-auto">
            <h2 className="mb-2 font-semibold">Daily totals</h2>
            <table className="table">
              <thead>
                <tr>
                  {tc.settlement.days.map((d) => (
                    <th key={d.date}>{formatYmd(d.date).replace(/, \d{4}$/, "")}</th>
                  ))}
                  <th>Week</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  {tc.settlement.days.map((d) => (
                    <td key={d.date} className="tabular-nums">{d.hours.toFixed(2)} h</td>
                  ))}
                  <td className="font-semibold tabular-nums">{tc.settlement.totalHours.toFixed(2)} h</td>
                </tr>
                {isAdmin && (
                  <tr>
                    {tc.settlement.days.map((d) => (
                      <td key={d.date} className="tabular-nums text-slate-600">{formatCents(d.amountCents)}</td>
                    ))}
                    <td className="font-semibold tabular-nums">{formatCents(tc.settlement.estimatedAmountCents)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {tc.settlement.overtimeHours > 0 && (
              <p className="mt-2 text-sm text-amber-800">Over 40 hours this week: {tc.settlement.overtimeHours.toFixed(2)} h.</p>
            )}
            {isAdmin && <p className="mt-2 text-xs text-slate-500">Dollar amounts: {PAY_ESTIMATE_DISCLAIMER}</p>}
            {tc.settlement.flags.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-rose-800">
                {tc.settlement.flags.map((f, i) => (
                  <li key={i}>⚠ {f.message} {f.at ? `(${formatDateTime(f.at)})` : ""}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="card overflow-x-auto">
            <h2 className="mb-2 font-semibold">Shifts</h2>
            <table className="table">
              <thead>
                <tr><th>In</th><th>Out</th><th>Lunch</th><th>Worked (this week)</th><th>Status</th></tr>
              </thead>
              <tbody>
                {tc.settlement.shifts.map((s, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap">{s.clockIn ? formatDateTime(s.clockIn) : "—"}</td>
                    <td className="whitespace-nowrap">{s.clockOut ? formatDateTime(s.clockOut) : "—"}</td>
                    <td>{Math.round(s.lunchSeconds / 60)} min</td>
                    <td className="tabular-nums">{hoursFromSeconds(s.workedSecondsInWeek).toFixed(2)} h</td>
                    <td>{s.status.replace(/_/g, " ")}</td>
                  </tr>
                ))}
                {!tc.settlement.shifts.length && <tr><td colSpan={5} className="text-slate-500">No shifts.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="card overflow-x-auto">
            <h2 className="mb-2 font-semibold">Raw punches (including corrected and voided history)</h2>
            <table className="table">
              <thead>
                <tr><th>Time</th><th>Action</th><th>Source / location</th><th>Notes</th><th>Correct</th></tr>
              </thead>
              <tbody>
                {tc.punches.map((p) => {
                  const inactive = p.voided_at !== null || p.review_status === "rejected";
                  return (
                    <tr key={p.id} className={inactive ? "text-slate-400" : ""}>
                      <td className={`whitespace-nowrap ${inactive ? "line-through" : ""}`}>{formatDateTime(p.punched_at)}</td>
                      <td className={inactive ? "line-through" : ""}>{PUNCH_LABELS[p.punch_type]}</td>
                      <td className="text-xs">
                        {p.source}
                        {p.geofence_result && p.geofence_result !== "not_required" ? ` · ${p.geofence_result}` : ""}
                        {p.distance_m !== null ? ` · ${Math.round(p.distance_m)} m` : ""}
                        {p.accuracy_m !== null ? ` · ±${Math.round(p.accuracy_m)} m` : ""}
                      </td>
                      <td className="text-xs">
                        {p.review_status !== "none" && <div>Review: {p.review_status}{p.reviewed_by_name ? ` by ${p.reviewed_by_name}` : ""}</div>}
                        {p.exception_reason && <div>Employee: {p.exception_reason}</div>}
                        {p.correction_reason && <div>Added by {p.created_by_admin_name}: {p.correction_reason}</div>}
                        {p.void_reason && <div>Voided: {p.void_reason}</div>}
                      </td>
                      <td>
                        {!inactive && (
                          <details>
                            <summary className="cursor-pointer text-sky-700">Edit / void</summary>
                            <div className="mt-2 w-72 space-y-3">
                              <ActionForm action={replacePunchAction} submitLabel="Save correction" className="space-y-2">
                                <input type="hidden" name="punchId" value={p.id} />
                                <select name="type" defaultValue={p.punch_type} className="input">
                                  {PUNCH_TYPES.map((t) => <option key={t} value={t}>{PUNCH_LABELS[t]}</option>)}
                                </select>
                                <input type="datetime-local" name="at" defaultValue={toChicagoLocalInput(p.punched_at)} required className="input" />
                                <input name="reason" placeholder="Reason (required)" required minLength={5} className="input" />
                              </ActionForm>
                              <ActionForm action={voidPunchAction} submitLabel="Void punch" submitClass="btn-danger btn-sm" className="space-y-2" confirm="Void this punch? It stays in history but no longer counts.">
                                <input type="hidden" name="punchId" value={p.id} />
                                <input name="reason" placeholder="Reason (required)" required minLength={5} className="input" />
                              </ActionForm>
                            </div>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!tc.punches.length && <tr><td colSpan={5} className="text-slate-500">No punches this week.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="card">
            <h2 className="mb-2 font-semibold">Add a missing punch</h2>
            <ActionForm action={addPunchAction} submitLabel="Add punch" className="grid gap-3 sm:grid-cols-4 sm:items-end">
              <input type="hidden" name="employeeId" value={employee.id} />
              <div>
                <label className="label">Action</label>
                <select name="type" className="input">
                  {PUNCH_TYPES.map((t) => <option key={t} value={t}>{PUNCH_LABELS[t]}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Date &amp; time (Chicago)</label>
                <input type="datetime-local" name="at" required className="input" defaultValue={toChicagoLocalInput(now)} />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Reason</label>
                <input name="reason" required minLength={5} placeholder="e.g. Forgot to clock out; confirmed with employee" className="input" />
              </div>
            </ActionForm>
            <p className="mt-2 text-xs text-slate-500">All corrections are recorded in the audit log with your name and reason. Current time: {formatTime(now)}.</p>
          </section>
        </>
      )}
    </div>
  );
}

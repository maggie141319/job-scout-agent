import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { requireAdmin } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { formatCents } from "@/lib/settlement";
import { listAudit } from "@/lib/services/audit";
import { getEmployee, listRates } from "@/lib/services/employees";
import { chicagoDate, formatDateTime, formatYmd, weekStartFor } from "@/lib/time";
import { resetPinAction, setEmployeeActiveAction, setRateAction, updateEmployeeAction } from "../../../actions";

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin(["admin"]);
  const { id } = await params;
  const db = getPool();
  const employee = await getEmployee(db, id);
  if (!employee) notFound();
  const [rates, audit] = await Promise.all([listRates(db, id), listAudit(db, { entityId: id, limit: 50 })]);
  const today = chicagoDate(new Date());

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">
          {employee.first_name} {employee.last_name} <span className="text-base font-normal text-slate-500">{employee.employee_code}</span>
          {!employee.active && <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-sm">Inactive</span>}
        </h1>
        <Link className="btn-secondary btn-sm" href={`/admin/timecards?employee=${employee.id}&week=${today}`}>Timecard</Link>
      </div>

      <section className="card">
        <h2 className="mb-3 font-semibold">Details</h2>
        <ActionForm action={updateEmployeeAction} submitLabel="Save" className="space-y-3">
          <input type="hidden" name="id" value={employee.id} />
          <div className="grid gap-3 sm:grid-cols-3">
            <div><label className="label">Employee code</label><input name="employeeCode" defaultValue={employee.employee_code} required className="input" /></div>
            <div><label className="label">First name</label><input name="firstName" defaultValue={employee.first_name} required className="input" /></div>
            <div><label className="label">Last name</label><input name="lastName" defaultValue={employee.last_name} required className="input" /></div>
          </div>
          <div><label className="label">Notes (internal)</label><input name="notes" defaultValue={employee.notes ?? ""} className="input" /></div>
        </ActionForm>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Hourly rate</h2>
        <table className="table max-w-md">
          <thead><tr><th>Effective from</th><th>Rate</th></tr></thead>
          <tbody>
            {rates.map((r) => (
              <tr key={r.id}><td>{formatYmd(r.effective_date)}</td><td className="tabular-nums">{formatCents(r.hourly_rate_cents)}/h</td></tr>
            ))}
          </tbody>
        </table>
        <ActionForm action={setRateAction} submitLabel="Set rate" className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <input type="hidden" name="id" value={employee.id} />
          <div><label className="label">New rate ($/h)</label><input name="rate" required inputMode="decimal" className="input" /></div>
          <div><label className="label">Effective from</label><input name="effectiveDate" type="date" required defaultValue={weekStartFor(today)} className="input" /></div>
        </ActionForm>
        <p className="text-xs text-slate-500">Rates apply to work on or after the effective date. Starting a rate on a Friday keeps each pay week on a single rate.</p>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">PIN</h2>
        <p className="text-sm text-slate-600">PINs are stored only as a secure hash and cannot be viewed. Reset to issue a new one.</p>
        <ActionForm action={resetPinAction} submitLabel="Reset PIN" className="space-y-2" confirm="Issue a new PIN? The old PIN stops working immediately.">
          <input type="hidden" name="id" value={employee.id} />
          <input name="pin" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="off" placeholder="New 6-digit PIN (blank = generate)" className="input max-w-xs" />
        </ActionForm>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">{employee.active ? "Deactivate" : "Reactivate"}</h2>
        <p className="text-sm text-slate-600">Deactivated employees cannot punch. All their time records are kept.</p>
        <ActionForm
          action={setEmployeeActiveAction}
          submitLabel={employee.active ? "Deactivate" : "Reactivate"}
          submitClass={employee.active ? "btn-danger" : "btn-primary"}
          className="space-y-2"
          confirm={employee.active ? "Deactivate this employee?" : undefined}
        >
          <input type="hidden" name="id" value={employee.id} />
          <input type="hidden" name="active" value={employee.active ? "false" : "true"} />
          <input name="reason" placeholder="Reason (optional)" className="input max-w-md" />
        </ActionForm>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-semibold">Change history</h2>
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap">{formatDateTime(a.occurred_at)}</td>
                <td>{a.actor_label}</td>
                <td>{a.action}</td>
                <td className="text-xs">{a.reason ?? ""} {a.after ? JSON.stringify(a.after) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

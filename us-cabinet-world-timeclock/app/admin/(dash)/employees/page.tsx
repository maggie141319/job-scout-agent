import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { requireAdmin } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { formatCents } from "@/lib/settlement";
import { listEmployees } from "@/lib/services/employees";
import { chicagoDate, weekStartFor } from "@/lib/time";
import { createEmployeeAction } from "../../actions";

export default async function EmployeesPage() {
  await requireAdmin(["admin"]);
  const today = chicagoDate(new Date());
  const employees = await listEmployees(getPool(), today, { includeInactive: true });

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">Employees</h1>
      <section className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr><th>Code</th><th>Name</th><th>Hourly rate</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className={e.active ? "" : "text-slate-400"}>
                <td>{e.employee_code}</td>
                <td>{e.last_name}, {e.first_name}</td>
                <td className="tabular-nums">{e.current_rate_cents === null ? "—" : `${formatCents(e.current_rate_cents)}/h`}</td>
                <td>{e.active ? "Active" : "Inactive"}</td>
                <td><Link className="text-sky-700 underline" href={`/admin/employees/${e.id}`}>Manage</Link></td>
              </tr>
            ))}
            {!employees.length && <tr><td colSpan={5} className="text-slate-500">No employees yet. Add the first one below.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Add employee</h2>
        <ActionForm action={createEmployeeAction} submitLabel="Add employee" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><label className="label">Employee code</label><input name="employeeCode" required maxLength={20} placeholder="E001" className="input" /></div>
            <div><label className="label">First name</label><input name="firstName" required maxLength={60} className="input" /></div>
            <div><label className="label">Last name</label><input name="lastName" required maxLength={60} className="input" /></div>
            <div><label className="label">Hourly rate ($)</label><input name="rate" required inputMode="decimal" placeholder="18.00" className="input" /></div>
            <div><label className="label">Rate effective from</label><input name="rateEffectiveDate" type="date" required defaultValue={weekStartFor(today)} className="input" /></div>
            <div>
              <label className="label">PIN (6 digits, optional)</label>
              <input name="pin" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="off" placeholder="Leave blank to generate" className="input" />
            </div>
          </div>
          <div><label className="label">Notes (internal)</label><input name="notes" maxLength={500} className="input" /></div>
        </ActionForm>
      </section>
    </div>
  );
}

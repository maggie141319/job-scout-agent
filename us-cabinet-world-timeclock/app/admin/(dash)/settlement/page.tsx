import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { requireAdmin } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { formatCents } from "@/lib/settlement";
import { listSnapshots, weeklySettlement } from "@/lib/services/reports";
import { addDays, chicagoDate, formatDateTime, formatYmd, isYmd, weekStartFor } from "@/lib/time";
import { finalizeWeekAction } from "../../actions";

export default async function SettlementPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  await requireAdmin(["admin"]);
  const sp = await searchParams;
  const week = weekStartFor(sp.week && isYmd(sp.week) ? sp.week : chicagoDate(new Date()));
  const db = getPool();
  const [report, snapshots] = await Promise.all([weeklySettlement(db, week), listSnapshots(db, week)]);
  const flagged = report.rows.filter((r) => r.flags.some((f) => f.code !== "IN_PROGRESS"));
  const exp = (kind: string) => `/admin/export?kind=${kind}&week=${week}`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Weekly settlement</h1>
          <p className="text-slate-600">
            {formatYmd(report.week.startDate)} – {formatYmd(report.week.endDate)} · Pay date {formatYmd(report.week.payDate)}
          </p>
        </div>
        <div className="flex gap-2">
          <Link className="btn-secondary btn-sm" href={`/admin/settlement?week=${addDays(week, -7)}`}>← Previous</Link>
          <Link className="btn-secondary btn-sm" href={`/admin/settlement?week=${addDays(week, 7)}`}>Next →</Link>
        </div>
      </div>

      {flagged.length > 0 && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {flagged.length} employee(s) have missing or irregular punches or pending exceptions. Resolve them on the{" "}
          <Link className="underline" href={`/admin/review?week=${week}`}>Review page</Link> before paying.
        </p>
      )}

      <section className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              {report.week.days.map((d) => <th key={d} className="text-right">{formatYmd(d).slice(0, 3)}<br /><span className="font-normal text-slate-500">{d.slice(5)}</span></th>)}
              <th className="text-right">Total h</th>
              <th className="text-right">Over 40 h</th>
              <th className="text-right">Rate</th>
              <th className="text-right">Straight pay</th>
              <th className="text-right">OT premium</th>
              <th className="text-right">Amount due</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={r.employeeId}>
                <td className="whitespace-nowrap">
                  <Link className="text-sky-700 underline" href={`/admin/timecards?employee=${r.employeeId}&week=${week}`}>{r.lastName}, {r.firstName}</Link>
                  {!r.active && <span className="ml-1 text-xs text-slate-500">(inactive)</span>}
                </td>
                {r.days.map((d) => <td key={d.date} className="text-right tabular-nums">{d.seconds ? d.hours.toFixed(2) : ""}</td>)}
                <td className="text-right font-semibold tabular-nums">{r.totalHours.toFixed(2)}</td>
                <td className="text-right tabular-nums">{r.overtimeHours ? r.overtimeHours.toFixed(2) : ""}</td>
                <td className="text-right tabular-nums">{r.currentRateCents === null ? "—" : formatCents(r.currentRateCents)}</td>
                <td className="text-right tabular-nums">{formatCents(r.straightPayCents)}</td>
                <td className="text-right tabular-nums">{r.overtimePremiumCents ? formatCents(r.overtimePremiumCents) : ""}</td>
                <td className="text-right font-semibold tabular-nums">{formatCents(r.amountDueCents)}</td>
                <td className="text-xs text-rose-700">{[...new Set(r.flags.map((f) => f.code))].join(", ").toLowerCase().replace(/_/g, " ")}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td>Total</td>
              <td colSpan={7}></td>
              <td className="text-right tabular-nums">{report.totals.totalHours.toFixed(2)}</td>
              <td className="text-right tabular-nums">{report.totals.overtimeHours.toFixed(2)}</td>
              <td></td>
              <td className="text-right tabular-nums">{formatCents(report.totals.straightPayCents)}</td>
              <td className="text-right tabular-nums">{formatCents(report.totals.overtimePremiumCents)}</td>
              <td className="text-right tabular-nums">{formatCents(report.totals.amountDueCents)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-xs text-slate-500">
          Hours come from actual punches; lunches are the real Lunch Out → Lunch In time. Overnight shifts are split at midnight and at the Friday
          week boundary. Hours over 40 in the Friday–Thursday week are always shown; the 0.5× premium is{" "}
          {report.overtimePolicy === "apply" ? "included in Amount due" : "NOT included in Amount due (report only)"} per Settings. Worker
          classification (W-2 vs 1099) and overtime obligations should be confirmed with your accountant.
        </p>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Export CSV</h2>
        <div className="flex flex-wrap gap-2">
          <a className="btn-secondary btn-sm" href={exp("summary")}>Weekly summary</a>
          <a className="btn-secondary btn-sm" href={exp("daily")}>Daily detail</a>
          <a className="btn-secondary btn-sm" href={exp("quickbooks")}>QuickBooks time activities</a>
          <a className="btn-secondary btn-sm" href={exp("punches")}>Raw punches (audit)</a>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Finalize (snapshot)</h2>
        <p className="text-sm text-slate-600">Saves a copy of this report as reviewed/paid. The live report always recalculates from raw punches.</p>
        <ActionForm action={finalizeWeekAction} submitLabel="Save snapshot" className="space-y-2" confirm="Save a snapshot of this week's settlement?">
          <input type="hidden" name="week" value={week} />
          <input name="note" placeholder="Note, e.g. Paid by check 10/30" className="input" />
        </ActionForm>
        {snapshots.length > 0 && (
          <ul className="text-sm">
            {snapshots.map((s) => (
              <li key={s.id}>
                {formatDateTime(s.finalized_at)} by {s.display_name ?? "—"} · {formatCents(Number(s.amount_due_cents))}
                {Number(s.amount_due_cents) !== report.totals.amountDueCents && <span className="ml-2 text-rose-700">(differs from current report)</span>}
                {s.note ? ` · ${s.note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

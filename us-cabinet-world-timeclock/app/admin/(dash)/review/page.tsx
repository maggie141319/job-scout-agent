import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { requireAdmin } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { PUNCH_LABELS } from "@/lib/punch-rules";
import { listPendingExceptions } from "@/lib/services/corrections";
import { weeklySettlement } from "@/lib/services/reports";
import { addDays, chicagoDate, formatDateTime, formatYmd, isYmd, weekStartFor } from "@/lib/time";
import { reviewExceptionAction } from "../../actions";

const FLAG_TEXT: Record<string, string> = {
  MISSING_CLOCK_OUT: "Missing clock-out",
  MISSING_CLOCK_IN: "Clock-out without clock-in",
  MISSING_LUNCH_IN: "Missing lunch-in",
  UNEXPECTED_PUNCH: "Out-of-order punch",
  IN_PROGRESS: "Shift in progress",
  PENDING_EXCEPTION: "Pending location exception",
  OUTSIDE_GEOFENCE: "Location check failed (monitor mode)",
  LONG_SHIFT: "Very long shift",
  NO_RATE: "No hourly rate",
};

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const week = weekStartFor(sp.week && isYmd(sp.week) ? sp.week : chicagoDate(new Date()));
  const db = getPool();
  const [pending, report] = await Promise.all([listPendingExceptions(db), weeklySettlement(db, week)]);
  const irregular = report.rows.flatMap((r) =>
    r.flags.filter((f) => f.code !== "PENDING_EXCEPTION" && f.code !== "IN_PROGRESS").map((f) => ({ ...f, row: r })),
  );

  return (
    <div className="space-y-6">
      <section>
        <h1 className="mb-3 text-xl font-bold">Location exceptions awaiting review</h1>
        {!pending.length && <p className="card text-slate-600">Nothing to review.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {pending.map((p) => (
            <div key={p.id} className="card space-y-2">
              <p className="font-semibold">
                {p.first_name} {p.last_name} · {PUNCH_LABELS[p.punch_type]} · {formatDateTime(p.punched_at)}
              </p>
              <p className="text-sm">
                <span className="text-slate-500">Employee&apos;s reason:</span> {p.exception_reason}
              </p>
              <p className="text-xs text-slate-500">
                GPS: {p.gps_error ?? "—"} · result: {p.geofence_result}
                {p.distance_m !== null ? ` · ${Math.round(p.distance_m)} m from site` : ""}
                {p.accuracy_m !== null ? ` · ±${Math.round(p.accuracy_m)} m` : ""}
              </p>
              <ActionForm action={reviewExceptionAction} submitLabel="Approve" className="space-y-2">
                <input type="hidden" name="punchId" value={p.id} />
                <input type="hidden" name="decision" value="approve" />
                <input name="note" placeholder="Note (optional)" className="input" />
              </ActionForm>
              <ActionForm action={reviewExceptionAction} submitLabel="Reject" submitClass="btn-danger" className="space-y-2" confirm="Reject this punch? It will no longer count toward pay.">
                <input type="hidden" name="punchId" value={p.id} />
                <input type="hidden" name="decision" value="reject" />
                <input name="note" placeholder="Reason for rejecting (required)" className="input" />
              </ActionForm>
              <Link className="text-sm text-sky-700 underline" href={`/admin/timecards?employee=${p.employee_id}&week=${chicagoDate(p.punched_at)}`}>
                Open timecard to correct the time instead
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-bold">
            Irregular punches · week of {formatYmd(report.week.startDate)} – {formatYmd(report.week.endDate)}
          </h2>
          <div className="flex gap-2 text-sm">
            <Link className="btn-secondary btn-sm" href={`/admin/review?week=${addDays(week, -7)}`}>← Previous</Link>
            <Link className="btn-secondary btn-sm" href={`/admin/review?week=${addDays(week, 7)}`}>Next →</Link>
          </div>
        </div>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Issue</th>
                <th>When</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {irregular.map((f, i) => (
                <tr key={i}>
                  <td>{f.row.firstName} {f.row.lastName}</td>
                  <td>
                    <strong>{FLAG_TEXT[f.code] ?? f.code}</strong>
                    <div className="text-xs text-slate-500">{f.message}</div>
                  </td>
                  <td className="whitespace-nowrap">{f.at ? formatDateTime(f.at) : "—"}</td>
                  <td>
                    <Link className="text-sky-700 underline" href={`/admin/timecards?employee=${f.row.employeeId}&week=${week}`}>Fix</Link>
                  </td>
                </tr>
              ))}
              {!irregular.length && (
                <tr>
                  <td colSpan={4} className="text-slate-500">No irregular punches this week.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { STATE_LABELS } from "@/lib/punch-rules";
import { listPendingExceptions } from "@/lib/services/corrections";
import { statusBoard } from "@/lib/services/reports";
import { getSettings } from "@/lib/services/settings";
import { formatDateTime, formatTime, chicagoDate } from "@/lib/time";

const STATE_STYLE = { off: "bg-slate-100 text-slate-700", working: "bg-emerald-100 text-emerald-800", lunch: "bg-amber-100 text-amber-800" };

export default async function StatusPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  await requireAdmin();
  const { denied } = await searchParams;
  const db = getPool();
  const now = new Date();
  const [board, pending, settings] = await Promise.all([statusBoard(db, now), listPendingExceptions(db), getSettings(db)]);
  const counts = { working: 0, lunch: 0, off: 0 };
  for (const b of board) counts[b.state]++;

  return (
    <div className="space-y-5">
      {denied && <p className="rounded-lg bg-rose-50 p-3 text-rose-800">That page requires the administrator role.</p>}
      {(settings.geofence_mode !== "enforce" || !settings.coordinates_verified_at) && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Location enforcement is <strong>off (monitor mode)</strong>
          {settings.coordinates_verified_at ? "" : " and the warehouse coordinates are not verified"}. Phone punches are recorded and outside readings are flagged.{" "}
          <Link className="underline" href="/admin/settings">Settings</Link>
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Working" value={counts.working} />
        <Stat label="On lunch" value={counts.lunch} />
        <Stat label="Clocked out" value={counts.off} />
        <Link href="/admin/review" className="card block hover:bg-slate-50">
          <p className="text-sm text-slate-600">Exceptions to review</p>
          <p className={`text-3xl font-bold ${pending.length ? "text-amber-600" : ""}`}>{pending.length}</p>
        </Link>
      </div>
      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-lg font-semibold">Current status · {formatTime(now)}</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Status</th>
              <th>Since</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {board.map((b) => (
              <tr key={b.employee_id}>
                <td>
                  {b.first_name} {b.last_name} <span className="text-xs text-slate-500">{b.employee_code}</span>
                </td>
                <td>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_STYLE[b.state]}`}>{STATE_LABELS[b.state]}</span>
                  {b.stale && <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">Missing clock-out?</span>}
                  {b.last_review_status === "pending" && <span className="ml-2 text-xs text-amber-700">(pending review)</span>}
                </td>
                <td className="whitespace-nowrap">{b.since ? formatDateTime(b.since) : "—"}</td>
                <td>
                  <Link className="text-sky-700 underline" href={`/admin/timecards?employee=${b.employee_id}&week=${chicagoDate(now)}`}>
                    Timecard
                  </Link>
                </td>
              </tr>
            ))}
            {!board.length && (
              <tr>
                <td colSpan={4} className="text-slate-500">No active employees yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <p className="text-sm text-slate-600">{label}</p>
      <p className="text-3xl font-bold">{value}</p>
    </div>
  );
}

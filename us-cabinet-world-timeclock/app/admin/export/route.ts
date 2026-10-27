import type { NextRequest } from "next/server";
import { currentAdmin } from "@/lib/auth";
import { centsToDecimal, toCsv } from "@/lib/csv";
import { getPool } from "@/lib/db";
import { weeklySettlement } from "@/lib/services/reports";
import { chicagoDate, formatDateTime, isYmd, payWeek, toChicagoLocalInput } from "@/lib/time";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const mdY = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;

/** CSV exports for bookkeeping. Administrator role only. */
export async function GET(req: NextRequest) {
  const user = await currentAdmin();
  if (!user || user.role !== "admin") return new Response("Forbidden", { status: 403 });
  const kind = req.nextUrl.searchParams.get("kind") ?? "summary";
  const weekParam = req.nextUrl.searchParams.get("week") ?? "";
  const db = getPool();
  const report = await weeklySettlement(db, isYmd(weekParam) ? weekParam : chicagoDate(new Date()));
  const w = report.week;
  let csv: string;

  if (kind === "summary") {
    csv = toCsv(
      ["Employee Code", "Last Name", "First Name", "Week Start (Fri)", "Week End (Thu)", "Pay Date", "Total Hours", "Hours Up To 40", "Hours Over 40", "Hourly Rate", "Straight-Time Pay", "OT Premium (0.5x, over 40)", "Amount Due", "OT Premium Included", "Pending Exceptions", "Review Flags"],
      report.rows.map((r) => [
        r.employeeCode, r.lastName, r.firstName, w.startDate, w.endDate, w.payDate,
        r.totalHours.toFixed(2), r.regularHours.toFixed(2), r.overtimeHours.toFixed(2),
        r.currentRateCents === null ? "" : centsToDecimal(r.currentRateCents),
        centsToDecimal(r.straightPayCents), centsToDecimal(r.overtimePremiumCents), centsToDecimal(r.amountDueCents),
        report.overtimePolicy === "apply" ? "Yes" : "No (report only)",
        r.pendingExceptions,
        [...new Set(r.flags.map((f) => f.code))].join(" "),
      ]),
    );
  } else if (kind === "daily") {
    csv = toCsv(
      ["Employee Code", "Last Name", "First Name", "Date", "Day", "Hours", "Hourly Rate", "Amount", "Week Start", "Pay Date"],
      report.rows.flatMap((r) =>
        r.days.filter((d) => d.seconds > 0).map((d) => [
          r.employeeCode, r.lastName, r.firstName, d.date, DOW[new Date(`${d.date}T12:00:00Z`).getUTCDay()],
          d.hours.toFixed(2), centsToDecimal(d.rateCents), centsToDecimal(d.amountCents), w.startDate, w.payDate,
        ]),
      ),
    );
  } else if (kind === "quickbooks") {
    // One time-activity row per employee per day. Confirm column mapping with your QuickBooks import tool.
    csv = toCsv(
      ["Date", "Employee", "Hours", "Hourly Rate", "Amount", "Billable", "Description"],
      report.rows.flatMap((r) =>
        r.days.filter((d) => d.seconds > 0).map((d) => [
          mdY(d.date), `${r.firstName} ${r.lastName}`, d.hours.toFixed(2), centsToDecimal(d.rateCents), centsToDecimal(d.amountCents), "No",
          `Warehouse hours, pay week ${w.startDate} to ${w.endDate}`,
        ]),
      ),
    );
  } else if (kind === "punches") {
    const week = payWeek(w.startDate);
    const res = await db.query<{
      id: string; employee_code: string; first_name: string; last_name: string; punch_type: string; punched_at: Date; source: string;
      geofence_result: string | null; distance_m: number | null; accuracy_m: number | null; review_status: string; voided_at: Date | null;
      void_reason: string | null; correction_reason: string | null; exception_reason: string | null; replaces_punch_id: string | null;
    }>(
      `select p.*, e.employee_code, e.first_name, e.last_name from punches p join employees e on e.id = p.employee_id
       where p.punched_at >= $1 and p.punched_at < $2 order by e.last_name, e.first_name, p.punched_at`,
      [week.start, week.end],
    );
    csv = toCsv(
      ["Punch ID", "Employee Code", "Last Name", "First Name", "Action", "Time (America/Chicago)", "Time (UTC)", "Source", "Location Result", "Distance m", "Accuracy m", "Review Status", "Voided", "Void Reason", "Correction Reason", "Employee Exception Reason", "Replaces Punch ID"],
      res.rows.map((p) => [
        p.id, p.employee_code, p.last_name, p.first_name, p.punch_type, toChicagoLocalInput(p.punched_at).replace("T", " "), p.punched_at.toISOString(),
        p.source, p.geofence_result, p.distance_m === null ? "" : Math.round(p.distance_m), p.accuracy_m === null ? "" : Math.round(p.accuracy_m),
        p.review_status, p.voided_at ? formatDateTime(p.voided_at) : "", p.void_reason, p.correction_reason, p.exception_reason, p.replaces_punch_id,
      ]),
    );
  } else {
    return new Response("Unknown export", { status: 400 });
  }

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="uscw-${kind}-${w.startDate}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

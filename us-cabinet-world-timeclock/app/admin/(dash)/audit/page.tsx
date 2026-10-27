import { requireAdmin } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { listAudit } from "@/lib/services/audit";
import { formatDateTime } from "@/lib/time";

export default async function AuditPage() {
  await requireAdmin(["admin"]);
  const entries = await listAudit(getPool(), { limit: 300 });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Audit log</h1>
      <p className="text-sm text-slate-600">Append-only record of every correction, review and administrative change (latest 300).</p>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Reason</th><th>Before → After</th></tr></thead>
          <tbody>
            {entries.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap">{formatDateTime(a.occurred_at)}</td>
                <td>{a.actor_label ?? a.actor_type}</td>
                <td className="whitespace-nowrap">{a.action}</td>
                <td className="text-xs">{a.entity_type} {a.entity_id?.slice(0, 8)}</td>
                <td className="text-xs">{a.reason}</td>
                <td className="max-w-md text-xs break-words">
                  {a.before ? <div className="text-slate-500">{JSON.stringify(a.before)}</div> : null}
                  {a.after ? <div>{JSON.stringify(a.after)}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

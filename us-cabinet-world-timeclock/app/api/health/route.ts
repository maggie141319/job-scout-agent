import { getPool } from "@/lib/db";

/** Liveness + database connectivity check (no data or configuration is exposed). */
export async function GET() {
  try {
    await getPool().query("select 1");
    return Response.json({ ok: true, database: "up" });
  } catch {
    return Response.json({ ok: false, database: "down" }, { status: 503 });
  }
}

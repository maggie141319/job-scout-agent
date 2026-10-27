import { clientInfoFrom, currentKiosk } from "@/lib/auth";
import { pinPepper } from "@/lib/config";
import { getPool } from "@/lib/db";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/http";
import { identify } from "@/lib/services/punches";

/** Verifies an employee PIN and returns only that employee's own status. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const body = await readJson(req);
    const kiosk = await currentKiosk();
    const { ip, userAgent } = clientInfoFrom(req.headers);
    const view = await identify(getPool(), pinPepper(), body.pin, { ip, userAgent, kioskDeviceId: kiosk?.id ?? null });
    return Response.json({ ok: true, ...view });
  } catch (err) {
    return errorResponse(err);
  }
}

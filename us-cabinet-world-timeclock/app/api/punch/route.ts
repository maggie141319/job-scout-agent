import { clientInfoFrom, currentKiosk } from "@/lib/auth";
import { pinPepper } from "@/lib/config";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/http";
import { recordPunch } from "@/lib/services/punches";

/** Records a punch. The timestamp is always generated on the server. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const body = await readJson(req);
    const kiosk = await currentKiosk();
    const { ip, userAgent } = clientInfoFrom(req.headers);
    const exception = body.exception && typeof body.exception === "object" ? (body.exception as Record<string, unknown>) : null;
    const result = await recordPunch(
      pinPepper(),
      { pin: body.pin, action: body.action, clientRequestId: body.clientRequestId, location: body.location, exception },
      { ip, userAgent, kioskDeviceId: kiosk?.id ?? null },
    );
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(err);
  }
}

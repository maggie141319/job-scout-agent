import "server-only";
import { AppError } from "./errors";

/** Rejects cross-site POSTs: the Origin header must match the host serving the request. */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  if (!originHost || !host || originHost !== host) {
    throw new AppError("FORBIDDEN_ORIGIN", "Request blocked.", 403);
  }
}

export async function readJson(req: Request, maxBytes = 8_192): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError("INVALID_INPUT", "Request too large.", 413);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AppError("INVALID_INPUT", "Invalid request.", 400);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json({ ok: false, code: err.code, message: err.message, ...err.details }, { status: err.status });
  }
  // Never echo internal errors (they may include connection details).
  console.error("Unhandled API error:", err instanceof Error ? err.message : "unknown");
  return Response.json({ ok: false, code: "SERVER_ERROR", message: "Something went wrong. Please try again or tell a manager." }, { status: 500 });
}

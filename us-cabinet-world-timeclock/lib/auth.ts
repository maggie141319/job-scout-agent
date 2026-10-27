import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isProduction } from "./config";
import { getPool } from "./db";
import { actorFor, sessionUser, type AdminRole, type AdminUser } from "./services/admin-auth";
import type { Actor } from "./services/audit";
import { kioskByToken, type KioskDevice } from "./services/devices";

// __Host- cookies must be Secure, path=/ and have no Domain: only usable over HTTPS (production).
export const ADMIN_COOKIE = isProduction ? "__Host-uscw_admin" : "uscw_admin";
export const KIOSK_COOKIE = isProduction ? "__Host-uscw_kiosk" : "uscw_kiosk";

export const cookieBase = { httpOnly: true, secure: isProduction, sameSite: "lax" as const, path: "/" };

export async function clientInfo(): Promise<{ ip: string; userAgent: string | null }> {
  const h = await headers();
  return clientInfoFrom(h);
}

export function clientInfoFrom(h: Headers): { ip: string; userAgent: string | null } {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return { ip: forwarded || h.get("x-real-ip") || "unknown", userAgent: h.get("user-agent") };
}

export async function currentAdmin(): Promise<AdminUser | null> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  return sessionUser(getPool(), token);
}

/** Page/action guard. Redirects to sign-in, or to the dashboard if the role is insufficient. */
export async function requireAdmin(roles: AdminRole[] = ["admin", "manager"]): Promise<{ user: AdminUser; actor: Actor }> {
  const user = await currentAdmin();
  if (!user) redirect("/admin/login");
  if (!roles.includes(user.role)) redirect("/admin?denied=1");
  const { ip } = await clientInfo();
  return { user, actor: actorFor(user, ip) };
}

export async function currentKiosk(): Promise<KioskDevice | null> {
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  return kioskByToken(getPool(), token);
}

"use server";

import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { ADMIN_COOKIE, KIOSK_COOKIE, clientInfo, cookieBase, requireAdmin } from "@/lib/auth";
import { pinPepper } from "@/lib/config";
import { getPool, transaction } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { changePassword, createAdminUser, login, logout, setAdminActive, SESSION_TTL_HOURS, type AdminRole } from "@/lib/services/admin-auth";
import { addPunch, replacePunch, reviewException, voidPunch } from "@/lib/services/corrections";
import { registerKiosk, revokeKiosk } from "@/lib/services/devices";
import { createEmployee, resetPin, setEmployeeActive, setRate, updateEmployee } from "@/lib/services/employees";
import { finalizeWeek } from "@/lib/services/reports";
import { setGeofenceMode, updateSettings, verifyCoordinates } from "@/lib/services/settings";
import { fromChicagoLocalInput } from "@/lib/time";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

async function run(fn: () => Promise<string | ActionState>): Promise<ActionState> {
  try {
    const result = await fn();
    revalidatePath("/admin", "layout");
    return typeof result === "string" ? { ok: true, message: result } : result;
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof AppError) return { ok: false, message: err.message };
    console.error("Admin action failed:", err instanceof Error ? err.message : "unknown");
    return { ok: false, message: "Something went wrong. Nothing was saved." };
  }
}

function parseLocal(value: string): Date {
  const d = fromChicagoLocalInput(value);
  if (!d) throw new AppError("INVALID_INPUT", "Enter a valid date and time.");
  return d;
}

// ---- Authentication -------------------------------------------------------

export async function loginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const client = await clientInfo();
  try {
    const { token, expiresAt } = await login(getPool(), str(fd, "username"), str(fd, "password"), client);
    (await cookies()).set(ADMIN_COOKIE, token, { ...cookieBase, expires: expiresAt, maxAge: SESSION_TTL_HOURS * 3600 });
  } catch (err) {
    if (err instanceof AppError) return { ok: false, message: err.message };
    console.error("Login failed:", err instanceof Error ? err.message : "unknown");
    return { ok: false, message: "Sign-in is unavailable right now." };
  }
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  await logout(getPool(), jar.get(ADMIN_COOKIE)?.value);
  jar.delete(ADMIN_COOKIE);
  redirect("/admin/login");
}

export async function changeOwnPasswordAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { user, actor } = await requireAdmin();
  return run(async () => {
    if (str(fd, "password") !== str(fd, "confirm")) throw new AppError("INVALID_INPUT", "Passwords do not match.");
    await changePassword(getPool(), user.id, str(fd, "password"), actor);
    return "Password changed.";
  });
}

// ---- Employees (admin only) -----------------------------------------------

export async function createEmployeeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    const { employee, pin } = await transaction((db) =>
      createEmployee(
        db,
        pinPepper(),
        {
          employeeCode: str(fd, "employeeCode"),
          firstName: str(fd, "firstName"),
          lastName: str(fd, "lastName"),
          pin: str(fd, "pin") || null,
          rate: str(fd, "rate"),
          rateEffectiveDate: str(fd, "rateEffectiveDate"),
          notes: str(fd, "notes"),
        },
        actor,
      ),
    );
    return { ok: true, message: `Added ${employee.first_name} ${employee.last_name}. Give them this PIN privately; it will not be shown again.`, secret: pin };
  });
}

export async function updateEmployeeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    await transaction((db) =>
      updateEmployee(db, str(fd, "id"), { employeeCode: str(fd, "employeeCode"), firstName: str(fd, "firstName"), lastName: str(fd, "lastName"), notes: str(fd, "notes") }, actor),
    );
    return "Saved.";
  });
}

export async function setEmployeeActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    const active = str(fd, "active") === "true";
    await transaction((db) => setEmployeeActive(db, str(fd, "id"), active, actor, str(fd, "reason")));
    return active ? "Employee reactivated." : "Employee deactivated. Their records are kept.";
  });
}

export async function resetPinAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    const pin = await transaction((db) => resetPin(db, pinPepper(), str(fd, "id"), str(fd, "pin") || null, actor));
    return { ok: true, message: "New PIN set. Give it to the employee privately; it will not be shown again.", secret: pin };
  });
}

export async function setRateAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    await transaction((db) => setRate(db, str(fd, "id"), str(fd, "rate"), str(fd, "effectiveDate"), actor));
    return "Rate saved.";
  });
}

// ---- Review & corrections (admin or manager) -------------------------------

export async function reviewExceptionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  return run(async () => {
    const decision = str(fd, "decision") === "approve" ? "approve" : "reject";
    await reviewException(str(fd, "punchId"), decision, str(fd, "note"), actor);
    return decision === "approve" ? "Approved." : "Rejected. The punch no longer counts toward pay.";
  });
}

export async function addPunchAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  return run(async () => {
    await addPunch(str(fd, "employeeId"), str(fd, "type"), parseLocal(str(fd, "at")), str(fd, "reason"), actor);
    return "Punch added.";
  });
}

export async function replacePunchAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  return run(async () => {
    await replacePunch(str(fd, "punchId"), str(fd, "type"), parseLocal(str(fd, "at")), str(fd, "reason"), actor);
    return "Punch corrected. The original is kept in history.";
  });
}

export async function voidPunchAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  return run(async () => {
    await voidPunch(str(fd, "punchId"), str(fd, "reason"), actor);
    return "Punch voided. It is kept in history but no longer counts.";
  });
}

// ---- Settlement (admin only) -----------------------------------------------

export async function finalizeWeekAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    await transaction((db) => finalizeWeek(db, str(fd, "week"), str(fd, "note"), actor));
    return "Snapshot saved. Later corrections will not change this snapshot.";
  });
}

// ---- Settings, kiosks, users (admin only) ----------------------------------

export async function updateSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    const num = (k: string) => Number(str(fd, k));
    const s = await transaction((db) =>
      updateSettings(
        db,
        {
          latitude: num("latitude"),
          longitude: num("longitude"),
          radius_m: num("radius_m"),
          max_accuracy_m: num("max_accuracy_m"),
          max_location_age_s: num("max_location_age_s"),
          duplicate_window_s: num("duplicate_window_s"),
          max_shift_hours: num("max_shift_hours"),
          pay_estimate_method: str(fd, "pay_estimate_method") === "overtime_premium" ? "overtime_premium" : "flat_rate",
          overtime_multiplier: num("overtime_multiplier"),
        },
        actor,
      ),
    );
    return s.coordinates_verified_at ? "Settings saved." : "Settings saved. Coordinates are not verified, so location is in monitor mode.";
  });
}

export async function verifyCoordinatesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    await transaction((db) => verifyCoordinates(db, actor, str(fd, "note")));
    return "Coordinates marked as verified.";
  });
}

export async function setGeofenceModeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    const mode = str(fd, "mode") === "enforce" ? "enforce" : "monitor";
    await transaction((db) => setGeofenceMode(db, mode, actor));
    return mode === "enforce" ? "Enforcement ON: phone punches outside the area are rejected (employees can request review)." : "Monitor mode: outside punches are recorded and flagged.";
  });
}

export async function registerKioskAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    const { token, device } = await transaction((db) => registerKiosk(db, str(fd, "name"), actor));
    // Browsers cap cookie lifetime at ~400 days; re-register the tablet if it expires.
    (await cookies()).set(KIOSK_COOKIE, token, { ...cookieBase, maxAge: 400 * 24 * 3600 });
    return `This device is now the kiosk "${device.name}". Sign out of admin on this device, then open the home page.`;
  });
}

export async function forgetKioskOnThisDeviceAction(): Promise<ActionState> {
  await requireAdmin(["admin"]);
  return run(async () => {
    (await cookies()).delete(KIOSK_COOKIE);
    return "This device is no longer in kiosk mode (revoke it below to disable the token everywhere).";
  });
}

export async function revokeKioskAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    await transaction((db) => revokeKiosk(db, str(fd, "id"), actor));
    return "Kiosk revoked.";
  });
}

export async function createAdminUserAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    await transaction((db) =>
      createAdminUser(db, { username: str(fd, "username"), displayName: str(fd, "displayName"), password: str(fd, "password"), role: str(fd, "role") as AdminRole }, actor),
    );
    return "User created.";
  });
}

export async function setAdminActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin(["admin"]);
  return run(async () => {
    await transaction((db) => setAdminActive(db, str(fd, "id"), str(fd, "active") === "true", actor));
    return "Saved.";
  });
}

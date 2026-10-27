import { ActionForm } from "@/components/action-form";
import { LocateButton } from "@/components/locate-button";
import { currentKiosk, requireAdmin } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { listAdminUsers } from "@/lib/services/admin-auth";
import { listKiosks } from "@/lib/services/devices";
import { getSettings } from "@/lib/services/settings";
import { formatDateTime } from "@/lib/time";
import {
  changeOwnPasswordAction,
  createAdminUserAction,
  forgetKioskOnThisDeviceAction,
  registerKioskAction,
  revokeKioskAction,
  setAdminActiveAction,
  setGeofenceModeAction,
  updateSettingsAction,
  verifyCoordinatesAction,
} from "../../actions";

export default async function SettingsPage() {
  const { user } = await requireAdmin(["admin"]);
  const db = getPool();
  const [s, kiosks, users, thisKiosk] = await Promise.all([getSettings(db), listKiosks(db), listAdminUsers(db), currentKiosk()]);
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${s.latitude},${s.longitude}`;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">Settings</h1>

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">Warehouse location &amp; geofence</h2>
        <p className="text-sm">{s.site_name} · {s.address}</p>
        <div className={`rounded-lg p-3 text-sm ${s.geofence_mode === "enforce" ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
          Mode: <strong>{s.geofence_mode === "enforce" ? "ENFORCE" : "MONITOR"}</strong> ·{" "}
          {s.coordinates_verified_at ? `Coordinates verified ${formatDateTime(s.coordinates_verified_at)}` : "Coordinates NOT verified (seeded approximation)"}
          <br />
          {s.geofence_mode === "enforce"
            ? "Phone punches need a fresh, accurate GPS reading within the radius. Others can be sent for manager review."
            : "Phone punches still need a GPS reading, but outside/inaccurate readings are only flagged for review, not rejected."}
        </div>
        <p className="text-sm">
          Current point: {s.latitude.toFixed(6)}, {s.longitude.toFixed(6)} ·{" "}
          <a className="text-sky-700 underline" href={mapUrl} target="_blank" rel="noreferrer">Open in map</a>
        </p>

        <ActionForm action={updateSettingsAction} submitLabel="Save location settings" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div><label className="label" htmlFor="lat">Latitude</label><input id="lat" name="latitude" defaultValue={s.latitude} required className="input" /></div>
            <div><label className="label" htmlFor="lng">Longitude</label><input id="lng" name="longitude" defaultValue={s.longitude} required className="input" /></div>
            <div><label className="label">Radius (m)</label><input name="radius_m" type="number" min={25} max={2000} defaultValue={s.radius_m} className="input" /></div>
            <div><label className="label">Max GPS accuracy (m)</label><input name="max_accuracy_m" type="number" min={10} max={1000} defaultValue={s.max_accuracy_m} className="input" /></div>
            <div><label className="label">Max reading age (s)</label><input name="max_location_age_s" type="number" min={10} max={900} defaultValue={s.max_location_age_s} className="input" /></div>
            <div><label className="label">Duplicate-punch window (s)</label><input name="duplicate_window_s" type="number" min={0} max={600} defaultValue={s.duplicate_window_s} className="input" /></div>
            <div><label className="label">Max shift length (h)</label><input name="max_shift_hours" type="number" min={8} max={24} defaultValue={s.max_shift_hours} className="input" /></div>
            <div>
              <label className="label">Overtime premium (&gt;40 h/week)</label>
              <select name="overtime_policy" defaultValue={s.overtime_policy} className="input">
                <option value="apply">Include 0.5× premium in amount due</option>
                <option value="report_only">Report only (accountant decides)</option>
              </select>
            </div>
          </div>
          <LocateButton latId="lat" lngId="lng" />
          <p className="text-xs text-slate-500">Changing the coordinates clears verification and returns to monitor mode.</p>
        </ActionForm>

        <div className="grid gap-4 md:grid-cols-2">
          <ActionForm action={verifyCoordinatesAction} submitLabel="Mark coordinates verified" className="space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="text-sm font-medium">Verify coordinates</p>
            <p className="text-xs text-slate-600">
              Stand inside the warehouse, use &quot;current location&quot; above (or check the map pin), save, then record how you verified it.
            </p>
            <input name="note" required minLength={5} placeholder="e.g. Measured inside main door with iPhone, ±8 m" className="input" />
          </ActionForm>
          <ActionForm action={setGeofenceModeAction} submitLabel={s.geofence_mode === "enforce" ? "Switch to monitor mode" : "Enable enforcement"} className="space-y-2 rounded-lg border border-slate-200 p-3" confirm="Change location enforcement mode?">
            <p className="text-sm font-medium">Enforcement</p>
            <p className="text-xs text-slate-600">Test with a few employees in monitor mode first and check the flagged readings on the Review page.</p>
            <input type="hidden" name="mode" value={s.geofence_mode === "enforce" ? "monitor" : "enforce"} />
          </ActionForm>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">Kiosk (shared warehouse tablet)</h2>
        <p className="text-sm text-slate-600">
          Kiosk punches skip the phone GPS check because the device itself is authorized. Register on the tablet while signed in as admin, then sign out.
        </p>
        {thisKiosk ? (
          <ActionForm action={forgetKioskOnThisDeviceAction} submitLabel="Turn off kiosk mode on this device" submitClass="btn-secondary">
            <p className="mb-2 text-sm">
              This device is registered as kiosk <strong>{thisKiosk.name}</strong>. Sign out of admin, then open the home page on this device.
            </p>
          </ActionForm>
        ) : (
          <ActionForm action={registerKioskAction} submitLabel="Register THIS device as kiosk" className="flex flex-wrap items-end gap-2" confirm="Make this browser a shared kiosk?">
            <input name="name" required placeholder="Warehouse Tablet" className="input max-w-xs" />
          </ActionForm>
        )}
        <table className="table">
          <thead><tr><th>Name</th><th>Registered</th><th>Last used</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {kiosks.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td>{formatDateTime(k.created_at)}</td>
                <td>{k.last_seen_at ? formatDateTime(k.last_seen_at) : "—"}</td>
                <td>{k.revoked_at ? "Revoked" : "Active"}</td>
                <td>
                  {!k.revoked_at && (
                    <ActionForm action={revokeKioskAction} submitLabel="Revoke" submitClass="btn-danger btn-sm" confirm="Revoke this kiosk?">
                      <input type="hidden" name="id" value={k.id} />
                    </ActionForm>
                  )}
                </td>
              </tr>
            ))}
            {!kiosks.length && <tr><td colSpan={5} className="text-slate-500">No kiosks registered.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">Admin &amp; manager accounts</h2>
        <p className="text-sm text-slate-600">
          Admins: everything. Managers: status, exception review and punch corrections only (no pay rates, settlement or settings).
        </p>
        <table className="table">
          <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.display_name}</td>
                <td>{u.role}</td>
                <td>{u.active ? "Active" : "Disabled"}</td>
                <td>
                  {u.id !== user.id && (
                    <ActionForm action={setAdminActiveAction} submitLabel={u.active ? "Disable" : "Enable"} submitClass="btn-secondary btn-sm">
                      <input type="hidden" name="id" value={u.id} />
                      <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                    </ActionForm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ActionForm action={createAdminUserAction} submitLabel="Create account" className="grid gap-3 sm:grid-cols-4 sm:items-end">
          <div><label className="label">Username</label><input name="username" required autoCapitalize="none" className="input" /></div>
          <div><label className="label">Display name</label><input name="displayName" className="input" /></div>
          <div><label className="label">Password (12+ chars)</label><input name="password" type="password" required minLength={12} autoComplete="new-password" className="input" /></div>
          <div>
            <label className="label">Role</label>
            <select name="role" className="input" defaultValue="manager">
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </ActionForm>
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">Change my password</h2>
        <ActionForm action={changeOwnPasswordAction} submitLabel="Change password" className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <div><label className="label">New password</label><input name="password" type="password" required minLength={12} autoComplete="new-password" className="input" /></div>
          <div><label className="label">Confirm</label><input name="confirm" type="password" required minLength={12} autoComplete="new-password" className="input" /></div>
        </ActionForm>
      </section>
    </div>
  );
}

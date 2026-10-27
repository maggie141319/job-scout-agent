"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PunchType = "clock_in" | "lunch_out" | "lunch_in" | "clock_out";
type ClockState = "off" | "working" | "lunch";

interface StatusView {
  employee: { firstName: string; lastName: string };
  state: ClockState;
  since: string | null;
  staleOpenShift: boolean;
  allowedActions: PunchType[];
  today: { type: PunchType; at: string; pendingReview: boolean }[];
  locationRequired: boolean;
  geofenceMode: "monitor" | "enforce";
}

interface Reading {
  latitude: number;
  longitude: number;
  accuracy: number;
  ageSeconds: number;
}

type Phase =
  | { name: "pin" }
  | { name: "ready" }
  | { name: "busy"; label: string }
  | { name: "location-problem"; action: PunchType; message: string; gpsError: string; reading: Reading | null }
  | { name: "done"; type: PunchType; at: string; pendingReview: boolean; duplicate: boolean };

const ACTIONS: { type: PunchType; label: string; color: string }[] = [
  { type: "clock_in", label: "Clock In", color: "bg-emerald-600 hover:bg-emerald-700" },
  { type: "lunch_out", label: "Lunch Out", color: "bg-amber-500 hover:bg-amber-600" },
  { type: "lunch_in", label: "Lunch In", color: "bg-sky-600 hover:bg-sky-700" },
  { type: "clock_out", label: "Clock Out", color: "bg-rose-600 hover:bg-rose-700" },
];
const LABEL: Record<PunchType, string> = { clock_in: "Clocked in", lunch_out: "Lunch started", lunch_in: "Back from lunch", clock_out: "Clocked out" };
const STATE_TEXT: Record<ClockState, string> = { off: "Not clocked in", working: "Working", lunch: "On lunch" };
const LOCATION_CODES = new Set(["LOCATION_REQUIRED", "GPS_OUTSIDE", "GPS_LOW_ACCURACY", "GPS_STALE"]);
const IDLE_RESET_MS = 60_000;

const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
const fmt = (iso: string) => timeFmt.format(new Date(iso));

function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Takes one fresh reading. Location is never watched or tracked in the background. */
function readLocation(): Promise<{ ok: true; reading: Reading } | { ok: false; code: string; message: string }> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ ok: false, code: "UNSUPPORTED", message: "This browser cannot share location." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          ok: true,
          reading: {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            ageSeconds: Math.max(0, (Date.now() - pos.timestamp) / 1000),
          },
        }),
      (err) => {
        const map: Record<number, [string, string]> = {
          1: ["PERMISSION_DENIED", "Location permission is turned off for this site. Allow location in your browser settings, then try again."],
          2: ["POSITION_UNAVAILABLE", "Your phone could not determine its location."],
          3: ["TIMEOUT", "Getting your location took too long."],
        };
        const [code, message] = map[err.code] ?? ["UNKNOWN", "Location could not be read."];
        resolve({ ok: false, code, message });
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await res.json().catch(() => ({ ok: false, code: "SERVER_ERROR", message: "Unexpected response." }));
  return data as { ok: boolean; code?: string; message?: string; [k: string]: unknown };
}

export function TimeClock({ kioskName }: { kioskName: string | null }) {
  const [pin, setPin] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "pin" });
  const [view, setView] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [now, setNow] = useState<Date | null>(null);
  // Reused for network retries of the same tap so the server records it at most once.
  const requestIds = useRef<Partial<Record<PunchType, string>>>({});

  const reset = useCallback(() => {
    setPin("");
    setView(null);
    setError(null);
    setReason("");
    requestIds.current = {};
    setPhase({ name: "pin" });
  }, []);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Forget the PIN automatically if the screen is left unattended.
  useEffect(() => {
    if (phase.name === "pin" && pin === "") return;
    const ms = phase.name === "done" ? (kioskName ? 6_000 : 20_000) : IDLE_RESET_MS;
    const t = setTimeout(reset, ms);
    return () => clearTimeout(t);
  }, [phase, pin, kioskName, reset]);

  async function identify(fullPin: string) {
    setError(null);
    setPhase({ name: "busy", label: "Checking PIN…" });
    try {
      const data = await post("/api/punch/identify", { pin: fullPin });
      if (!data.ok) {
        setPin("");
        setError(data.message ?? "PIN not recognized.");
        setPhase({ name: "pin" });
        return;
      }
      setView(data as unknown as StatusView);
      setPhase({ name: "ready" });
    } catch {
      setError("No connection. Check Wi-Fi or mobile data and try again.");
      setPhase({ name: "pin" });
    }
  }

  function pressDigit(d: string) {
    if (phase.name !== "pin") return;
    const next = (pin + d).slice(0, 6);
    setPin(next);
    setError(null);
    if (next.length === 6) void identify(next);
  }

  async function submit(action: PunchType, reading: Reading | null, exception?: { reason: string; gpsError: string }) {
    setError(null);
    setPhase({ name: "busy", label: "Saving…" });
    const clientRequestId = (requestIds.current[action] ??= newRequestId());
    let data;
    try {
      data = await post("/api/punch", { pin, action, clientRequestId, location: reading, exception });
    } catch {
      setError("No connection. Your punch was NOT confirmed. Tap the button again to retry.");
      setPhase({ name: "ready" });
      return;
    }
    if (data.ok) {
      const punch = data.punch as { type: PunchType; at: string; pendingReview: boolean };
      setView(data.status as StatusView);
      setPhase({ name: "done", type: punch.type, at: punch.at, pendingReview: punch.pendingReview, duplicate: Boolean(data.duplicate) });
      return;
    }
    // The tap was answered; a new tap is a new request.
    delete requestIds.current[action];
    if (data.code && LOCATION_CODES.has(data.code)) {
      setPhase({ name: "location-problem", action, message: data.message ?? "Location could not be verified.", gpsError: data.code, reading });
      return;
    }
    if (data.code === "INVALID_PIN" || data.code === "RATE_LIMITED") {
      reset();
      setError(data.message ?? "Please enter your PIN again.");
      return;
    }
    if (Array.isArray(data.allowedActions) && view) {
      setView({ ...view, state: data.state as ClockState, allowedActions: data.allowedActions as PunchType[] });
    }
    setError(data.message ?? "That punch could not be saved.");
    setPhase({ name: "ready" });
  }

  async function onAction(action: PunchType) {
    if (!view) return;
    if (!view.locationRequired) return submit(action, null);
    setPhase({ name: "busy", label: "Getting your location…" });
    const loc = await readLocation();
    if (!loc.ok) {
      setPhase({ name: "location-problem", action, message: loc.message, gpsError: loc.code, reading: null });
      return;
    }
    return submit(action, loc.reading);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-5 sm:max-w-lg">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold leading-tight">US Cabinet World</h1>
          <p className="text-sm text-slate-600">{kioskName ? `Time Clock · ${kioskName}` : "Time Clock"}</p>
        </div>
        <div className="text-right text-2xl font-semibold tabular-nums" suppressHydrationWarning>
          {now ? timeFmt.format(now) : ""}
        </div>
      </header>

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-rose-300 bg-rose-50 p-3 text-base text-rose-900">
          {error}
        </div>
      )}

      {phase.name === "pin" && <PinPad pin={pin} onDigit={pressDigit} onBack={() => setPin(pin.slice(0, -1))} onClear={() => setPin("")} />}

      {phase.name === "busy" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16" aria-live="polite">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-slate-300 border-t-slate-900" />
          <p className="text-lg">{phase.label}</p>
        </div>
      )}

      {phase.name === "ready" && view && (
        <section className="flex flex-1 flex-col gap-4">
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-2xl font-bold">Hi, {view.employee.firstName}</p>
            <p className="mt-1 text-base text-slate-700">
              Status: <strong>{STATE_TEXT[view.state]}</strong>
              {view.since && view.state !== "off" ? ` since ${fmt(view.since)}` : ""}
            </p>
            {view.staleOpenShift && (
              <p className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
                Your last shift was never clocked out. You can clock in now; a manager will fix the old shift.
              </p>
            )}
            <TodayList today={view.today} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {ACTIONS.map((a) => {
              const enabled = view.allowedActions.includes(a.type);
              return (
                <button
                  key={a.type}
                  type="button"
                  disabled={!enabled}
                  onClick={() => void onAction(a.type)}
                  className={`min-h-24 rounded-2xl px-3 text-xl font-bold shadow-sm transition ${enabled ? `${a.color} text-white` : "cursor-not-allowed bg-slate-200 text-slate-400"}`}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
          {view.locationRequired && (
            <p className="text-center text-xs text-slate-500">
              Your location is checked once, only when you tap a button. It is not tracked.
            </p>
          )}
          <button type="button" onClick={reset} className="mt-auto rounded-xl border border-slate-300 bg-white py-3 text-lg">
            Cancel
          </button>
        </section>
      )}

      {phase.name === "location-problem" && (
        <section className="flex flex-1 flex-col gap-4">
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
            <p className="text-lg font-bold">Location not verified</p>
            <p className="mt-1">{phase.message}</p>
          </div>
          <button type="button" onClick={() => void onAction(phase.action)} className="rounded-2xl bg-slate-900 py-4 text-lg font-bold text-white">
            Try again
          </button>
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <label htmlFor="reason" className="block font-semibold">
              Or send to a manager for review
            </label>
            <p className="mb-2 text-sm text-slate-600">Your time is recorded now and a manager will approve it.</p>
            <textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Why can't your location be verified? (e.g. GPS not working inside the building)"
              className="w-full rounded-xl border border-slate-300 p-3 text-base"
            />
            <button
              type="button"
              disabled={reason.trim().length < 5}
              onClick={() => void submit(phase.action, phase.reading, { reason, gpsError: phase.gpsError })}
              className="mt-3 w-full rounded-2xl bg-amber-600 py-4 text-lg font-bold text-white disabled:bg-slate-300 disabled:text-slate-500"
            >
              Submit {ACTIONS.find((a) => a.type === phase.action)?.label} for review
            </button>
          </div>
          <button type="button" onClick={reset} className="rounded-xl border border-slate-300 bg-white py-3 text-lg">
            Cancel
          </button>
        </section>
      )}

      {phase.name === "done" && view && (
        <section className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center" aria-live="polite">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-4xl text-emerald-700" aria-hidden>
            ✓
          </div>
          <p className="text-2xl font-bold">
            {LABEL[phase.type]} at {fmt(phase.at)}
          </p>
          <p className="text-lg text-slate-700">{view.employee.firstName}</p>
          {phase.duplicate && <p className="text-sm text-slate-600">This punch was already saved.</p>}
          {phase.pendingReview && (
            <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">Sent to a manager for location review.</p>
          )}
          <div className="w-full max-w-sm rounded-2xl bg-white p-4 text-left shadow-sm">
            <TodayList today={view.today} />
          </div>
          <button type="button" onClick={reset} className="w-full max-w-sm rounded-2xl bg-slate-900 py-4 text-lg font-bold text-white">
            Done
          </button>
        </section>
      )}
    </main>
  );
}

function TodayList({ today }: { today: StatusView["today"] }) {
  if (!today.length) return null;
  return (
    <div className="mt-3 border-t border-slate-200 pt-2">
      <p className="text-sm font-semibold text-slate-600">Today</p>
      <ul className="mt-1 space-y-0.5 text-sm">
        {today.map((t, i) => (
          <li key={i} className="flex justify-between">
            <span>{ACTIONS.find((a) => a.type === t.type)?.label}</span>
            <span className="tabular-nums">
              {fmt(t.at)}
              {t.pendingReview ? " (review)" : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PinPad({ pin, onDigit, onBack, onClear }: { pin: string; onDigit: (d: string) => void; onBack: () => void; onClear: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) onDigit(e.key);
      else if (e.key === "Backspace") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDigit, onBack]);

  return (
    <section className="flex flex-1 flex-col items-center gap-5">
      <p className="text-lg">Enter your 6-digit PIN</p>
      <div className="flex gap-3" aria-label={`${pin.length} of 6 digits entered`}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`h-4 w-4 rounded-full ${i < pin.length ? "bg-slate-900" : "bg-slate-300"}`} />
        ))}
      </div>
      <div className="grid w-full max-w-xs grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Key key={d} onClick={() => onDigit(d)}>
            {d}
          </Key>
        ))}
        <Key onClick={onClear} muted>
          Clear
        </Key>
        <Key onClick={() => onDigit("0")}>0</Key>
        <Key onClick={onBack} muted label="Delete last digit">
          ⌫
        </Key>
      </div>
    </section>
  );
}

function Key({ children, onClick, muted, label }: { children: React.ReactNode; onClick: () => void; muted?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`h-16 rounded-2xl font-semibold shadow-sm active:scale-95 ${muted ? "bg-slate-200 text-base text-slate-700" : "bg-white text-2xl"}`}
    >
      {children}
    </button>
  );
}

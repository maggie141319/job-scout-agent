"use client";

import { useState } from "react";

/** Fills latitude/longitude inputs from one reading of this device's GPS (for on-site verification). */
export function LocateButton({ latId, lngId }: { latId: string; lngId: string }) {
  const [msg, setMsg] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-secondary btn-sm"
        onClick={() => {
          setMsg("Reading GPS…");
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const set = (id: string, v: number) => {
                const el = document.getElementById(id) as HTMLInputElement | null;
                if (el) el.value = v.toFixed(6);
              };
              set(latId, pos.coords.latitude);
              set(lngId, pos.coords.longitude);
              setMsg(`Filled from this device (±${Math.round(pos.coords.accuracy)} m). Save, then verify.`);
            },
            (err) => setMsg(`Could not read location: ${err.message}`),
            { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
          );
        }}
      >
        Use this device&apos;s current location
      </button>
      {msg && <span className="text-sm text-slate-600">{msg}</span>}
    </div>
  );
}

"use client";

import { useActionState } from "react";
import { loginAction } from "../actions";
import { initialActionState } from "@/lib/action-state";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, initialActionState);
  return (
    <form action={action} className="card space-y-4">
      <div>
        <label htmlFor="username" className="label">Username</label>
        <input id="username" name="username" autoComplete="username" autoCapitalize="none" required className="input" />
      </div>
      <div>
        <label htmlFor="password" className="label">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
      </div>
      {state.message && <p role="alert" className="text-sm text-rose-700">{state.message}</p>}
      <button type="submit" disabled={pending} className="btn-primary w-full py-3">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

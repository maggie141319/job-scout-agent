"use client";

import { useActionState } from "react";
import { initialActionState, type ActionState } from "@/lib/action-state";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** Form bound to a server action that shows the result message inline. */
export function ActionForm({
  action,
  children,
  className,
  confirm,
  submitLabel,
  submitClass,
}: {
  action: Action;
  children?: React.ReactNode;
  className?: string;
  confirm?: string;
  submitLabel: string;
  submitClass?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={submitClass ?? "btn-primary"}>
          {pending ? "Working…" : submitLabel}
        </button>
        {state.message && (
          <span role="status" className={`text-sm ${state.ok ? "text-emerald-700" : "text-rose-700"}`}>
            {state.message}
          </span>
        )}
      </div>
      {state.secret && (
        <p className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-lg">
          PIN: <strong className="font-mono text-2xl tracking-widest">{state.secret}</strong>
        </p>
      )}
    </form>
  );
}

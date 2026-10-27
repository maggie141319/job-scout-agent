export interface ActionState {
  ok: boolean;
  message: string;
  /** One-time value to show the administrator (e.g. a newly generated PIN). Never logged. */
  secret?: string;
}

export const initialActionState: ActionState = { ok: false, message: "" };

/** An error whose message is safe to show to the user. */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

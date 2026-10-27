import "server-only";

/** Reads a required environment variable; throws a clear error (without the value) if absent. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

export function pinPepper(): string {
  const pepper = requireEnv("PIN_PEPPER");
  if (pepper.length < 32) throw new Error("PIN_PEPPER must be at least 32 characters.");
  return pepper;
}

export const isProduction = process.env.NODE_ENV === "production";

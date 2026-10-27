import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

/** Employee PINs are exactly 6 digits. */
export const PIN_PATTERN = /^\d{6}$/;

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_PATTERN.test(pin);
}

/** Rejects PINs that are trivially guessable (all same digit, straight runs). */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  return "0123456789".includes(pin) || "9876543210".includes(pin);
}

/**
 * Keyed hash of a PIN (HMAC-SHA256 with the server-side PIN_PEPPER secret).
 * Deterministic so PINs can be looked up and kept unique, but never stored in plaintext;
 * a database leak alone does not reveal PINs without the pepper held in env vars.
 */
export function hashPin(pin: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`uscw-pin:${pin}`).digest("hex");
}

export function generatePin(): string {
  for (;;) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!isWeakPin(pin)) return pin;
  }
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Password hash format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scryptAsync(password, Buffer.from(saltB64, "base64"), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const MIN_PASSWORD_LENGTH = 12;

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

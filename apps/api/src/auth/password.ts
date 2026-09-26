import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

/**
 * scryptSync used to be called directly on the request-handling thread --
 * Node has exactly one JS event loop, so every signup/login request
 * blocked that one thread for the full tens-of-milliseconds cost of the
 * hash, serializing the entire API (even unrelated /api/projects routes)
 * behind a burst of concurrent auth requests. The async scrypt() offloads
 * that work to libuv's threadpool instead, so the event loop stays free to
 * service other requests while a hash computes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = ((await scryptAsync(password, salt, KEY_LENGTH)) as Buffer).toString("hex");
  return `${salt}:${derived}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, derivedHex] = stored.split(":");
  if (!salt || !derivedHex) return false;
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  const expected = Buffer.from(derivedHex, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

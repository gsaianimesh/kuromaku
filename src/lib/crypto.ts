import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { getEnv } from "./env";

/**
 * AES-256-GCM envelope for BYOK model keys (SPEC section 4: "stored encrypted at
 * rest, never committed, never logged").
 *
 * Wire format, base64 of: [version:1][iv:12][authTag:16][ciphertext:n]
 * The version byte lets us rotate the scheme later without ambiguity.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
  return Buffer.from(getEnv().APP_ENCRYPTION_KEY, "base64");
}

export function encryptSecret(plaintext: string): string {
  if (plaintext.length === 0) throw new Error("Refusing to encrypt an empty secret");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]).toString("base64");
}

export function decryptSecret(envelope: string): string {
  const buf = Buffer.from(envelope, "base64");
  if (buf.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error("Malformed secret envelope");
  }
  if (buf[0] !== VERSION) {
    throw new Error(`Unsupported secret envelope version: ${buf[0]}`);
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Last 4 characters, for display. Never render more of a key than this.
 * Returns a fixed-width mask so the UI can't leak key length either.
 */
export function maskSecret(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `${"•".repeat(8)}${tail}`;
}

/** Constant-time compare, for the settings round-trip verification. */
export function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

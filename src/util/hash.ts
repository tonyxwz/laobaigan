import { createHash } from "node:crypto";

/** The first `length` hex characters of a string's SHA-256. */
export function shortHash(s: string, length = 16): string {
  return createHash("sha256").update(s).digest("hex").slice(0, length);
}

import { createHash } from "node:crypto";
import type { Transcript, Turn } from "../sources/types.ts";

/** Human-authored user turns: the ones that carry what I taught the agent. */
export function isHumanTurn(t: Turn): boolean {
  return t.role === "user" && (t.origin === "prompt" || t.origin === "command");
}

/**
 * Stable identity of a human turn, independent of which session file it lives in.
 * Resumed sessions that copy history into a new file (same text, same timestamp)
 * produce the same fingerprints, so they aren't extracted or counted twice.
 */
export function fingerprintTurn(t: Turn, fallback: { sessionId: string; index: number }): string {
  const text = t.text.replace(/\s+/g, " ").trim();
  // Second precision: copies sometimes differ in sub-second formatting.
  const when = t.ts ? t.ts.toISOString().slice(0, 19) : `${fallback.sessionId}#${fallback.index}`;
  return createHash("sha256").update(`${when}\n${text}`).digest("hex").slice(0, 32);
}

/** Fingerprints of every human turn, keyed by turn index. */
export function fingerprintTranscript(t: Transcript): Map<number, string> {
  const out = new Map<number, string>();
  t.turns.forEach((turn, index) => {
    if (isHumanTurn(turn)) out.set(index, fingerprintTurn(turn, { sessionId: t.sessionId, index }));
  });
  return out;
}

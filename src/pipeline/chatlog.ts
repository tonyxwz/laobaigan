import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "../config.ts";
import { parsePi } from "../sources/pi.ts";
import { readJsonl } from "../util/fs.ts";
import { isRecord, truncate } from "../util/text.ts";
import type { Turn } from "../state/feedback.ts";

async function jsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jsonlFiles(p)));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out.sort();
}

/**
 * The conversation of an interactive revise, read from pi's session files in `sessionDir`:
 * my prompts in full, the assistant's replies shortened for context. lbg's own opening
 * message isn't mine and is left out. Tool calls and results are dropped.
 */
export async function readChatTurns(sessionDir: string, opening?: string): Promise<Turn[]> {
  const turns: Turn[] = [];
  for (const file of await jsonlFiles(sessionDir)) {
    const lines = (await readJsonl(file)).filter(isRecord);
    const t = parsePi(lines, { agent: "pi", sessionId: file, location: file, updatedAt: new Date(), version: "" }, DEFAULT_LIMITS);
    for (const turn of t.turns) {
      if (turn.offBranch) continue;
      if (turn.role === "user" && turn.origin === "prompt") {
        if (opening && turn.text.trim() === opening.trim()) continue;
        turns.push({ role: "user", text: turn.text });
      } else if (turn.role === "assistant" && turn.text.trim()) {
        turns.push({ role: "assistant", text: truncate(turn.text.trim(), 600) });
      }
    }
  }
  return turns;
}

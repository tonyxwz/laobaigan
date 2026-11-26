import { join } from "node:path";
import { loadConfig } from "../config.ts";
import {
  promptFile,
  promptSnippets,
  writePromptStatus,
} from "../notify/prompt.ts";
import { StateDb } from "../state/db.ts";
import type { Context } from "./context.ts";

/** `lbg prompt`. */
export async function promptCommand(ctx: Context): Promise<number> {
  const { values, out, json } = ctx;
  const cfg = loadConfig();
  const db = new StateDb(join(cfg.stateDir, "state.db"));
  try {
    const n = writePromptStatus(db, cfg.stateDir);
    const path = promptFile(cfg.stateDir);
    if (values.json) {
      json({ waiting: n, path });
      return 0;
    }
    const { starship, zsh } = promptSnippets(path);
    out(
      `${n ? `${n} proposal(s) waiting for review` : "nothing waiting"} (${path})\n\n`,
    );
    out(
      `Show it in your prompt (lbg never edits your dotfiles):\n\n${starship}\n\n${zsh}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

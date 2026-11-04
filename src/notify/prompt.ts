import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateDb } from "../state/db.ts";
import { Proposals } from "../state/proposals.ts";

/**
 * The shell prompt segment: `<stateDir>/prompt` holds the number of proposals
 * waiting for review, and is empty when there are none. The prompt (starship
 * custom module or a zsh precmd) only reads this file, so it costs no `node`.
 */
export function promptFile(stateDir: string): string {
  return join(stateDir, "prompt");
}

/** Rewrite the prompt file from the db (atomic: a prompt never reads a half-written file). */
export function writePromptStatus(db: StateDb, stateDir: string): number {
  const open = new Proposals(db).list(["open"]).length;
  const path = promptFile(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, open ? String(open) : "");
  renameSync(tmp, path);
  return open;
}

/** Snippets for the shell, using `path` (shown by `lbg prompt`). */
export function promptSnippets(path: string): { starship: string; zsh: string } {
  const home = process.env.HOME ?? "";
  const p = home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  return {
    starship: [
      "# ~/.config/starship.toml",
      "[custom.lbg]",
      'description = "laobaigan proposals waiting for review"',
      `when = "test -s ${p}"`,
      `command = "cat ${p}"`,
      'shell = ["sh"]',
      'format = "[🍶 $output]($style) "',
      'style = "bold yellow"',
    ].join("\n"),
    zsh: [
      "# ~/.zshrc (without starship)",
      `_lbg_prompt() { local f=${p}; [[ -s $f ]] && RPROMPT="%F{yellow}🍶 $(<$f)%f" || RPROMPT=""; }`,
      "precmd_functions+=(_lbg_prompt)",
    ].join("\n"),
  };
}

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { Config } from "../config.ts";

/**
 * `lbg proposal accept <id> --commit`: run the user's commit command (config.commitCommand)
 * after the files are written. lbg itself never runs git; this is the user's own command.
 *
 * Placeholders (values are shell-quoted, so they're safe anywhere in the command):
 *   ${updated_files}  every written or deleted file, absolute paths, each quoted
 *   ${draft_note}     the suggested commit message
 *   ${target_root}    the skills dir, or the repo root
 *   ${skill}          the skill name
 *   ${proposal_id}    the proposal id
 * `~` in the template means the home directory (sh wouldn't expand it after `=`).
 */

export const COMMIT_PLACEHOLDERS = ["updated_files", "draft_note", "target_root", "skill", "proposal_id"] as const;

export interface CommitVars {
  updatedFiles: string[];
  draftNote: string;
  targetRoot: string;
  skill: string;
  proposalId: number;
}

/** POSIX single-quoting. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The configured command for a proposal's scope, if any. */
export function commitTemplate(cfg: Pick<Config, "commitCommand">, scope: "global" | "repo"): string | undefined {
  const c = cfg.commitCommand;
  return typeof c === "string" ? c : c?.[scope];
}

/** Expand `~` at the start of a word or right after `=` / `:` (template text only, never values). */
export function expandTilde(template: string, home = homedir()): string {
  return template.replace(/(^|[\s=:])~(?=\/|\s|$)/g, (_, pre: string) => `${pre}${home}`);
}

export function renderCommit(template: string, v: CommitVars, home = homedir()): string {
  const values: Record<(typeof COMMIT_PLACEHOLDERS)[number], string> = {
    updated_files: v.updatedFiles.map(shQuote).join(" "),
    draft_note: shQuote(v.draftNote),
    target_root: shQuote(v.targetRoot),
    skill: shQuote(v.skill),
    proposal_id: String(v.proposalId),
  };
  const unknown = [...template.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]!).filter((k) => !(COMMIT_PLACEHOLDERS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`commitCommand: unknown placeholder(s) ${unknown.map((k) => `\${${k}}`).join(", ")}; use ${COMMIT_PLACEHOLDERS.map((k) => `\${${k}}`).join(", ")}`);
  // Expand ~ first, so a ~ inside a substituted value (e.g. the note) stays literal.
  return expandTilde(template, home).replace(/\$\{(\w+)\}/g, (_, k: keyof typeof values) => values[k]);
}

/** Run with /bin/sh in `cwd`; output goes straight to the terminal. Returns the exit code. */
export function runCommit(command: string, cwd: string, opts: { stdio?: "inherit" | "pipe" } = {}): { status: number; output: string } {
  const r = spawnSync("/bin/sh", ["-c", command], { cwd, stdio: opts.stdio ?? "inherit", encoding: "utf8" });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

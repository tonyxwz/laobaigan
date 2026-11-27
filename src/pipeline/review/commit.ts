import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import type { ProposalRow } from "../../state/proposals.ts";
import type { Tree } from "../../state/tree.ts";
import { isPublicRepo, privateTermsIn } from "../common/privacy.ts";

import { currentFile } from "./proposal-view.ts";

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

export const COMMIT_PLACEHOLDERS = [
  "updated_files",
  "draft_note",
  "target_root",
  "skill",
  "proposal_id",
] as const;

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
export function commitTemplate(
  cfg: Pick<Config, "commitCommand">,
  scope: "global" | "repo",
): string | undefined {
  const c = cfg.commitCommand;
  return typeof c === "string" ? c : c?.[scope];
}

/** Expand `~` at the start of a word or right after `=` / `:` (template text only, never values). */
export function expandTilde(template: string, home = homedir()): string {
  return template.replace(
    /(^|[\s=:])~(?=\/|\s|$)/g,
    (_, pre: string) => `${pre}${home}`,
  );
}

export function renderCommit(
  template: string,
  v: CommitVars,
  home = homedir(),
): string {
  const values: Record<(typeof COMMIT_PLACEHOLDERS)[number], string> = {
    updated_files: v.updatedFiles.map(shQuote).join(" "),
    draft_note: shQuote(v.draftNote),
    target_root: shQuote(v.targetRoot),
    skill: shQuote(v.skill),
    proposal_id: String(v.proposalId),
  };
  const unknown = [...template.matchAll(/\$\{(\w+)\}/g)]
    .map((m) => m[1]!)
    .filter((k) => !(COMMIT_PLACEHOLDERS as readonly string[]).includes(k));
  if (unknown.length)
    throw new Error(
      `commitCommand: unknown placeholder(s) ${unknown.map((k) => `\${${k}}`).join(", ")}; use ${COMMIT_PLACEHOLDERS.map((k) => `\${${k}}`).join(", ")}`,
    );
  // Expand ~ first, so a ~ inside a substituted value (e.g. the note) stays literal.
  return expandTilde(template, home).replace(
    /\$\{(\w+)\}/g,
    (_, k: keyof typeof values) => values[k],
  );
}

/** Run with /bin/sh in `cwd`; output goes straight to the terminal. Returns the exit code. */
export function runCommit(
  command: string,
  cwd: string,
  opts: { stdio?: "inherit" | "pipe" } = {},
): { status: number; output: string } {
  const r = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    stdio: opts.stdio ?? "inherit",
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  return {
    status: r.status ?? 1,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

export interface CommitTarget {
  paths: string[];
  commitMessage: string;
  /** Files that no longer contain what the proposal wrote (edited or committed differently since). */
  changedSince: string[];
}

/**
 * What to commit for an already-accepted proposal (e.g. accepted without --commit): its
 * files as absolute paths, the suggested message, and which files changed since.
 */
export async function commitTargetFor(
  tree: Tree,
  p: ProposalRow,
  cfg?: Pick<Config, "privacy">,
): Promise<CommitTarget> {
  if (p.status !== "accepted")
    throw new Error(
      `Proposal #${p.id} is ${p.status}; only accepted proposals have files to commit`,
    );
  const changedSince: string[] = [];
  for (const f of p.files) {
    const now = await currentFile(p.targetRoot, f.path);
    if (now !== f.content) changedSince.push(f.path);
  }
  return {
    paths: p.files.map((f) => join(p.targetRoot, f.path)),
    commitMessage: commitMessageFor(tree, p, cfg),
    changedSince,
  };
}

/**
 * A commit message you can use; lbg itself never commits. For a public repo the drafter's
 * summary is left out when it contains a private term: the message is published too.
 */
export function commitMessageFor(
  tree: Tree,
  p: ProposalRow,
  cfg?: Pick<Config, "privacy">,
): string {
  const summary =
    p.summary &&
    cfg &&
    p.scope === "repo" &&
    isPublicRepo(p.targetRoot, cfg) &&
    privateTermsIn(p.summary, cfg).length
      ? undefined
      : p.summary;
  const verb =
    p.kind === "new"
      ? "add"
      : p.kind === "update"
        ? "update"
        : "fix description of";
  const nuggets = tree.db.nuggets().filter((n) => p.nuggetIds.includes(n.id));
  const agents = [...new Set(nuggets.map((n) => n.agent))].sort();
  return [
    `skills: ${verb} ${p.skillName ?? `#${p.nodeId}`}`,
    "",
    ...(summary ? [summary.trim(), ""] : []),
    `From ${nuggets.length} explanation(s) in ${p.sessions} session(s) (${agents.join(", ")}), drafted by laobaigan.`,
  ].join("\n");
}

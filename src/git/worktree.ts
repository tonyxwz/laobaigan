import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoTarget } from "../config.ts";

const execFileP = promisify(execFile);

/**
 * Environment for child git processes. Strip variables that would redirect git
 * to a different repository (e.g. if laobaigan is launched from a shell where
 * a dotfiles alias exported GIT_DIR).
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[k];
  return env;
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, env: gitEnv(), maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")}: ${(e.stderr || e.message).trim()}`);
  }
}

/** Arguments that address the target's repository (works for bare dotfiles repos). */
export function repoArgs(t: RepoTarget): string[] {
  return t.gitDir ? [`--git-dir=${t.gitDir}`, `--work-tree=${t.workTree}`] : ["-C", t.workTree];
}

/** Run git against the target's main repository. */
export function gitRepo(t: RepoTarget, args: string[]): Promise<string> {
  return git([...repoArgs(t), ...args]);
}

/** Run git inside a worktree (worktrees have a `.git` file, so no --git-dir needed). */
export function gitIn(worktree: string, args: string[]): Promise<string> {
  return git(["-C", worktree, ...args]);
}

export async function branchExists(t: RepoTarget, branch: string): Promise<boolean> {
  try {
    await gitRepo(t, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** `laobaigan/<slug>-<yyyymmdd-hhmm>`; slug is kebab-cased and bounded. */
export function proposalBranchName(prefix: string, slug: string, now = new Date()): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `${prefix}${clean || "proposal"}-${stamp}`;
}

export interface Worktree {
  branch: string;
  path: string;
  base: string;
  baseCommit: string;
}

/**
 * Create a new branch from the base branch and check it out in a new worktree.
 * Never touches the base branch or the main checkout.
 */
export async function createWorktree(t: RepoTarget, worktreesDir: string, branch: string): Promise<Worktree> {
  if (await branchExists(t, branch)) throw new Error(`Branch already exists: ${branch}`);
  const baseCommit = (await gitRepo(t, ["rev-parse", "--verify", `refs/heads/${t.baseBranch}`])).trim();
  const path = join(worktreesDir, branch.replace(/\//g, "__"));
  await mkdir(worktreesDir, { recursive: true });
  await gitRepo(t, ["worktree", "add", "-b", branch, path, baseCommit]);
  return { branch, path, base: t.baseBranch, baseCommit };
}

/** Paths changed in the worktree relative to its HEAD (staged, unstaged, and untracked). */
export async function pendingChanges(worktree: string): Promise<string[]> {
  const out = await gitIn(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths: string[] = [];
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.startsWith("R") || status.startsWith("C")) i++; // skip rename source
  }
  return paths;
}

/**
 * Stage exactly `paths` and commit. Returns the new commit sha.
 * Explicit paths (not `add -A`) so a dotfiles worktree never sweeps in unrelated files.
 */
export async function commitPaths(worktree: string, paths: string[], message: string): Promise<string> {
  if (paths.length === 0) throw new Error("Nothing to commit");
  await gitIn(worktree, ["add", "--", ...paths]);
  await gitIn(worktree, ["commit", "--no-verify", "-m", message, "--", ...paths]);
  return (await gitIn(worktree, ["rev-parse", "HEAD"])).trim();
}

/**
 * True once `branch` has been merged into the base branch (by me, outside the tool).
 * With `baseCommit`, a branch that never moved past it (no proposal commit) is not "merged".
 */
export async function isMerged(t: RepoTarget, branch: string, baseCommit?: string): Promise<boolean> {
  try {
    if (baseCommit && (await gitRepo(t, ["rev-parse", `refs/heads/${branch}`])).trim() === baseCommit) return false;
    await gitRepo(t, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/heads/${t.baseBranch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Remove a proposal worktree; optionally delete its branch (only if merged, unless forced). */
export async function removeWorktree(
  t: RepoTarget,
  wt: Pick<Worktree, "branch" | "path"> & { baseCommit?: string },
  opts: { deleteBranch?: "if-merged" | "force" } = {},
): Promise<void> {
  await gitRepo(t, ["worktree", "remove", "--force", wt.path]).catch(async (e: unknown) => {
    // Already gone from disk: prune the stale entry instead.
    await gitRepo(t, ["worktree", "prune"]);
    if (!String(e).includes("is not a working tree")) throw e;
  });
  if (opts.deleteBranch === "force") await gitRepo(t, ["branch", "-D", wt.branch]);
  else if (opts.deleteBranch === "if-merged" && (await isMerged(t, wt.branch, wt.baseCommit)))
    await gitRepo(t, ["branch", "-d", wt.branch]);
}

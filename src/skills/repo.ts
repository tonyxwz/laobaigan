import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { exists, subdirs } from "../util/fs.ts";
import { gitTopLevel } from "./index.ts";

export type RepoResolution =
  | { ok: true; root: string; via: "git" | "workspace-package" }
  | { ok: false; reason: string; candidates: string[] };

/** A multi-package workspace root (not a repo itself): a `packageInfo` file and per-package repos under `src/`. */
export async function isPackageWorkspace(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "packageInfo"))).isFile() && (await exists(join(dir, "src")));
  } catch {
    return false;
  }
}

function countMentions(text: string, name: string): number {
  const re = new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "gi");
  return text.match(re)?.length ?? 0;
}

/**
 * Resolve where repo-scoped knowledge should be committed.
 *  - inside a git repo → that repo's top-level
 *  - a multi-package workspace root (not a repo) → the package under `src/` the text refers to,
 *    if one package is mentioned at least twice as often as any other; unresolved (with
 *    candidates) on no clear winner, or when the topic names 3+ packages (workspace-wide)
 *
 * `text` is everything known about the topic: cluster title, summary, member knowledge, quotes.
 */
export async function resolveRepo(path: string, text: string): Promise<RepoResolution> {
  if (!path) return { ok: false, reason: "no repository path", candidates: [] };
  const top = await gitTopLevel(path);
  if (top) return { ok: true, root: top, via: "git" };
  if (!(await isPackageWorkspace(path))) return { ok: false, reason: `${path} is not a git repo or a multi-package workspace`, candidates: [] };

  const packages: string[] = [];
  for (const d of await subdirs(join(path, "src"))) if ((await gitTopLevel(d)) === d) packages.push(d);
  if (packages.length === 0) return { ok: false, reason: `workspace ${path} has no package repos under src/`, candidates: [] };
  if (packages.length === 1) return { ok: true, root: packages[0]!, via: "workspace-package" };

  const ranked = packages
    .map((p) => ({ p, n: countMentions(text, basename(p)) + 3 * countMentions(text, p) }))
    .sort((a, b) => b.n - a.n);
  const mentioned = ranked.filter((r) => r.n > 0);
  const [first, second] = ranked;
  // Knowledge naming most of the workspace's packages is about the workspace itself.
  if (mentioned.length >= 3) {
    return { ok: false, reason: `workspace ${path}: topic spans ${mentioned.length} packages`, candidates: packages };
  }
  if (first && first.n > 0 && (!second || first.n >= 2 * second.n)) return { ok: true, root: first.p, via: "workspace-package" };
  return {
    ok: false,
    reason: `workspace ${path}: can't tell which package (${first && first.n > 0 ? "no clear winner" : "none mentioned"})`,
    candidates: packages,
  };
}

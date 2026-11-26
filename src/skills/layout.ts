import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Where agents keep their files in a repository: skills, instruction files, rules, documents. */

/**
 * Where agents keep a repository's skills, in order of preference. Many repos have several
 * (often symlinked to one another); lbg mirrors them all and writes new skills to the first
 * one the repo already uses.
 */
export const AGENT_SKILL_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".pi/skills",
  ".codex/skills",
  ".gemini/skills",
  ".opencode/skills",
  ".cursor/skills",
  ".kiro/skills",
  ".github/skills",
];

/** Instruction files agents load from a repository's root, plus the README. */
export const AGENT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  ".github/copilot-instructions.md",
];

/** Directories of per-agent instruction files (rules), other than skills. */
export const AGENT_RULE_DIRS = [
  ".claude/rules",
  ".cursor/rules",
  ".kiro/steering",
  ".github/instructions",
];

/**
 * Of `candidates` (paths relative to `repo`), those that exist, stay inside the repo once
 * symlinks are resolved, and aren't another name for (or inside) an earlier one.
 */
export async function distinctExisting(
  repo: string,
  candidates: string[],
): Promise<string[]> {
  let root: string;
  try {
    root = await realpath(repo);
  } catch {
    return [];
  }
  const within = (child: string, parent: string) =>
    child === parent || child.startsWith(`${parent}/`);
  const kept: { rel: string; real: string }[] = [];
  for (const rel of candidates) {
    let real: string;
    try {
      real = await realpath(join(repo, rel));
    } catch {
      continue;
    }
    if (!within(real, root) || kept.some((k) => within(real, k.real))) continue;
    kept.push({ rel, real });
  }
  return kept.map((k) => k.rel);
}

/** The skills directories a repo has, one entry per real directory. */
export function repoSkillDirs(repo: string): Promise<string[]> {
  return distinctExisting(repo, AGENT_SKILL_DIRS);
}

/** Max documents mirrored per docs directory. */
export const MAX_DOCS = 30;

/** The markdown files directly inside each docs directory of a repo, as paths relative to it. */
export async function repoDocFiles(
  repo: string,
  docDirs: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const dir of docDirs) {
    let names: string[];
    try {
      names = (await readdir(join(repo, dir))).sort();
    } catch {
      continue;
    }
    out.push(
      ...names
        .filter((f) => /\.md$/i.test(f))
        .slice(0, MAX_DOCS)
        .map((f) => join(dir, f)),
    );
  }
  return out;
}

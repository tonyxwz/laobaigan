import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { FileGuard } from "../pi/guard.ts";
import {
  AGENT_FILES,
  AGENT_RULE_DIRS,
  AGENT_SKILL_DIRS,
  distinctExisting,
} from "../skills/layout.ts";
import { isValidSkillName } from "../skills/name.ts";
import { resolveRepo } from "../skills/repo.ts";
import { subtreeNuggets, type TreeNode } from "../state/tree.ts";
import { HOMES, homeOf, type RepoPlace } from "./homes.ts";
import { evidenceText, skillName } from "./stats.ts";

/**
 * Where a draft goes (paths relative to the target root). For a repo this is the PRIMARY target: what the
 * proposal is about. The draft may also change the repo's other agent files and documents
 * (repoWritable), and may read anything in the repo:
 *   global                        <skillsDir>  ⟶  <name>/  (SKILL.md + references/)
 *   repo, live AGENTS.md section  <repo>       ⟶  AGENTS.md (that section only; the intro: the text before the first section)
 *   repo, live document           <repo>       ⟶  docs/<x>.md; for a fix-description, a pointer to it in AGENTS.md
 *   repo, live .agents skill      <repo>       ⟶  .agents/skills/<name>/
 *   repo, latent                  <repo>       ⟶  .agents/skills/<name>/ or a new AGENTS.md section
 */

export interface RenderTarget {
  /** Directory the paths are relative to: the global skills dir, or the repo root. */
  root: string;
  skillName: string;
  /** Paths the session may write ("dir/" = subtree): the primary paths first. */
  writable: string[];
  /** What the proposal is about: the paths the draft is expected to change. */
  primary: string[];
  /** The live repository, readable (never writable) by the drafter. */
  readRoot?: string;
  /** Skill folder, when the target is a skill. */
  skillDir?: string;
  /** AGENTS.md (or CLAUDE.md), when it may be edited. */
  agentsMd?: string;
  /** For live AGENTS.md sections: the heading being updated. */
  section?: string;
  /** The target is the AGENTS.md intro: the text before its first "##" section. */
  intro?: boolean;
  /** A repository document (docs/<x>.md): the file being updated, or pointed at. */
  doc?: string;
  /** Write a pointer to `doc` into AGENTS.md instead of changing the document. */
  pointer?: boolean;
}

/**
 * Everything a draft for a repo may change: its agent instruction files and README, the
 * skills and rules directories of every agent it uses, and its documents. Only what exists
 * (one entry per real file or directory, symlinked aliases dropped), plus `primary`.
 */
export async function repoWritable(
  root: string,
  docDirs: string[],
  primary: string[],
): Promise<string[]> {
  const dirs = new Set([...AGENT_SKILL_DIRS, ...AGENT_RULE_DIRS, ...docDirs]);
  const extra = (
    await distinctExisting(root, [
      ...AGENT_FILES,
      ...AGENT_SKILL_DIRS,
      ...AGENT_RULE_DIRS,
      ...docDirs,
    ])
  ).map((p) => (dirs.has(p) ? `${p}/` : p));
  return [...primary, ...extra.filter((e) => !isAllowed(e, primary))];
}

export function isAllowed(path: string, writable: string[]): boolean {
  return writable.some((w) =>
    w.endsWith("/") ? path.startsWith(w) : path === w,
  );
}

/** The file guard for a drafting session in `scratch`. */
export function guardFor(scratch: string, target: RenderTarget): FileGuard {
  return {
    root: scratch,
    writable: target.writable,
    ...(target.readRoot ? { readRoots: [target.readRoot] } : {}),
  };
}

export class SkipError extends Error {}

export async function resolveTarget(
  skill: TreeNode,
  cfg: Config,
): Promise<RenderTarget> {
  const name = isValidSkillName(skill.name)
    ? skill.name
    : skillName(skill.title);
  if (skill.scope === "global")
    return {
      root: cfg.skillsDir,
      skillName: name,
      writable: [`${name}/`],
      primary: [`${name}/`],
      skillDir: name,
    };
  const members = subtreeNuggets(skill);
  const r = await resolveRepo(
    skill.repo ?? "",
    evidenceText({ title: skill.title, summary: skill.summary, members }),
  );
  if (!r.ok)
    throw new SkipError(
      `can't tell which repository: ${r.reason}${r.candidates.length ? ` (candidates: ${r.candidates.join(", ")})` : ""}`,
    );
  const root = r.root;
  if (root !== skill.repo) {
    throw new SkipError(
      `evidence is filed under ${skill.repo}, which maps to ${root}; drafting for workspace roots isn't supported yet`,
    );
  }
  const place: RepoPlace = {
    root,
    name,
    agentsMd:
      existsSync(join(root, "AGENTS.md")) ||
      !existsSync(join(root, "CLAUDE.md"))
        ? "AGENTS.md"
        : "CLAUDE.md",
  };
  // Where the draft goes depends on the node's home; a node without a usable file is latent.
  const at =
    (await homeOf(skill).place(skill, place)) ??
    (await HOMES.latent.place(skill, place));
  if (!at) throw new SkipError("no place to draft into");
  return {
    root,
    skillName: name,
    writable: await repoWritable(root, cfg.repoDocs, at.primary),
    primary: at.primary,
    readRoot: root,
    ...at.place,
  };
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import {
  AGENT_FILES,
  AGENT_RULE_DIRS,
  AGENT_SKILL_DIRS,
  distinctExisting,
} from "../../skills/layout.ts";
import { isValidSkillName, skillName } from "../../skills/name.ts";
import { resolveRepo } from "../../skills/repo.ts";
import { subtreeNuggets, type TreeNode } from "../../state/tree.ts";
import { HOMES, homeOf, type RepoPlace } from "../common/homes.ts";
import { isAllowed, type RenderTarget } from "../common/target.ts";
import { evidenceText } from "../tree/stats.ts";

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

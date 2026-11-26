import { dirname, relative } from "node:path";
import { AGENT_SKILL_DIRS, repoSkillDirs } from "../skills/layout.ts";
import { type FileNodeKind, fileNodeKind } from "../skills/parse.ts";
import type { ProposalRow } from "../state/proposals.ts";
import type { ProposalKind, TreeNode } from "../state/tree.ts";
import type { RenderTarget } from "./target.ts";

/**
 * Homes: the kinds of place a skill node's knowledge lives in. Everything that differs by
 * kind is here, one object per kind, so that a new kind of home is one more entry:
 *
 *   agents-section  a "##" section of AGENTS.md (or CLAUDE.md)
 *   agents-intro    the text before its first "##" section
 *   doc             a repository document (docs/<x>.md), or a pointer to it in AGENTS.md
 *   skill           a skill folder that exists
 *   latent          no file yet: a new skill folder or, in a repo, a new AGENTS.md section
 */
export type HomeKind = FileNodeKind | "latent";

/** The part of a render target that says where the draft goes. */
export type TargetPlace = Pick<
  RenderTarget,
  "skillDir" | "agentsMd" | "section" | "intro" | "doc" | "pointer"
>;

/** What a home needs to know about the repository to place a draft in it. */
export interface RepoPlace {
  root: string;
  /** The name a new skill folder would get. */
  name: string;
  /** The repo's instruction file: AGENTS.md, or CLAUDE.md when only that exists. */
  agentsMd: string;
}

export interface Home {
  /**
   * Agents always read this text. When its knowledge is explained again, the text is not
   * the problem, so there is no description to fix.
   */
  alwaysLoaded: boolean;
  /**
   * Where a draft for this node goes in its repository: the paths the proposal is about and
   * the place they describe. Undefined when the node's source path doesn't fit this home.
   */
  place: (
    skill: TreeNode,
    repo: RepoPlace,
  ) =>
    | Promise<{ primary: string[]; place: TargetPlace } | undefined>
    | { primary: string[]; place: TargetPlace }
    | undefined;
  /** The same place, rebuilt from the primary paths a proposal stored. */
  restore: (
    skill: TreeNode,
    p: ProposalRow,
    primary: { dir?: string | undefined; file?: string | undefined },
  ) => TargetPlace;
  /** The drafter's task, in one line. */
  task: (target: RenderTarget, kind: ProposalKind) => string;
}

/** A skill folder and/or an instruction file, as stored: what every home falls back to. */
const stored = (primary: {
  dir?: string | undefined;
  file?: string | undefined;
}): TargetPlace => ({
  ...(primary.dir ? { skillDir: primary.dir.replace(/\/$/, "") } : {}),
  ...(primary.file ? { agentsMd: primary.file } : {}),
});

/** The instruction file a section or intro node mirrors, relative to the repo. */
function instructionFile(skill: TreeNode, root: string): string | undefined {
  const m = /^(.*\/(?:AGENTS|CLAUDE)\.md)#/.exec(skill.sourcePath ?? "");
  return m?.[1] ? relative(root, m[1]) : undefined;
}

const latent: Home = {
  alwaysLoaded: false,
  // A new skill goes where the repo already keeps skills.
  place: async (_skill, { root, name, agentsMd }) => {
    const dir =
      (await repoSkillDirs(root))[0] ?? AGENT_SKILL_DIRS[0] ?? ".agents/skills";
    const skillDir = `${dir}/${name}`;
    return {
      primary: [`${skillDir}/`, agentsMd],
      place: { skillDir, agentsMd },
    };
  },
  restore: (_skill, _p, primary) => stored(primary),
  task: (target) =>
    target.agentsMd
      ? `Task: write this repository knowledge. Short rules and facts (a few lines) go into a new "##" section of ${target.agentsMd}; a multi-step procedure becomes the skill ${target.skillDir}/SKILL.md (+ references/). Pick one.`
      : `Task: create the new skill ${target.skillDir}/SKILL.md (name: ${target.skillName}), with references/<subtopic>.md where useful.`,
};

export const HOMES: Record<HomeKind, Home> = {
  "agents-section": {
    alwaysLoaded: true,
    place: (skill, { root }) => {
      const agentsMd = instructionFile(skill, root);
      return agentsMd
        ? { primary: [agentsMd], place: { agentsMd, section: skill.title } }
        : undefined;
    },
    restore: (skill, _p, primary) => ({
      ...stored(primary),
      ...(primary.file && !primary.dir ? { section: skill.title } : {}),
    }),
    task: (target) =>
      `Task: update the "## ${target.section}" section of ${target.agentsMd}.`,
  },

  "agents-intro": {
    alwaysLoaded: true,
    place: (skill, { root }) => {
      const agentsMd = instructionFile(skill, root);
      return agentsMd
        ? { primary: [agentsMd], place: { agentsMd, intro: true } }
        : undefined;
    },
    restore: (_skill, _p, primary) => ({
      ...stored(primary),
      ...(primary.file && !primary.dir ? { intro: true } : {}),
    }),
    task: (target) =>
      `Task: update the text before the first "##" section of ${target.agentsMd}. Keep it short, since every agent in the repository always reads it.`,
  },

  doc: {
    alwaysLoaded: false,
    place: (skill, { root, agentsMd }) => {
      const doc = relative(root, skill.sourcePath ?? "");
      // The document already says it and it was explained again: agents didn't read it.
      // What's missing is a pointer in AGENTS.md, not more text in the document.
      return skill.proposalKind === "fix-description"
        ? { primary: [agentsMd], place: { agentsMd, doc, pointer: true } }
        : { primary: [doc], place: { doc } };
    },
    // Drafted for a document: either the document itself, or a pointer to it in AGENTS.md.
    restore: (skill, p, primary) => {
      if (!primary.file || primary.dir) return stored(primary);
      const doc = relative(p.targetRoot, skill.sourcePath ?? "");
      return primary.file === doc
        ? { doc }
        : { agentsMd: primary.file, doc, pointer: true };
    },
    task: (target) =>
      target.pointer && target.agentsMd
        ? `Task: ${target.doc} already states the knowledge below, yet the engineer had to explain it again: agents working in this repository did not read that document. Make ${target.agentsMd} point to it: add (or sharpen) one or two lines saying WHEN to read ${target.doc}, naming the tasks, files and commands involved. Put them where ${target.agentsMd} lists its documentation, or in a new short "##" section if it has no such place. Do not copy the document's content into ${target.agentsMd}.`
        : `Task: update the document ${target.doc}. Read it first; add the new knowledge to the section it belongs to (a new "##" section only if none fits) and change as little as needed.`,
  },

  skill: {
    alwaysLoaded: false,
    // A live skill stays in whichever agent's directory it is in.
    place: (skill, { root }) => {
      const skillDir = relative(root, dirname(skill.sourcePath ?? ""));
      return { primary: [`${skillDir}/`], place: { skillDir } };
    },
    restore: (_skill, _p, primary) => stored(primary),
    task: (target) =>
      `Task: update the existing skill ${target.skillDir}/. Read its files first and keep their structure and voice; change as little as needed.`,
  },

  latent,
};

/** The home of a tree node: what its file is, or `latent` when it has none (yet). */
export function homeOf(skill: Pick<TreeNode, "origin" | "sourcePath">): Home {
  return HOMES[homeKindOf(skill)];
}

export function homeKindOf(
  skill: Pick<TreeNode, "origin" | "sourcePath">,
): HomeKind {
  return skill.origin === "file"
    ? (fileNodeKind(skill.sourcePath) ?? "latent")
    : "latent";
}

/**
 * The home a render target was resolved for, read back from its place. A target can outlive
 * the node's state (a draft is revised after the files changed), so the target decides.
 */
export function homeOfTarget(target: RenderTarget, kind: ProposalKind): Home {
  if (target.doc) return HOMES.doc;
  if (target.agentsMd && target.intro) return HOMES["agents-intro"];
  if (target.agentsMd && target.section) return HOMES["agents-section"];
  return kind === "new" ? HOMES.latent : HOMES.skill;
}

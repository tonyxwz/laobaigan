import type { FileGuard } from "../../agents/guard.ts";

/**
 * Where a draft goes (paths relative to the target root). For a repo this is the PRIMARY target: what the
 * proposal is about. The draft may also change the repo's other agent files and documents
 * (repoWritable in draft/resolve-target.ts), and may read anything in the repo:
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

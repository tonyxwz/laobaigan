import { basename } from "node:path";
import type { Config } from "../config.ts";
import { parseFrontmatter } from "../skills/index.ts";
import { AGENT_SKILL_DIRS } from "../skills/layout.ts";
import type { DraftFile } from "../state/proposals.ts";
import { privateHits, privateProblems } from "./privacy.ts";
import { containsSecrets } from "./redact.ts";
import { isAllowed, type RenderTarget } from "./target.ts";

/** Checks a finished draft must pass before it becomes a proposal. */

const GENERATED_BLOCK =
  /<!--\s*(BEGIN\b[^>]*?)-->[\s\S]*?<!--\s*END\b[^>]*?-->/g;

/** What a check looks at. */
interface Draft {
  /** The changes. */
  files: DraftFile[];
  /** The originals of the writable paths. */
  base: Map<string, string>;
  /** The writable paths as the draft leaves them. */
  after: Map<string, string>;
  target: RenderTarget;
  cfg: Config;
}

/** One rule a draft must pass. Returns its problems; none = passed. */
type Check = (d: Draft) => string[];

const changesSomething: Check = ({ files }) =>
  files.length ? [] : ["no files were changed"];

const staysInsideTheProposal: Check = ({ files, target }) =>
  files
    .filter((f) => !isAllowed(f.path, target.writable))
    .map((f) => `changed a path outside the proposal: ${f.path}`);

/** The skill folders the draft touched: the target, and any other one in the repo. */
function touchedSkillDirs({ files, target }: Draft): Set<string> {
  const dirs = new Set<string>();
  for (const f of files) {
    if (target.skillDir && f.path.startsWith(`${target.skillDir}/`))
      dirs.add(target.skillDir);
    for (const d of target.readRoot ? AGENT_SKILL_DIRS : []) {
      const m = f.path.startsWith(`${d}/`)
        ? /^[^/]+/.exec(f.path.slice(d.length + 1))
        : null;
      if (m && f.path !== `${d}/${m[0]}`) dirs.add(`${d}/${m[0]}`);
    }
  }
  return dirs;
}

/** Every skill the draft touched must stay a valid skill. */
const skillsStayValid: Check = (d) => {
  const { after, target, cfg } = d;
  const problems: string[] = [];
  for (const skillDir of touchedSkillDirs(d)) {
    const own = skillDir === target.skillDir;
    const at = own ? "" : `${skillDir}: `;
    const md = after.get(`${skillDir}/SKILL.md`);
    if (md === undefined) {
      // Deleting another skill outright is caught by deletesOnlyInItsSkill; a half-deleted one here.
      if (own || [...after.keys()].some((p) => p.startsWith(`${skillDir}/`)))
        problems.push(`${skillDir}/SKILL.md is missing`);
      continue;
    }
    const fm = parseFrontmatter(md);
    const dir = basename(skillDir);
    if (fm.name !== dir)
      problems.push(
        `${at}frontmatter name must be "${dir}" (got ${JSON.stringify(fm.name)})`,
      );
    if (!fm.description)
      problems.push(`${at}frontmatter description is missing`);
    else if (fm.description.length > 1024)
      problems.push(
        `${at}description is ${fm.description.length} chars (max 1024)`,
      );
    const lines = md.split("\n").length;
    if (lines > cfg.render.maxSkillLines)
      problems.push(
        `${at}SKILL.md has ${lines} lines (max ${cfg.render.maxSkillLines}); move detail into references/`,
      );
  }
  return problems;
};

/** Existing files are only deleted inside the skill the proposal is about. */
const deletesOnlyInItsSkill: Check = ({ files, target }) =>
  files
    .filter(
      (f) =>
        f.content === null &&
        !(target.skillDir && f.path.startsWith(`${target.skillDir}/`)),
    )
    .map((f) => `${f.path} must not be deleted`);

/** Blocks another tool generates and owns (<!-- BEGIN x --> … <!-- END x -->) stay as they are. */
const keepsGeneratedBlocks: Check = ({ files, base }) => {
  const problems: string[] = [];
  for (const f of files) {
    const old = base.get(f.path);
    if (old === undefined || f.content === null) continue;
    for (const m of old.matchAll(GENERATED_BLOCK))
      if (!f.content.includes(m[0]))
        problems.push(
          `${f.path}: the generated block "${(m[1] ?? "").trim()}" changed; leave marked blocks alone`,
        );
  }
  return problems;
};

/** A pointer proposal must leave AGENTS.md mentioning the document. */
const pointsToItsDocument: Check = ({ after, target }) =>
  target.pointer &&
  target.doc &&
  target.agentsMd &&
  !(after.get(target.agentsMd) ?? "").includes(target.doc)
    ? [
        `${target.agentsMd} doesn't mention ${target.doc}; the change must point to it`,
      ]
    : [];

/**
 * No secrets and no redaction placeholders in what the draft adds. Not in what the file
 * already had: a document may legitimately show a placeholder or an example key, and that
 * must not block every later change to it.
 */
const addsNoSecrets: Check = ({ files, base }) => {
  const problems: string[] = [];
  for (const f of files) {
    if (f.content === null) continue;
    const had = new Set((base.get(f.path) ?? "").split("\n"));
    const added = f.content
      .split("\n")
      .filter((l) => !had.has(l))
      .join("\n");
    if (containsSecrets(added))
      problems.push(`${f.path} looks like it contains a secret`);
    if (added.includes("[REDACTED"))
      problems.push(`${f.path} contains a [REDACTED] placeholder`);
  }
  return problems;
};

const addsNoPrivateTerms: Check = ({ files, base, target, cfg }) =>
  privateProblems(draftPrivateHits(files, base, target, cfg));

/** Every check, in the order their problems are reported. */
const CHECKS: Check[] = [
  changesSomething,
  staysInsideTheProposal,
  skillsStayValid,
  deletesOnlyInItsSkill,
  keepsGeneratedBlocks,
  pointsToItsDocument,
  addsNoSecrets,
  addsNoPrivateTerms,
];

/** Problems with a draft; empty = OK. `files` are the changes, `base` the originals. */
export function verifyDraft(
  files: DraftFile[],
  base: Map<string, string>,
  target: RenderTarget,
  cfg: Config,
): string[] {
  const after = new Map(base);
  for (const f of files)
    if (f.content === null) after.delete(f.path);
    else after.set(f.path, f.content);
  const draft: Draft = { files, base, after, target, cfg };
  return CHECKS.flatMap((check) => check(draft));
}

/** Private terms the draft would add, when its target is a public repo (see privacy.ts). */
export function draftPrivateHits(
  files: DraftFile[],
  base: Map<string, string>,
  target: RenderTarget,
  cfg: Config,
) {
  return privateHits(files, target.root, cfg, (p) => base.get(p));
}

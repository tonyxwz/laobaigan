import { existsSync, readFileSync, type Stats } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { Type } from "typebox";
import { agentModel, type Config } from "../config.ts";
import { type FileGuard, GUARDED_TOOLS } from "../pi/guard.ts";
import type { PiRunner, Usage } from "../pi/run-pi.ts";
import { addUsage } from "../pi/run-pi.ts";
import { parseFrontmatter } from "../skills/index.ts";
import {
  AGENT_FILES,
  AGENT_RULE_DIRS,
  AGENT_SKILL_DIRS,
  distinctExisting,
  fileNodeKind,
  repoSkillDirs,
} from "../skills/parse.ts";
import { resolveRepo } from "../skills/repo.ts";
import type { NuggetRow } from "../state/db.ts";
import { type DraftFile, hashContent, Proposals } from "../state/proposals.ts";
import {
  type ProposalKind,
  subtreeNuggets,
  type Tree,
  type TreeNode,
} from "../state/tree.ts";
import { truncate } from "../util/text.ts";
import { applyExclusions, type Rehomed } from "./exclude.ts";
import { privateHits, privateProblems, privateRetryPrompt } from "./privacy.ts";
import { containsSecrets } from "./redact.ts";
import { reviewFeedbackPrompt } from "./review.ts";
import { checkScope, scopeProblem, scopeRetryPrompt } from "./scope.ts";
import { evidenceText, skillName } from "./stats.ts";
import { skillStats } from "./treescore.ts";

/**
 * Render a subtree: draft one candidate skill as a proposal, stored in the db.
 * lbg never runs git and never touches the live files while drafting.
 *
 *   resolve target root + writable paths → copy those paths into a scratch dir →
 *   pi (distill model, guarded file tools confined to the scratch dir) → verify →
 *   store the changed files (with hashes of the originals) → proposal `open`.
 *   Failure: proposal `failed`, node stays a candidate. The scratch dir is always removed.
 *
 * Targets (paths relative to the target root). For a repo this is the PRIMARY target: what the
 * proposal is about. The draft may also change the repo's other agent files and documents
 * (repoWritable), and may read anything in the repo:
 *   global                        <skillsDir>  ⟶  <name>/  (SKILL.md + references/)
 *   repo, live AGENTS.md section  <repo>       ⟶  AGENTS.md (that section only; the intro: the text before the first section)
 *   repo, live document           <repo>       ⟶  docs/<x>.md; for a fix-description, a pointer to it in AGENTS.md
 *   repo, live .agents skill      <repo>       ⟶  .agents/skills/<name>/
 *   repo, latent                  <repo>       ⟶  .agents/skills/<name>/ or a new AGENTS.md section
 */

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
  const name =
    skill.name && SKILL_NAME.test(skill.name) && skill.name.length <= 64
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
  const src = skill.sourcePath ?? "";
  const kind = skill.origin === "file" ? fileNodeKind(src) : undefined;
  const repo = async (
    primary: string[],
    rest: Omit<RenderTarget, "root" | "skillName" | "writable" | "primary">,
  ): Promise<RenderTarget> => ({
    root,
    skillName: name,
    writable: await repoWritable(root, cfg.repoDocs, primary),
    primary,
    readRoot: root,
    ...rest,
  });
  const md = /^(.*\/(?:AGENTS|CLAUDE)\.md)#/.exec(src);
  if (md && (kind === "agents-section" || kind === "agents-intro")) {
    const agentsMd = relative(root, md[1]!);
    return repo(
      [agentsMd],
      kind === "agents-intro"
        ? { agentsMd, intro: true }
        : { agentsMd, section: skill.title },
    );
  }
  const agentsMd =
    existsSync(join(root, "AGENTS.md")) || !existsSync(join(root, "CLAUDE.md"))
      ? "AGENTS.md"
      : "CLAUDE.md";
  if (kind === "doc") {
    const doc = relative(root, src);
    // The document already says it and it was explained again: agents didn't read it.
    // What's missing is a pointer in AGENTS.md, not more text in the document.
    return skill.proposalKind === "fix-description"
      ? repo([agentsMd], { agentsMd, doc, pointer: true })
      : repo([doc], { doc });
  }
  if (kind === "skill") {
    // A live skill stays in whichever agent's directory it is in.
    const skillDir = relative(root, dirname(src));
    return repo([`${skillDir}/`], { skillDir });
  }
  // A new skill goes where the repo already keeps skills.
  const home = (await repoSkillDirs(root))[0] ?? AGENT_SKILL_DIRS[0]!;
  const skillDir = `${home}/${name}`;
  return repo([`${skillDir}/`, agentsMd], { skillDir, agentsMd });
}

// ---- scratch copy -------------------------------------------------------------------

/** Never part of a draft: a documentation site's dependencies, a nested repository. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** All files under `rel` (a file or a directory) inside `root`, relative to `root`. */
async function filesUnder(root: string, rel: string): Promise<string[]> {
  const abs = join(root, rel);
  let st: Stats;
  try {
    st = await stat(abs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [rel];
  const out: string[] = [];
  for (const e of await readdir(abs))
    if (!SKIP_DIRS.has(e)) out.push(...(await filesUnder(root, join(rel, e))));
  return out.sort();
}

/** Current content of every text file under the writable paths (binary files are left alone). */
export async function snapshot(
  root: string,
  writable: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const w of writable)
    for (const f of await filesUnder(root, w.replace(/\/$/, ""))) {
      const text = await readFile(join(root, f), "utf8");
      if (!text.includes("\0")) out.set(f, text);
    }
  return out;
}

/** A scratch dir holding a copy of the writable paths (symlinks resolved; dependencies skipped). */
export async function makeScratch(target: RenderTarget): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lbg-draft-"));
  for (const w of target.writable) {
    const rel = w.replace(/\/$/, "");
    const from = join(target.root, rel);
    if (!existsSync(from)) continue;
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await cp(from, join(dir, rel), {
      recursive: true,
      dereference: true,
      filter: (src) => !SKIP_DIRS.has(basename(src)),
    });
  }
  return dir;
}

/** Files that differ between the original snapshot and the scratch dir. */
export async function diffSnapshot(
  base: Map<string, string>,
  scratch: string,
  writable: string[],
): Promise<DraftFile[]> {
  const after = await snapshot(scratch, writable);
  const out: DraftFile[] = [];
  for (const [path, content] of after) {
    const old = base.get(path);
    if (old !== content)
      out.push({
        path,
        baseHash: old === undefined ? null : hashContent(old),
        content,
        baseContent: old ?? null,
      });
  }
  for (const [path, old] of base)
    if (!after.has(path))
      out.push({
        path,
        baseHash: hashContent(old),
        content: null,
        baseContent: old,
      });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---- prompt ---------------------------------------------------------------------

export const DRAFT_SYSTEM_PROMPT = `You write and maintain agent skills from knowledge an engineer taught their AI coding agents (pi, Claude Code, opencode).

A skill is a folder: SKILL.md plus optional references/*.md. Agents always see only the frontmatter name and description; they read SKILL.md when the description matches the task, and a reference file only when SKILL.md tells them to.

SKILL.md format:
---
name: <exactly the folder name>
description: <one or two sentences, max 1024 chars: what it covers AND when to use it, naming the concrete triggers (tools, files, commands, situations)>
---
# <Title>
<the shared workflow and the rules that apply everywhere>
## <Section>  ... or "See references/<x>.md for <when>."

House rules:
- Write for an agent that has never seen these sessions. Exact commands, paths, names, flags and the reason behind each rule. No "as discussed", no anecdotes, no session-specific trivia (today's branch, one-off task details).
- Keep SKILL.md short. Put a subtopic that only matters in some tasks into references/<subtopic>.md and say in SKILL.md when to read it.
- Corrections become rules: "Do X, not Y (because ...)".
- Knowledge items are dated. When two of them conflict, the newer one wins; drop the older claim instead of keeping both.
- Never include secrets, tokens, account credentials, or anything shown as [REDACTED].
- Only write the paths you were given. The working directory holds copies of them; change those, with relative paths.
- For a repository target you may read anything in the repository itself (its absolute path is given; it is read-only): the source, the README, the docs, other skills. Do read what the knowledge is about before writing, check claims against the code, match the project's conventions, and leave out what its files already say.
- For a repository target the task names a primary target, and you may also change the repository's other agent files and documents listed as writable. Put the knowledge in the primary target. Change another file only when a piece of the knowledge clearly belongs there instead, or when it should point to what you wrote; change as little as needed, and say in the summary what you touched and why.
- A repository document (docs/<x>.md) or README is read by people too: keep its structure and voice, and put each piece of knowledge in the section it belongs to.
- Never change text between <!-- BEGIN ... --> and <!-- END ... --> markers: another tool generates it.
- Stay on the skill's topic (its title and, for an existing skill, its current description). Some knowledge items may only be adjacent: they mention a related tool or word but are about something else. Don't write those in; list them in report_draft's \`excluded\` with a one-line reason, and they will be filed in a better skill. Don't widen the description to cover them.
- When done, call report_draft once.`;

function renderNuggets(
  ns: NuggetRow[],
  flags: (n: NuggetRow) => string,
): string[] {
  return ns.map((n) =>
    [
      `- #${n.id} [${n.kind}]${flags(n)} ${n.title}`,
      ...n.knowledge.split("\n").map((l) => `    ${l}`),
      ...n.evidence
        .slice(0, 2)
        .map(
          (e) =>
            `    evidence (${n.agent}${e.ts ? ` ${e.ts.slice(0, 10)}` : ""}): "${truncate(e.quote, 200)}"`,
        ),
    ].join("\n"),
  );
}

export function buildDraftPrompt(
  skill: TreeNode,
  kind: ProposalKind,
  target: RenderTarget,
  siblings: TreeNode[],
  draftedAt?: Date,
  review?: string,
): string {
  const since = skill.renderedAt?.getTime() ?? 0;
  const base = (n: NuggetRow) =>
    kind === "new"
      ? ""
      : n.coveredNodeId !== undefined
        ? " (ALREADY IN THE FILE)"
        : (n.attachedAt?.getTime() ?? Infinity) > since
          ? " (NEW)"
          : " (already absorbed)";
  // Revising: evidence that arrived after the current draft was made isn't in it yet.
  const flag = (n: NuggetRow) =>
    `${base(n)}${draftedAt && (n.attachedAt?.getTime() ?? 0) > draftedAt.getTime() ? " (NEW SINCE THE DRAFT)" : ""}`;
  const lines: string[] = [];

  if (target.pointer && target.doc && target.agentsMd) {
    lines.push(
      `Task: ${target.doc} already states the knowledge below, yet the engineer had to explain it again: agents working in this repository did not read that document. Make ${target.agentsMd} point to it: add (or sharpen) one or two lines saying WHEN to read ${target.doc}, naming the tasks, files and commands involved. Put them where ${target.agentsMd} lists its documentation, or in a new short "##" section if it has no such place. Do not copy the document's content into ${target.agentsMd}.`,
    );
  } else if (target.doc) {
    lines.push(
      `Task: update the document ${target.doc}. Read it first; add the new knowledge to the section it belongs to (a new "##" section only if none fits) and change as little as needed.`,
    );
  } else if (target.agentsMd && target.intro) {
    lines.push(
      `Task: update the text before the first "##" section of ${target.agentsMd}. Keep it short, since every agent in the repository always reads it.`,
    );
  } else if (target.agentsMd && target.section) {
    lines.push(
      `Task: update the "## ${target.section}" section of ${target.agentsMd}.`,
    );
  } else if (kind === "new") {
    lines.push(
      target.agentsMd
        ? `Task: write this repository knowledge. Short rules and facts (a few lines) go into a new "##" section of ${target.agentsMd}; a multi-step procedure becomes the skill ${target.skillDir}/SKILL.md (+ references/). Pick one.`
        : `Task: create the new skill ${target.skillDir}/SKILL.md (name: ${target.skillName}), with references/<subtopic>.md where useful.`,
    );
  } else {
    lines.push(
      `Task: update the existing skill ${target.skillDir}/. Read its files first and keep their structure and voice; change as little as needed.`,
    );
  }
  if (kind === "update")
    lines.push(
      "Integrate the knowledge marked (NEW). Items marked (already absorbed) are background.",
    );
  if (
    draftedAt &&
    subtreeNuggets(skill).some(
      (n) => (n.attachedAt?.getTime() ?? 0) > draftedAt.getTime(),
    )
  ) {
    lines.push(
      "Items marked (NEW SINCE THE DRAFT) came in after the current draft was written: add them unless the engineer says otherwise.",
    );
  }
  const anyCovered = subtreeNuggets(skill).some(
    (n) => n.coveredNodeId !== undefined,
  );
  if (!target.skillDir) {
    // No description to fix: AGENTS.md is always loaded, and a document gets a pointer instead.
    if (anyCovered && !target.pointer)
      lines.push(
        "Items marked (ALREADY IN THE FILE) are stated there already: don't repeat them.",
      );
  } else if (kind === "fix-description" || anyCovered) {
    lines.push(
      "Items marked (ALREADY IN THE FILE) were explained again even though the skill says them: agents did not load the skill. Rewrite the description so it triggers in those situations (name the tools, files and tasks involved).",
    );
  }
  const also = target.writable.filter((w) => !target.primary.includes(w));
  lines.push(
    "",
    ...(target.readRoot
      ? [
          `Repository (read-only, read anything in it): ${target.readRoot}`,
          `Primary target (in the working directory): ${target.primary.join(", ")}`,
          ...(also.length
            ? [
                `You may also change (in the working directory): ${also.join(", ")}`,
              ]
            : []),
        ]
      : [
          `Writable paths (everything else is read-only): ${target.writable.join(", ")}`,
        ]),
    "",
  );

  lines.push(
    "<knowledge>",
    `skill: ${skill.title}${skill.description ? ` — ${skill.description}` : ""}`,
  );
  if (skill.nuggets.length)
    lines.push("general:", ...renderNuggets(skill.nuggets, flag));
  for (const c of skill.children) {
    const ns = subtreeNuggets(c);
    if (!ns.length) continue;
    lines.push(
      `section "${c.title}"${c.description ? ` — ${c.description}` : ""}:`,
      ...renderNuggets(ns, flag),
    );
  }
  lines.push("</knowledge>", "");

  const others = siblings.filter(
    (s) => s.id !== skill.id && s.origin === "file",
  );
  if (others.length) {
    lines.push(
      "<other_skills> (do not duplicate; reference them by name if relevant)",
    );
    for (const s of others)
      lines.push(
        `- ${s.name ?? s.title}: ${truncate(s.description ?? "", 200)}`,
      );
    lines.push("</other_skills>", "");
  }
  if (review) lines.push(review, "");
  lines.push("Write the files now, then call report_draft.");
  return lines.join("\n");
}

export const ReportDraftSchema = Type.Object({
  summary: Type.String({
    description:
      "2-4 sentences for the reviewer: what you wrote or changed and why.",
  }),
  excluded: Type.Optional(
    Type.Array(
      Type.Object({
        nuggetId: Type.Integer({
          description: "The #id of a knowledge item you left out.",
        }),
        reason: Type.String({
          description:
            "One line: why it isn't this skill's topic (and where it belongs, if obvious).",
        }),
      }),
      {
        description:
          "Knowledge items that are off this skill's topic and were NOT written in. Leave empty when everything fits.",
      },
    ),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "The skill's final frontmatter description, if it is a skill.",
    }),
  ),
});

// ---- verification -----------------------------------------------------------------

const GENERATED_BLOCK =
  /<!--\s*(BEGIN\b[^>]*?)-->[\s\S]*?<!--\s*END\b[^>]*?-->/g;

export function isAllowed(path: string, writable: string[]): boolean {
  return writable.some((w) =>
    w.endsWith("/") ? path.startsWith(w) : path === w,
  );
}

/** Problems with a draft; empty = OK. `files` are the changes, `base` the originals. */
export function verifyDraft(
  files: DraftFile[],
  base: Map<string, string>,
  target: RenderTarget,
  cfg: Config,
): string[] {
  const problems: string[] = [];
  if (!files.length) problems.push("no files were changed");
  for (const f of files)
    if (!isAllowed(f.path, target.writable))
      problems.push(`changed a path outside the proposal: ${f.path}`);
  const after = new Map(base);
  for (const f of files)
    f.content === null ? after.delete(f.path) : after.set(f.path, f.content);

  // Every skill the draft touched must stay a valid skill: the target, and any other one.
  const skillDirs = new Set<string>();
  for (const f of files) {
    if (target.skillDir && f.path.startsWith(`${target.skillDir}/`))
      skillDirs.add(target.skillDir);
    for (const d of target.readRoot ? AGENT_SKILL_DIRS : []) {
      const m = f.path.startsWith(`${d}/`)
        ? /^[^/]+/.exec(f.path.slice(d.length + 1))
        : null;
      if (m && f.path !== `${d}/${m[0]}`) skillDirs.add(`${d}/${m[0]}`);
    }
  }
  for (const skillDir of skillDirs) {
    const own = skillDir === target.skillDir;
    const at = own ? "" : `${skillDir}: `;
    const md = after.get(`${skillDir}/SKILL.md`);
    if (md === undefined) {
      // Deleting another skill outright is caught below; a half-deleted one here.
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
  // Existing files are only deleted inside the skill the proposal is about.
  for (const f of files)
    if (
      f.content === null &&
      !(target.skillDir && f.path.startsWith(`${target.skillDir}/`))
    )
      problems.push(`${f.path} must not be deleted`);
  // Blocks another tool generates and owns (<!-- BEGIN x --> … <!-- END x -->) stay as they are.
  for (const f of files) {
    const old = base.get(f.path);
    if (old === undefined || f.content === null) continue;
    for (const m of old.matchAll(GENERATED_BLOCK))
      if (!f.content.includes(m[0]))
        problems.push(
          `${f.path}: the generated block "${m[1]!.trim()}" changed; leave marked blocks alone`,
        );
  }
  if (
    target.pointer &&
    target.doc &&
    target.agentsMd &&
    !(after.get(target.agentsMd) ?? "").includes(target.doc)
  )
    problems.push(
      `${target.agentsMd} doesn't mention ${target.doc}; the change must point to it`,
    );
  // What the draft adds, not what the file already had: a document may legitimately show a
  // placeholder or an example key, and that must not block every later change to it.
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
  problems.push(...privateProblems(draftPrivateHits(files, base, target, cfg)));
  return problems;
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

// ---- driver -----------------------------------------------------------------------------

export type DraftOutcome =
  | {
      status: "open";
      nodeId: number;
      proposalId: number;
      files: DraftFile[];
      usage: Usage;
      excluded: Rehomed[];
    }
  | {
      status: "failed";
      nodeId: number;
      proposalId?: number;
      reason: string;
      usage?: Usage;
    }
  /** The drafter found nothing on-topic to add: everything new was re-filed elsewhere. */
  | {
      status: "nothing";
      nodeId: number;
      proposalId: number;
      usage: Usage;
      excluded: Rehomed[];
    }
  | { status: "skipped"; nodeId: number; reason: string };

/** Draft one candidate skill into an `open` proposal. Never throws for drafting problems. */
export async function draftSkill(
  tree: Tree,
  runner: PiRunner,
  cfg: Config,
  nodeId: number,
  opts: { log?: (m: string) => void } = {},
): Promise<DraftOutcome> {
  const log = opts.log ?? (() => {});
  const props = new Proposals(tree.db);
  const skill = tree.subtree(nodeId);
  if (!skill || skill.depth !== 1)
    return { status: "skipped", nodeId, reason: "not a skill" };
  if (skill.status !== "candidate" || !skill.proposalKind)
    return {
      status: "skipped",
      nodeId,
      reason: `status is ${skill.status}, not a candidate`,
    };
  const kind = skill.proposalKind;

  let target: RenderTarget;
  try {
    target = await resolveTarget(skill, cfg);
  } catch (e) {
    if (e instanceof SkipError)
      return { status: "skipped", nodeId, reason: e.message };
    throw e;
  }
  if (
    kind === "new" &&
    target.skillDir &&
    existsSync(join(target.root, target.skillDir))
  ) {
    return {
      status: "skipped",
      nodeId,
      reason: `${join(target.root, target.skillDir)} already exists; run lbg tree sync so this becomes an update`,
    };
  }

  if (skill.name !== target.skillName && skill.origin !== "file")
    tree.updateNode(nodeId, { name: target.skillName });
  const st = skillStats(skill);
  const proposalId = props.create({
    nodeId,
    kind,
    scope: skill.scope,
    ...(skill.scope === "repo" ? { repo: target.root } : {}),
    skillName: target.skillName,
    targetRoot: target.root,
    writable: target.writable,
    primary: target.primary,
    nuggetIds: subtreeNuggets(skill).map((n) => n.id),
    sessions:
      kind === "new"
        ? st.sessions
        : (st.fresh?.sessions ?? 0) + (st.covered?.sessions ?? 0),
  });
  let usage: Usage | undefined;
  let scratch: string | undefined;
  const fail = (reason: string): DraftOutcome => {
    log(`draft ${target.skillName}: failed: ${reason}`);
    props.markFailed(proposalId, reason, usage);
    return {
      status: "failed",
      nodeId,
      proposalId,
      reason,
      ...(usage ? { usage } : {}),
    };
  };
  try {
    const started = new Date(); // the evidence the draft sees is the subtree as of now
    const base = await snapshot(target.root, target.writable);
    scratch = await makeScratch(target);
    log(`draft ${target.skillName} (${kind}): proposal #${proposalId}`);
    const siblings =
      skill.parentId !== undefined
        ? tree
            .children(skill.parentId)
            .map((c) => ({ ...c, children: [], nuggets: [], forgotten: [] }))
        : [];
    const review = reviewFeedbackPrompt(tree, skill);
    const res = await runner.run({
      ...agentModel(cfg),
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      prompt: buildDraftPrompt(
        skill,
        kind,
        target,
        siblings,
        undefined,
        review,
      ),
      tools: [...GUARDED_TOOLS],
      fileGuard: guardFor(scratch, target),
      resultTool: {
        name: "report_draft",
        description: "Report the finished draft.",
        parameters: ReportDraftSchema,
      },
    });
    usage = res.usage;
    let report = res.value;
    let files = await diffSnapshot(base, scratch, target.writable);
    let problems = verifyDraft(files, base, target, cfg);
    // Two problems get one retry, in the same scratch copy: a live skill's description that took
    // on a new subject, and private terms added to a public repo. Anything else fails right away.
    const live = skill.origin === "file";
    let priv = draftPrivateHits(files, base, target, cfg);
    const onlyPrivate = () =>
      priv.length > 0 && problems.length === privateProblems(priv).length;
    let scope =
      problems.length && !onlyPrivate()
        ? undefined
        : checkScope(files, base, target, kind, live);
    if (scope?.widened || onlyPrivate()) {
      const fixes = [
        ...(scope?.widened ? [scopeRetryPrompt(scope)] : []),
        ...(onlyPrivate() ? [privateRetryPrompt(priv)] : []),
      ];
      log(
        `draft ${target.skillName}: ${[
          ...(scope?.widened
            ? [`description widens the scope (${scope.added.join(", ")})`]
            : []),
          ...(onlyPrivate()
            ? ["adds private terms to a public repository"]
            : []),
        ].join("; ")}; asking the drafter to fix it`,
      );
      const retry = await runner.run({
        ...agentModel(cfg),
        systemPrompt: DRAFT_SYSTEM_PROMPT,
        prompt: `${buildDraftPrompt(skill, kind, target, siblings, undefined, review).replace(/\nWrite the files now, then call report_draft\.$/, "")}\n\nThe files in the current directory are your draft.\n\n${fixes.join("\n\n")}`,
        tools: [...GUARDED_TOOLS],
        fileGuard: guardFor(scratch, target),
        resultTool: {
          name: "report_draft",
          description: "Report the fixed draft.",
          parameters: ReportDraftSchema,
        },
      });
      usage = addUsage(usage, retry.usage);
      report = {
        ...retry.value,
        excluded: [...(report.excluded ?? []), ...(retry.value.excluded ?? [])],
      };
      files = await diffSnapshot(base, scratch, target.writable);
      problems = verifyDraft(files, base, target, cfg);
      priv = draftPrivateHits(files, base, target, cfg);
      scope = problems.length
        ? undefined
        : checkScope(files, base, target, kind, live);
    }
    if (scope?.widened) problems.push(scopeProblem(scope));
    if (
      !files.length &&
      report.excluded?.length &&
      problems.every((p) => p === "no files were changed")
    ) {
      // Not a failure: the new evidence wasn't this skill's topic. Re-file it and close the proposal.
      const ex = await applyExclusions(
        tree,
        runner,
        cfg,
        proposalId,
        skill,
        report.excluded,
        "drafter",
        log,
      );
      if (ex.usage) usage = addUsage(usage, ex.usage);
      props.markFailed(
        proposalId,
        `nothing on-topic to add: ${ex.items.length} off-topic item(s) re-filed elsewhere`,
        usage,
      );
      log(
        `draft ${target.skillName}: nothing on-topic to add; ${ex.items.length} item(s) re-filed`,
      );
      return {
        status: "nothing",
        nodeId,
        proposalId,
        usage,
        excluded: ex.items,
      };
    }
    if (problems.length) return fail(`verification: ${problems.join("; ")}`);
    props.markOpen(proposalId, files, report.summary, usage, {
      draftedAt: started,
      nuggetIds: subtreeNuggets(skill).map((n) => n.id),
    });
    const ex = await applyExclusions(
      tree,
      runner,
      cfg,
      proposalId,
      skill,
      report.excluded ?? [],
      "drafter",
      log,
    );
    if (ex.usage) usage = addUsage(usage, ex.usage);
    log(
      `draft ${target.skillName}: proposal #${proposalId} ready (${files.length} file(s)${ex.items.length ? `, ${ex.items.length} off-topic item(s) re-filed` : ""})`,
    );
    return {
      status: "open",
      nodeId,
      proposalId,
      files,
      usage,
      excluded: ex.items,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

/** Draft candidates (highest score first), up to cfg.render.maxPerRun. */
export async function draftCandidates(
  tree: Tree,
  runner: PiRunner,
  cfg: Config,
  opts: {
    nodeIds?: number[];
    max?: number;
    log?: (m: string) => void;
    now?: Date;
  } = {},
): Promise<DraftOutcome[]> {
  const max = opts.max ?? cfg.render.maxPerRun;
  const props = new Proposals(tree.db);
  for (const id of props.recoverInterrupted())
    opts.log?.(
      `proposal #${id}: drafting was interrupted earlier; marked failed`,
    );
  const cutoff =
    (opts.now ?? new Date()).getTime() - cfg.render.retryAfterHours * 3600e3;
  /** A recent failure: don't spend another drafting session on it yet. */
  const backingOff = (id: number) => {
    const last = props.forNode(id).at(-1);
    return (
      last?.status === "failed" && (last.closedAt?.getTime() ?? 0) > cutoff
    );
  };
  const candidates = opts.nodeIds
    ? opts.nodeIds
    : tree
        .trees()
        .flatMap((r) => r.children)
        .filter((s) => s.status === "candidate" && !backingOff(s.id))
        .sort((a, b) => b.score - a.score || a.id - b.id)
        .map((s) => s.id);
  const out: DraftOutcome[] = [];
  let drafted = 0;
  for (const id of candidates) {
    if (drafted >= max) break;
    const o = await draftSkill(
      tree,
      runner,
      cfg,
      id,
      opts.log ? { log: opts.log } : {},
    );
    out.push(o);
    if (o.status !== "skipped") drafted++;
  }
  return out;
}

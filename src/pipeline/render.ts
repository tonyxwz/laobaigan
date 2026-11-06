import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import { GUARDED_TOOLS } from "../pi/guard.ts";
import type { PiRunner, Usage } from "../pi/run-pi.ts";
import { parseFrontmatter } from "../skills/index.ts";
import { parseAgentsMd } from "../skills/parse.ts";
import { resolveRepo } from "../skills/repo.ts";
import type { NuggetRow } from "../state/db.ts";
import { hashContent, Proposals, type DraftFile } from "../state/proposals.ts";
import { subtreeNuggets, type ProposalKind, type Tree, type TreeNode } from "../state/tree.ts";
import { truncate } from "../util/text.ts";
import { containsSecrets } from "./redact.ts";
import { reviewFeedbackPrompt } from "./review.ts";
import { evidenceText, skillName } from "./stats.ts";
import { skillStats } from "./treescore.ts";
import { applyExclusions, type Rehomed } from "./exclude.ts";
import { checkScope, scopeProblem, scopeRetryPrompt } from "./scope.ts";
import { addUsage } from "../pi/run-pi.ts";

/**
 * Render a subtree: draft one candidate skill as a proposal, stored in the db.
 * lbg never runs git and never touches the live files while drafting.
 *
 *   resolve target root + writable paths → copy those paths into a scratch dir →
 *   pi (distill model, guarded file tools confined to the scratch dir) → verify →
 *   store the changed files (with hashes of the originals) → proposal `open`.
 *   Failure: proposal `failed`, node stays a candidate. The scratch dir is always removed.
 *
 * Targets (paths relative to the target root):
 *   global                        <skillsDir>  ⟶  <name>/  (SKILL.md + references/)
 *   repo, live AGENTS.md section  <repo>       ⟶  AGENTS.md (that section only)
 *   repo, live .agents skill      <repo>       ⟶  .agents/skills/<name>/
 *   repo, latent                  <repo>       ⟶  .agents/skills/<name>/ or a new AGENTS.md section
 */

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface RenderTarget {
  /** Directory the paths are relative to: the global skills dir, or the repo root. */
  root: string;
  skillName: string;
  /** Paths the session may write ("dir/" = subtree). */
  writable: string[];
  /** Skill folder, when the target is a skill. */
  skillDir?: string;
  /** AGENTS.md (or CLAUDE.md), when it may be edited. */
  agentsMd?: string;
  /** For live AGENTS.md sections: the heading being updated. */
  section?: string;
}

export class SkipError extends Error {}

export async function resolveTarget(skill: TreeNode, cfg: Config): Promise<RenderTarget> {
  const name = skill.name && SKILL_NAME.test(skill.name) && skill.name.length <= 64 ? skill.name : skillName(skill.title);
  if (skill.scope === "global") return { root: cfg.skillsDir, skillName: name, writable: [`${name}/`], skillDir: name };
  const members = subtreeNuggets(skill);
  const r = await resolveRepo(skill.repo ?? "", evidenceText({ title: skill.title, summary: skill.summary, members }));
  if (!r.ok) throw new SkipError(`can't tell which repository: ${r.reason}${r.candidates.length ? ` (candidates: ${r.candidates.join(", ")})` : ""}`);
  const root = r.root;
  if (root !== skill.repo) {
    throw new SkipError(`evidence is filed under ${skill.repo}, which maps to ${root}; drafting for workspace roots isn't supported yet`);
  }
  const src = skill.sourcePath ?? "";
  const md = /^(.*\/(?:AGENTS|CLAUDE)\.md)#/.exec(src);
  if (md) return { root, skillName: name, writable: [relative(root, md[1]!)], agentsMd: relative(root, md[1]!), section: skill.title };
  const skillDir = `.agents/skills/${name}`;
  if (src.includes("/.agents/skills/")) return { root, skillName: name, writable: [`${skillDir}/`], skillDir };
  const agentsMd = existsSync(join(root, "AGENTS.md")) || !existsSync(join(root, "CLAUDE.md")) ? "AGENTS.md" : "CLAUDE.md";
  return { root, skillName: name, writable: [`${skillDir}/`, agentsMd], skillDir, agentsMd };
}

// ---- scratch copy -------------------------------------------------------------------

/** All files under `rel` (a file or a directory) inside `root`, relative to `root`. */
async function filesUnder(root: string, rel: string): Promise<string[]> {
  const abs = join(root, rel);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [rel];
  const out: string[] = [];
  for (const e of await readdir(abs)) out.push(...(await filesUnder(root, join(rel, e))));
  return out.sort();
}

/** Current content of every file under the writable paths. */
export async function snapshot(root: string, writable: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const w of writable) for (const f of await filesUnder(root, w.replace(/\/$/, ""))) out.set(f, await readFile(join(root, f), "utf8"));
  return out;
}

/** A scratch dir holding a copy of the writable paths (symlinks resolved). */
export async function makeScratch(target: RenderTarget): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lbg-draft-"));
  for (const w of target.writable) {
    const rel = w.replace(/\/$/, "");
    const from = join(target.root, rel);
    if (!existsSync(from)) continue;
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await cp(from, join(dir, rel), { recursive: true, dereference: true });
  }
  return dir;
}

/** Files that differ between the original snapshot and the scratch dir. */
export async function diffSnapshot(base: Map<string, string>, scratch: string, writable: string[]): Promise<DraftFile[]> {
  const after = await snapshot(scratch, writable);
  const out: DraftFile[] = [];
  for (const [path, content] of after) {
    const old = base.get(path);
    if (old !== content) out.push({ path, baseHash: old === undefined ? null : hashContent(old), content, baseContent: old ?? null });
  }
  for (const [path, old] of base) if (!after.has(path)) out.push({ path, baseHash: hashContent(old), content: null, baseContent: old });
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
- Never include secrets, tokens, account credentials, or anything shown as [REDACTED].
- Only write the paths you were given. You may read anything else in the repository to match its conventions and avoid duplicating other skills.
- Stay on the skill's topic (its title and, for an existing skill, its current description). Some knowledge items may only be adjacent: they mention a related tool or word but are about something else. Don't write those in; list them in report_draft's \`excluded\` with a one-line reason, and they will be filed in a better skill. Don't widen the description to cover them.
- When done, call report_draft once.`;

function renderNuggets(ns: NuggetRow[], flags: (n: NuggetRow) => string): string[] {
  return ns.map((n) =>
    [
      `- #${n.id} [${n.kind}]${flags(n)} ${n.title}`,
      ...n.knowledge.split("\n").map((l) => `    ${l}`),
      ...n.evidence.slice(0, 2).map((e) => `    evidence (${n.agent}${e.ts ? ` ${e.ts.slice(0, 10)}` : ""}): "${truncate(e.quote, 200)}"`),
    ].join("\n"),
  );
}

export function buildDraftPrompt(skill: TreeNode, kind: ProposalKind, target: RenderTarget, siblings: TreeNode[], draftedAt?: Date, review?: string): string {
  const since = skill.renderedAt?.getTime() ?? 0;
  const base = (n: NuggetRow) =>
    kind === "new" ? "" : n.coveredNodeId !== undefined ? " (ALREADY IN THE FILE)" : (n.attachedAt?.getTime() ?? Infinity) > since ? " (NEW)" : " (already absorbed)";
  // Revising: evidence that arrived after the current draft was made isn't in it yet.
  const flag = (n: NuggetRow) => `${base(n)}${draftedAt && (n.attachedAt?.getTime() ?? 0) > draftedAt.getTime() ? " (NEW SINCE THE DRAFT)" : ""}`;
  const lines: string[] = [];

  if (target.agentsMd && target.section) {
    lines.push(`Task: update the "## ${target.section}" section of ${target.agentsMd}. Change only that section.`);
  } else if (kind === "new") {
    lines.push(
      target.agentsMd
        ? `Task: write this repository knowledge. Short rules and facts (a few lines) go into a new "##" section of ${target.agentsMd}; a multi-step procedure becomes the skill ${target.skillDir}/SKILL.md (+ references/). Pick one.`
        : `Task: create the new skill ${target.skillDir}/SKILL.md (name: ${target.skillName}), with references/<subtopic>.md where useful.`,
    );
  } else {
    lines.push(`Task: update the existing skill ${target.skillDir}/. Read its files first and keep their structure and voice; change as little as needed.`);
  }
  if (kind === "update") lines.push("Integrate the knowledge marked (NEW). Items marked (already absorbed) are background.");
  if (draftedAt && subtreeNuggets(skill).some((n) => (n.attachedAt?.getTime() ?? 0) > draftedAt.getTime())) {
    lines.push("Items marked (NEW SINCE THE DRAFT) came in after the current draft was written: add them unless the engineer says otherwise.");
  }
  if (kind === "fix-description" || subtreeNuggets(skill).some((n) => n.coveredNodeId !== undefined)) {
    lines.push(
      "Items marked (ALREADY IN THE FILE) were explained again even though the skill says them: agents did not load the skill. Rewrite the description so it triggers in those situations (name the tools, files and tasks involved).",
    );
  }
  lines.push("", `Writable paths (everything else is read-only): ${target.writable.join(", ")}`, "");

  lines.push("<knowledge>", `skill: ${skill.title}${skill.description ? ` — ${skill.description}` : ""}`);
  if (skill.nuggets.length) lines.push("general:", ...renderNuggets(skill.nuggets, flag));
  for (const c of skill.children) {
    const ns = subtreeNuggets(c);
    if (!ns.length) continue;
    lines.push(`section "${c.title}"${c.description ? ` — ${c.description}` : ""}:`, ...renderNuggets(ns, flag));
  }
  lines.push("</knowledge>", "");

  const others = siblings.filter((s) => s.id !== skill.id && s.origin === "file");
  if (others.length) {
    lines.push("<other_skills> (do not duplicate; reference them by name if relevant)");
    for (const s of others) lines.push(`- ${s.name ?? s.title}: ${truncate(s.description ?? "", 200)}`);
    lines.push("</other_skills>", "");
  }
  if (review) lines.push(review, "");
  lines.push("Write the files now, then call report_draft.");
  return lines.join("\n");
}

export const ReportDraftSchema = Type.Object({
  summary: Type.String({ description: "2-4 sentences for the reviewer: what you wrote or changed and why." }),
  excluded: Type.Optional(
    Type.Array(
      Type.Object({
        nuggetId: Type.Integer({ description: "The #id of a knowledge item you left out." }),
        reason: Type.String({ description: "One line: why it isn't this skill's topic (and where it belongs, if obvious)." }),
      }),
      { description: "Knowledge items that are off this skill's topic and were NOT written in. Leave empty when everything fits." },
    ),
  ),
  description: Type.Optional(Type.String({ description: "The skill's final frontmatter description, if it is a skill." })),
});

// ---- verification -----------------------------------------------------------------

export function isAllowed(path: string, writable: string[]): boolean {
  return writable.some((w) => (w.endsWith("/") ? path.startsWith(w) : path === w));
}

/** Problems with a draft; empty = OK. `files` are the changes, `base` the originals. */
export function verifyDraft(files: DraftFile[], base: Map<string, string>, target: RenderTarget, cfg: Config): string[] {
  const problems: string[] = [];
  if (!files.length) problems.push("no files were changed");
  for (const f of files) if (!isAllowed(f.path, target.writable)) problems.push(`changed a path outside the proposal: ${f.path}`);
  const after = new Map(base);
  for (const f of files) f.content === null ? after.delete(f.path) : after.set(f.path, f.content);

  if (target.skillDir && files.some((f) => f.path.startsWith(`${target.skillDir}/`))) {
    const md = after.get(`${target.skillDir}/SKILL.md`);
    if (md === undefined) problems.push(`${target.skillDir}/SKILL.md is missing`);
    else {
      const fm = parseFrontmatter(md);
      const dir = basename(target.skillDir);
      if (fm.name !== dir) problems.push(`frontmatter name must be "${dir}" (got ${JSON.stringify(fm.name)})`);
      if (!fm.description) problems.push("frontmatter description is missing");
      else if (fm.description.length > 1024) problems.push(`description is ${fm.description.length} chars (max 1024)`);
      const lines = md.split("\n").length;
      if (lines > cfg.render.maxSkillLines) problems.push(`SKILL.md has ${lines} lines (max ${cfg.render.maxSkillLines}); move detail into references/`);
    }
  }
  // AGENTS.md: existing sections other than the target must stay as they are.
  const agents = target.agentsMd ? files.find((f) => f.path === target.agentsMd) : undefined;
  if (agents && target.agentsMd) {
    const oldMd = base.get(target.agentsMd);
    if (agents.content === null) problems.push(`${target.agentsMd} must not be deleted`);
    else if (oldMd !== undefined) {
      const before = parseAgentsMd(target.agentsMd, oldMd);
      const now = parseAgentsMd(target.agentsMd, agents.content);
      if (before.preamble.trim() !== now.preamble.trim()) problems.push(`${target.agentsMd}: the text before the first section changed`);
      const kept = new Set(now.sections.map((x) => x.hash));
      for (const sec of before.sections) {
        if (target.section && sec.title === target.section) continue;
        if (!kept.has(sec.hash)) problems.push(`${target.agentsMd}: section "${sec.title}" changed; only ${target.section ? `"${target.section}"` : "new sections"} may change`);
      }
    }
  }
  for (const f of files) {
    if (f.content === null) continue;
    if (containsSecrets(f.content)) problems.push(`${f.path} looks like it contains a secret`);
    if (f.content.includes("[REDACTED")) problems.push(`${f.path} contains a [REDACTED] placeholder`);
  }
  return problems;
}

// ---- driver -----------------------------------------------------------------------------

export type DraftOutcome =
  | { status: "open"; nodeId: number; proposalId: number; files: DraftFile[]; usage: Usage; excluded: Rehomed[] }
  | { status: "failed"; nodeId: number; proposalId?: number; reason: string; usage?: Usage }
  /** The drafter found nothing on-topic to add: everything new was re-filed elsewhere. */
  | { status: "nothing"; nodeId: number; proposalId: number; usage: Usage; excluded: Rehomed[] }
  | { status: "skipped"; nodeId: number; reason: string };

/** Draft one candidate skill into an `open` proposal. Never throws for drafting problems. */
export async function draftSkill(tree: Tree, runner: PiRunner, cfg: Config, nodeId: number, opts: { log?: (m: string) => void } = {}): Promise<DraftOutcome> {
  const log = opts.log ?? (() => {});
  const props = new Proposals(tree.db);
  const skill = tree.subtree(nodeId);
  if (!skill || skill.depth !== 1) return { status: "skipped", nodeId, reason: "not a skill" };
  if (skill.status !== "candidate" || !skill.proposalKind) return { status: "skipped", nodeId, reason: `status is ${skill.status}, not a candidate` };
  const kind = skill.proposalKind;

  let target: RenderTarget;
  try {
    target = await resolveTarget(skill, cfg);
  } catch (e) {
    if (e instanceof SkipError) return { status: "skipped", nodeId, reason: e.message };
    throw e;
  }
  if (kind === "new" && target.skillDir && existsSync(join(target.root, target.skillDir))) {
    return { status: "skipped", nodeId, reason: `${join(target.root, target.skillDir)} already exists; run lbg tree sync so this becomes an update` };
  }

  if (skill.name !== target.skillName && skill.origin !== "file") tree.updateNode(nodeId, { name: target.skillName });
  const st = skillStats(skill);
  const proposalId = props.create({
    nodeId,
    kind,
    scope: skill.scope,
    ...(skill.scope === "repo" ? { repo: target.root } : {}),
    skillName: target.skillName,
    targetRoot: target.root,
    writable: target.writable,
    nuggetIds: subtreeNuggets(skill).map((n) => n.id),
    sessions: kind === "new" ? st.sessions : (st.fresh?.sessions ?? 0) + (st.covered?.sessions ?? 0),
  });
  let usage: Usage | undefined;
  let scratch: string | undefined;
  const fail = (reason: string): DraftOutcome => {
    log(`draft ${target.skillName}: failed: ${reason}`);
    props.markFailed(proposalId, reason, usage);
    return { status: "failed", nodeId, proposalId, reason, ...(usage ? { usage } : {}) };
  };
  try {
    const started = new Date(); // the evidence the draft sees is the subtree as of now
    const base = await snapshot(target.root, target.writable);
    scratch = await makeScratch(target);
    log(`draft ${target.skillName} (${kind}): proposal #${proposalId}`);
    const siblings = skill.parentId !== undefined ? tree.children(skill.parentId).map((c) => ({ ...c, children: [], nuggets: [] })) : [];
    const review = reviewFeedbackPrompt(tree, skill);
    const res = await runner.run({
      model: cfg.models.distill,
      thinking: cfg.models.distillThinking,
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      prompt: buildDraftPrompt(skill, kind, target, siblings, undefined, review),
      tools: [...GUARDED_TOOLS],
      fileGuard: { root: scratch, writable: target.writable },
      resultTool: { name: "report_draft", description: "Report the finished draft.", parameters: ReportDraftSchema },
    });
    usage = res.usage;
    let report = res.value;
    let files = await diffSnapshot(base, scratch, target.writable);
    let problems = verifyDraft(files, base, target, cfg);
    // A live skill's scope: one retry, in the same scratch copy, if the description took on a new subject.
    const live = skill.origin === "file";
    let scope = problems.length ? undefined : checkScope(files, base, target, kind, live);
    if (scope?.widened) {
      log(`draft ${target.skillName}: description widens the scope (${scope.added.join(", ")}); asking the drafter to fix it`);
      const retry = await runner.run({
        model: cfg.models.distill,
        thinking: cfg.models.distillThinking,
        systemPrompt: DRAFT_SYSTEM_PROMPT,
        prompt: `${buildDraftPrompt(skill, kind, target, siblings, undefined, review).replace(/\nWrite the files now, then call report_draft\.$/, "")}\n\nThe files in the current directory are your draft.\n\n${scopeRetryPrompt(scope)}`,
        tools: [...GUARDED_TOOLS],
        fileGuard: { root: scratch, writable: target.writable },
        resultTool: { name: "report_draft", description: "Report the fixed draft.", parameters: ReportDraftSchema },
      });
      usage = addUsage(usage, retry.usage);
      report = { ...retry.value, excluded: [...(report.excluded ?? []), ...(retry.value.excluded ?? [])] };
      files = await diffSnapshot(base, scratch, target.writable);
      problems = verifyDraft(files, base, target, cfg);
      scope = problems.length ? undefined : checkScope(files, base, target, kind, live);
    }
    if (scope?.widened) problems.push(scopeProblem(scope));
    if (!files.length && report.excluded?.length && problems.every((p) => p === "no files were changed")) {
      // Not a failure: the new evidence wasn't this skill's topic. Re-file it and close the proposal.
      const ex = await applyExclusions(tree, runner, cfg, proposalId, skill, report.excluded, "drafter", log);
      if (ex.usage) usage = addUsage(usage, ex.usage);
      props.markFailed(proposalId, `nothing on-topic to add: ${ex.items.length} off-topic item(s) re-filed elsewhere`, usage);
      log(`draft ${target.skillName}: nothing on-topic to add; ${ex.items.length} item(s) re-filed`);
      return { status: "nothing", nodeId, proposalId, usage, excluded: ex.items };
    }
    if (problems.length) return fail(`verification: ${problems.join("; ")}`);
    props.markOpen(proposalId, files, report.summary, usage, { draftedAt: started, nuggetIds: subtreeNuggets(skill).map((n) => n.id) });
    const ex = await applyExclusions(tree, runner, cfg, proposalId, skill, report.excluded ?? [], "drafter", log);
    if (ex.usage) usage = addUsage(usage, ex.usage);
    log(`draft ${target.skillName}: proposal #${proposalId} ready (${files.length} file(s)${ex.items.length ? `, ${ex.items.length} off-topic item(s) re-filed` : ""})`);
    return { status: "open", nodeId, proposalId, files, usage, excluded: ex.items };
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
  opts: { nodeIds?: number[]; max?: number; log?: (m: string) => void; now?: Date } = {},
): Promise<DraftOutcome[]> {
  const max = opts.max ?? cfg.render.maxPerRun;
  const props = new Proposals(tree.db);
  for (const id of props.recoverInterrupted()) opts.log?.(`proposal #${id}: drafting was interrupted earlier; marked failed`);
  const cutoff = (opts.now ?? new Date()).getTime() - cfg.render.retryAfterHours * 3600e3;
  /** A recent failure: don't spend another drafting session on it yet. */
  const backingOff = (id: number) => {
    const last = props.forNode(id).at(-1);
    return last?.status === "failed" && (last.closedAt?.getTime() ?? 0) > cutoff;
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
    const o = await draftSkill(tree, runner, cfg, id, opts.log ? { log: opts.log } : {});
    out.push(o);
    if (o.status !== "skipped") drafted++;
  }
  return out;
}

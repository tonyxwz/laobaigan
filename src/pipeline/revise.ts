import { mkdir, rm, writeFile } from "node:fs/promises";
import { applyPatch, createPatch } from "diff";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { GUARDED_TOOLS } from "../pi/guard.ts";
import { addUsage, ZERO_USAGE, type PiRunner, type Usage } from "../pi/run-pi.ts";
import { Feedback } from "../state/feedback.ts";
import { reviewFeedbackPrompt } from "./review.ts";
import { hashContent, Proposals, type DraftFile, type ProposalRow } from "../state/proposals.ts";
import { subtreeNuggets, type Tree, type TreeNode } from "../state/tree.ts";
import { applyExclusions, type Rehomed } from "./exclude.ts";
import { checkScope, scopeProblem } from "./scope.ts";
import { buildDraftPrompt, diffSnapshot, DRAFT_SYSTEM_PROMPT, makeScratch, ReportDraftSchema, snapshot, verifyDraft, type RenderTarget } from "./render.ts";

/**
 * Change an open proposal: one-shot `revise "feedback"`, an interactive pi chat, or
 * `edit` in $EDITOR. All three work the same way:
 *
 *   openDraft:  scratch = live target paths + the stored draft on top; base = live files now
 *   …something changes the scratch files…
 *   closeDraft: diff against base, verify, store on the proposal (still `open`)
 *
 * The base is the live files *now*, so revising also rebases a stale draft.
 */

export interface DraftWorkspace {
  proposal: ProposalRow;
  skill: TreeNode;
  target: RenderTarget;
  base: Map<string, string>;
  scratch: string;
  /** When this workspace was opened: the evidence an AI revision sees is the subtree as of now. */
  openedAt: Date;
  /** Ends this process's hold on the proposal. */
  release: () => void;
  /** Files that changed on disk since the draft, and how the draft was carried onto them. */
  rebased: Rebased[];
}

export interface Rebased {
  path: string;
  /**
   * merged:   the draft's own change applied cleanly onto the current file
   * conflict: it didn't apply; the scratch has the current file and the reviser re-applies `draftPatch`
   * legacy:   drafted before lbg kept originals; the scratch has the current file, `draftContent` is the old draft
   */
  how: "merged" | "conflict" | "legacy";
  draftPatch?: string;
  draftContent?: string | null;
}

/** The render target a proposal was drafted for, rebuilt from what it stored. */
export function targetOf(p: ProposalRow, skill: TreeNode): RenderTarget {
  const dir = p.writable.find((w) => w.endsWith("/"));
  const file = p.writable.find((w) => !w.endsWith("/"));
  const liveSection = !!file && !dir && /\/(AGENTS|CLAUDE)\.md#/.test(skill.sourcePath ?? "");
  return {
    root: p.targetRoot,
    skillName: p.skillName ?? skill.name ?? `node-${skill.id}`,
    writable: p.writable,
    ...(dir ? { skillDir: dir.replace(/\/$/, "") } : {}),
    ...(file ? { agentsMd: file } : {}),
    ...(liveSection ? { section: skill.title } : {}),
  };
}

export async function openDraft(tree: Tree, id: number): Promise<DraftWorkspace> {
  const props = new Proposals(tree.db);
  const p = props.assertFree(id);
  if (p.status !== "open") throw new Error(`Proposal #${id} is ${p.status}; only open proposals can be changed`);
  props.claim(id); // a revise chat can take hours: hold the proposal so it isn't accepted/rejected meanwhile
  const skill = tree.subtree(p.nodeId);
  if (!skill) throw new Error(`Proposal #${id}: node ${p.nodeId} no longer exists`);
  const openedAt = new Date();
  const target = targetOf(p, skill);
  const base = await snapshot(target.root, target.writable);
  const scratch = await makeScratch(target);
  const rebased: Rebased[] = [];
  for (const f of p.files) {
    const abs = join(scratch, f.path);
    const now = base.get(f.path) ?? null;
    const stale = (now === null ? null : hashContent(now)) !== f.baseHash;
    let content: string | null = f.content;
    if (stale) {
      // Carry the draft onto the file as it is now, instead of overwriting newer edits.
      if (f.baseContent === undefined) {
        rebased.push({ path: f.path, how: "legacy", draftContent: f.content });
        content = now;
      } else {
        const patch = createPatch(f.path, f.baseContent ?? "", f.content ?? "");
        const merged = f.content === null || now === null ? false : applyPatch(now, patch);
        if (merged !== false) {
          rebased.push({ path: f.path, how: "merged" });
          content = merged;
        } else {
          rebased.push({ path: f.path, how: "conflict", draftPatch: patch });
          content = now;
        }
      }
    }
    if (content === null) await rm(abs, { force: true });
    else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }
  return { proposal: p, skill, target, base, scratch, openedAt, release: () => props.release(id), rebased };
}

export interface CloseResult {
  /** Problems found; when non-empty nothing was stored. */
  problems: string[];
  /** Stored anyway, but worth knowing (e.g. an AI revise widened a live skill's description). */
  warnings: string[];
  /** Files that had changed on disk since the draft, and how the draft was carried onto them. */
  rebased: Rebased[];
  /** The draft differs from what was stored before. */
  changed: boolean;
  files: DraftFile[];
}

const same = (a: DraftFile[], b: DraftFile[]) => JSON.stringify(a) === JSON.stringify(b);

/** Verify the scratch files and, if they're fine and different, store them on the proposal. */
/**
 * `refreshEvidence`: the draft was revised by pi with the current evidence (one-shot or chat),
 * so it now covers everything attached up to `ws.openedAt`. A hand edit doesn't.
 */
export async function closeDraft(
  tree: Tree,
  cfg: Config,
  ws: DraftWorkspace,
  opts: { summary?: string; usage?: Usage; refreshEvidence?: boolean } = {},
): Promise<CloseResult> {
  const files = await diffSnapshot(ws.base, ws.scratch, ws.target.writable);
  const problems = verifyDraft(files, ws.base, ws.target, cfg);
  if (problems.length) return { problems, warnings: [], changed: false, files, rebased: ws.rebased };
  // You steer revisions, so a wider description is your call: a warning, not a block. A hand edit isn't checked.
  const scope = opts.refreshEvidence ? checkScope(files, ws.base, ws.target, ws.proposal.kind, ws.skill.origin === "file") : undefined;
  const warnings = scope?.widened ? [`${scopeProblem(scope)}. Keep it only if you mean to change what this skill is about.`] : [];
  const changed = !same(files, ws.proposal.files);
  if (changed || opts.summary) {
    const prev = (ws.proposal.usage as Usage | undefined) ?? ZERO_USAGE;
    const evidence = opts.refreshEvidence ? { draftedAt: ws.openedAt, nuggetIds: subtreeNuggets(ws.skill).map((n) => n.id) } : undefined;
    new Proposals(tree.db).markOpen(ws.proposal.id, files, opts.summary ?? ws.proposal.summary ?? "", opts.usage ? addUsage(prev, opts.usage) : ws.proposal.usage, evidence);
  }
  return { problems, warnings, changed, files, rebased: ws.rebased };
}

export async function discardDraft(ws: DraftWorkspace): Promise<void> {
  ws.release();
  await rm(ws.scratch, { recursive: true, force: true });
}

/** Context for anyone (pi, or the interactive chat) revising the draft. */
export function reviseContext(tree: Tree, ws: DraftWorkspace): string {
  const siblings = ws.skill.parentId !== undefined ? tree.children(ws.skill.parentId).map((c) => ({ ...c, children: [], nuggets: [], forgotten: [] })) : [];
  return [
    buildDraftPrompt(ws.skill, ws.proposal.kind, ws.target, siblings, ws.proposal.draftedAt, reviewFeedbackPrompt(tree, ws.skill)).replace(/\nWrite the files now, then call report_draft\.$/, ""),
    "",
    "A draft already exists: the files in the current directory ARE the current draft. Revise them; don't start over unless asked.",
    ...(ws.proposal.summary ? [`The drafter's note on it: ${ws.proposal.summary}`] : []),
    ...droppedNote(tree, ws),
    ...rebaseNote(ws),
  ].join("\n");
}

export interface ReviseResult extends CloseResult {
  usage: Usage;
  summary: string;
  /** Evidence the reviser left out as off-topic, re-filed elsewhere. */
  excluded: Rehomed[];
}

/** One-shot revise: pi redrafts the stored draft with my feedback. Nothing is stored if verification fails. */
export async function reviseProposal(tree: Tree, runner: PiRunner, cfg: Config, id: number, feedback: string): Promise<ReviseResult> {
  const ws = await openDraft(tree, id);
  const prompt = `${reviseContext(tree, ws)}\n\nFeedback from the engineer (apply it):\n${feedback}\n\nRevise the files now, then call report_draft.`;
  // What I asked for is review feedback for this skill, whatever the redraft's outcome.
  new Feedback(tree.db).add({ proposalId: id, kind: "revise", text: feedback });
  try {
    const res = await runner.run({
      model: cfg.models.distill,
      thinking: cfg.models.distillThinking,
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      prompt,
      tools: [...GUARDED_TOOLS],
      fileGuard: { root: ws.scratch, writable: ws.target.writable },
      resultTool: { name: "report_draft", description: "Report the revised draft.", parameters: ReportDraftSchema },
    });
    const closed = await closeDraft(tree, cfg, ws, { summary: res.value.summary, usage: res.usage, refreshEvidence: true });
    let usage = res.usage;
    let excluded: Rehomed[] = [];
    if (!closed.problems.length && res.value.excluded?.length) {
      const ex = await applyExclusions(tree, runner, cfg, ws.proposal.id, ws.skill, res.value.excluded, "drafter");
      excluded = ex.items;
      if (ex.usage) usage = addUsage(usage, ex.usage);
    }
    return { ...closed, usage, summary: res.value.summary, excluded };
  } finally {
    await discardDraft(ws);
  }
}

/** Evidence I dropped since this draft was written: the files may still say it. */
function droppedNote(tree: Tree, ws: DraftWorkspace): string[] {
  const dropped = new Proposals(tree.db).droppedSinceDraft(ws.proposal);
  if (!dropped.length) return [];
  return [
    "",
    "The engineer removed these knowledge items from this skill after the draft was written (off-topic). Take out any content, including in the description, that came only from them:",
    ...dropped.map((e) => `- #${e.nuggetId} ${tree.db.getNugget(e.nuggetId)?.title ?? ""} (${e.reason})`),
  ];
}

/** Files that changed on disk since the draft and couldn't be merged automatically. */
function rebaseNote(ws: DraftWorkspace): string[] {
  const out: string[] = [];
  for (const r of ws.rebased) {
    if (r.how === "merged") continue;
    out.push(
      "",
      `${r.path} changed on disk since the draft (the engineer edited it). The file in the current directory is the CURRENT version: keep those edits. Re-apply the draft's changes onto it:`,
    );
    if (r.how === "conflict") out.push("```diff", r.draftPatch!.trimEnd(), "```");
    else out.push(r.draftContent === null ? "(the draft deleted this file)" : `The earlier draft of the whole file was:\n\`\`\`\n${(r.draftContent ?? "").trimEnd()}\n\`\`\``);
  }
  return out;
}

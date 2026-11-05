import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { GUARDED_TOOLS } from "../pi/guard.ts";
import { addUsage, ZERO_USAGE, type PiRunner, type Usage } from "../pi/run-pi.ts";
import { Proposals, type DraftFile, type ProposalRow } from "../state/proposals.ts";
import { subtreeNuggets, type Tree, type TreeNode } from "../state/tree.ts";
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
  for (const f of p.files) {
    const abs = join(scratch, f.path);
    if (f.content === null) await rm(abs, { force: true });
    else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content);
    }
  }
  return { proposal: p, skill, target, base, scratch, openedAt, release: () => props.release(id) };
}

export interface CloseResult {
  /** Problems found; when non-empty nothing was stored. */
  problems: string[];
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
  if (problems.length) return { problems, changed: false, files };
  const changed = !same(files, ws.proposal.files);
  if (changed || opts.summary) {
    const prev = (ws.proposal.usage as Usage | undefined) ?? ZERO_USAGE;
    const evidence = opts.refreshEvidence ? { draftedAt: ws.openedAt, nuggetIds: subtreeNuggets(ws.skill).map((n) => n.id) } : undefined;
    new Proposals(tree.db).markOpen(ws.proposal.id, files, opts.summary ?? ws.proposal.summary ?? "", opts.usage ? addUsage(prev, opts.usage) : ws.proposal.usage, evidence);
  }
  return { problems, changed, files };
}

export async function discardDraft(ws: DraftWorkspace): Promise<void> {
  ws.release();
  await rm(ws.scratch, { recursive: true, force: true });
}

/** Context for anyone (pi, or the interactive chat) revising the draft. */
export function reviseContext(tree: Tree, ws: DraftWorkspace): string {
  const siblings = ws.skill.parentId !== undefined ? tree.children(ws.skill.parentId).map((c) => ({ ...c, children: [], nuggets: [] })) : [];
  return [
    buildDraftPrompt(ws.skill, ws.proposal.kind, ws.target, siblings, ws.proposal.draftedAt).replace(/\nWrite the files now, then call report_draft\.$/, ""),
    "",
    "A draft already exists: the files in the current directory ARE the current draft. Revise them; don't start over unless asked.",
    ...(ws.proposal.summary ? [`The drafter's note on it: ${ws.proposal.summary}`] : []),
  ].join("\n");
}

export interface ReviseResult extends CloseResult {
  usage: Usage;
  summary: string;
}

/** One-shot revise: pi redrafts the stored draft with my feedback. Nothing is stored if verification fails. */
export async function reviseProposal(tree: Tree, runner: PiRunner, cfg: Config, id: number, feedback: string): Promise<ReviseResult> {
  const ws = await openDraft(tree, id);
  try {
    const res = await runner.run({
      model: cfg.models.distill,
      thinking: cfg.models.distillThinking,
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      prompt: `${reviseContext(tree, ws)}\n\nFeedback from the engineer (apply it):\n${feedback}\n\nRevise the files now, then call report_draft.`,
      tools: [...GUARDED_TOOLS],
      fileGuard: { root: ws.scratch, writable: ws.target.writable },
      resultTool: { name: "report_draft", description: "Report the revised draft.", parameters: ReportDraftSchema },
    });
    const closed = await closeDraft(tree, cfg, ws, { summary: res.value.summary, usage: res.usage, refreshEvidence: true });
    return { ...closed, usage: res.usage, summary: res.value.summary };
  } finally {
    await discardDraft(ws);
  }
}

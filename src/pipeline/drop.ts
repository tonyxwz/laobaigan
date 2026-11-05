import type { Config } from "../config.ts";
import type { PiRunner, Usage } from "../pi/run-pi.ts";
import { addUsage, ZERO_USAGE } from "../pi/run-pi.ts";
import { Proposals } from "../state/proposals.ts";
import { subtreeNuggets, type Tree } from "../state/tree.ts";
import { applyExclusions, type Rehomed } from "./exclude.ts";
import { reviseProposal, type ReviseResult } from "./revise.ts";

/**
 * Drop evidence from an open proposal during review. Unlike automatic curation this is allowed
 * while the skill is `proposed`: it's my deliberate call. Dropped nuggets are taken off the skill
 * and never routed back to it. They're re-filed by insert, or sent to `to` (and locked there).
 * The draft's files may still hold their content: `revise` takes it out (with `revise: true`,
 * right away).
 */

export interface DropResult {
  dropped: Rehomed[];
  usage: Usage;
  revised?: ReviseResult;
}

export async function dropEvidence(
  tree: Tree,
  runner: PiRunner,
  cfg: Config,
  proposalId: number,
  nuggetIds: number[],
  opts: { reason?: string; to?: number; revise?: boolean; log?: (m: string) => void } = {},
): Promise<DropResult> {
  const props = new Proposals(tree.db);
  const p = props.assertFree(proposalId);
  if (p.status !== "open") throw new Error(`Proposal #${proposalId} is ${p.status}; only open proposals can be changed`);
  const skill = tree.subtree(p.nodeId);
  if (!skill) throw new Error(`Proposal #${proposalId}: its skill #${p.nodeId} no longer exists`);
  const inSkill = new Set(subtreeNuggets(skill).map((n) => n.id));
  const unknown = nuggetIds.filter((id) => !inSkill.has(id));
  if (unknown.length) {
    throw new Error(`Not evidence of proposal #${proposalId} (${skill.name ?? skill.title}): ${unknown.map((x) => `#${x}`).join(", ")}. See: lbg proposal show ${proposalId}`);
  }
  if (opts.to !== undefined) {
    const dest = tree.getNode(opts.to);
    if (!dest) throw new Error(`No node ${opts.to}`);
    if (tree.path(opts.to).some((n) => n.id === p.nodeId)) throw new Error(`#${opts.to} is part of the skill you're dropping from`);
    if (dest.depth === 0) throw new Error(`#${opts.to} is a root; pick a skill or section`);
  }
  const reason = opts.reason?.trim() || "dropped in review";
  const items = nuggetIds.map((nuggetId) => ({ nuggetId, reason }));

  let usage = ZERO_USAGE;
  let dropped: Rehomed[];
  if (opts.to !== undefined) {
    // Record and detach without re-filing (no routing call), then place where I said, locked.
    await applyExclusions(tree, runner, cfg, proposalId, skill, items, "reviewer", opts.log, { refile: false });
    for (const id of nuggetIds) tree.attachNugget(id, opts.to, { lock: true });
    const path = tree.path(opts.to).slice(1).map((x) => x.name ?? x.title).join(" › ");
    dropped = nuggetIds.map((id) => ({ nuggetId: id, title: tree.db.getNugget(id)!.title, reason, now: { nodeId: opts.to!, path } }));
  } else {
    const ex = await applyExclusions(tree, runner, cfg, proposalId, skill, items, "reviewer", opts.log);
    dropped = ex.items;
    if (ex.usage) usage = addUsage(usage, ex.usage);
  }

  let revised: ReviseResult | undefined;
  if (opts.revise) {
    // The revise context lists every item dropped since the draft (this one and earlier ones).
    revised = await reviseProposal(tree, runner, cfg, proposalId, "Take out the content of the removed knowledge items listed above. Keep everything else.");
    usage = addUsage(usage, revised.usage);
  }
  return { dropped, usage, ...(revised ? { revised } : {}) };
}

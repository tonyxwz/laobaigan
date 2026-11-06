import type { ScoreConfig } from "../config.ts";
import type { NuggetRow } from "../state/db.ts";
import { Rejections, type MemoryRow } from "../state/rejections.ts";
import { subtreeNuggets, type ProposalKind, type Tree, type TreeNode } from "../state/tree.ts";
import { evidenceStats, meetsPromotion, scoreOf, type EvidenceStats } from "./stats.ts";

/**
 * Recursive scoring over the knowledge tree. Recurrence is counted over a
 * skill's whole subtree, and the kind of proposal depends on where it sits:
 *
 *   latent / declared skill  → "new"              all evidence counts
 *   live (file) skill        → "update"           only evidence attached since its last render
 *                            → "fix-description"  evidence the file already states ("covered"):
 *                                                 I still had to explain it, so it didn't trigger
 */

export interface SkillStats extends EvidenceStats {
  /** Live skills: evidence attached after the last render that isn't already covered. */
  fresh?: { nuggets: number; sessions: number; agents: string[] };
  /** Live skills: evidence (since the last render) that the file already states. */
  covered?: { nuggets: number; sessions: number };
}

function sessionsOf(ns: NuggetRow[]): number {
  return new Set(ns.map((n) => `${n.agent}:${n.sessionId}`)).size;
}

/** Stats over a skill's subtree (members = every nugget below it). */
export function skillStats(skill: TreeNode): SkillStats {
  const members = subtreeNuggets(skill);
  const base = evidenceStats({ members });
  if (skill.origin !== "file") return base;
  const since = skill.renderedAt?.getTime() ?? 0;
  // Both kinds only count since the last render: an accepted proposal absorbs them.
  const sinceRender = members.filter((n) => (n.attachedAt?.getTime() ?? Infinity) > since);
  const covered = sinceRender.filter((n) => n.coveredNodeId !== undefined);
  const fresh = sinceRender.filter((n) => n.coveredNodeId === undefined);
  return {
    ...base,
    fresh: { nuggets: fresh.length, sessions: sessionsOf(fresh), agents: [...new Set(fresh.map((n) => n.agent))].sort() },
    covered: { nuggets: covered.length, sessions: sessionsOf(covered) },
  };
}

/** Which proposal (if any) a skill has earned, ignoring its current status. */
export function earnedProposal(skill: TreeNode, stats: SkillStats, cfg: ScoreConfig): ProposalKind | undefined {
  if (stats.nuggets === 0) return undefined;
  if (skill.origin !== "file") return meetsPromotion(stats, cfg.promote) ? "new" : undefined;
  const p = cfg.promote;
  const fresh = stats.fresh!;
  if (fresh.sessions >= p.updateMinSessions || (fresh.sessions >= 2 && fresh.agents.length >= 2)) return "update";
  if (stats.covered!.sessions >= p.fixDescriptionMinSessions) return "fix-description";
  return undefined;
}

export interface TreeScoreResult {
  scored: number;
  promoted: { id: number; title: string; kind: ProposalKind; score: number }[];
  /** Candidates that no longer qualify (e.g. their evidence moved, or a merge absorbed it). */
  demoted: { id: number; title: string }[];
  /** Nuggets moved from wrong-place rejected skills to their targets. */
  moved: number;
}

/**
 * Score every skill (depth 1) of every tree. Status rules:
 *  - open → candidate when a proposal is earned; candidate → open when it no longer is
 *  - rejected → candidate again only after `reproposeAfterSessions` new sessions
 *  - proposed is left alone (the proposal lifecycle owns it)
 */
/**
 * What a rejected skill's memory (newest one in effect) means for scoring:
 *   not-useful   never proposed again while the memory is in effect
 *   outdated     only evidence attached after the rejection counts (the old one is forgotten)
 *   wrong-place  its evidence moves to the target skill (and won't be routed back)
 *   later        re-proposed after `reproposeAfterSessions` new sessions (the default rule)
 * No memory in effect (none, forgotten, expired): the default rule.
 */
export function rejectedRule(skill: TreeNode, memory: MemoryRow | undefined): "never" | "after-rejection" | "default" {
  if (skill.status !== "rejected" || !memory) return "default";
  if (memory.kind === "not-useful") return "never";
  if (memory.kind === "outdated") return "after-rejection";
  return "default";
}

/** Move the evidence of wrong-place rejected skills to their targets. Returns nuggets moved. */
export function applyWrongPlace(tree: Tree): number {
  const mem = new Rejections(tree.db);
  let moved = 0;
  for (const [nodeId, m] of mem.byNode()) {
    if (m.kind !== "wrong-place" || m.targetNodeId === undefined) continue;
    const skill = tree.subtree(nodeId);
    const target = tree.getNode(m.targetNodeId);
    if (!skill || skill.status !== "rejected" || !target || target.depth !== 1) continue;
    const ns = subtreeNuggets(skill).filter((n) => !n.assignmentLocked);
    if (!ns.length) continue;
    for (const n of ns) {
      tree.excludeNugget(n.id, skill.id); // never routed back
      tree.attachNugget(n.id, target.id);
    }
    mem.addCaught(m.id, ns.length);
    moved += ns.length;
  }
  return moved;
}

/** A copy of the skill keeping only nuggets attached after `at` (for outdated rejections). */
function attachedAfter(skill: TreeNode, at: number): TreeNode {
  const keep = (n: TreeNode): TreeNode => ({
    ...n,
    nuggets: n.nuggets.filter((g) => (g.attachedAt?.getTime() ?? 0) > at),
    children: n.children.map(keep),
  });
  return keep(skill);
}

export function scoreTree(tree: Tree, cfg: ScoreConfig): TreeScoreResult {
  const res: TreeScoreResult = { scored: 0, promoted: [], demoted: [], moved: 0 };
  tree.db.tx(() => {
    res.moved = applyWrongPlace(tree);
    const memories = new Rejections(tree.db).byNode();
    for (const root of tree.trees()) {
      for (const skill of root.children) {
        const rule = rejectedRule(skill, memories.get(skill.id));
        const counted = rule === "after-rejection" ? attachedAfter(skill, memories.get(skill.id)!.createdAt.getTime()) : skill;
        const stats = skillStats(counted);
        const score = scoreOf(stats, cfg.weights);
        res.scored++;
        let kind = rule === "never" ? undefined : earnedProposal(counted, stats, cfg);
        if (rule === "default" && skill.status === "rejected" && stats.sessions < (skill.rejectedSessions ?? 0) + cfg.promote.reproposeAfterSessions) kind = undefined;

        if (skill.status === "proposed") {
          tree.updateNode(skill.id, { stats, score });
        } else if (kind) {
          tree.updateNode(skill.id, { stats, score, status: "candidate", proposalKind: kind });
          if (skill.status !== "candidate" || skill.proposalKind !== kind) res.promoted.push({ id: skill.id, title: skill.name ?? skill.title, kind, score });
        } else {
          tree.db.db.prepare("UPDATE node SET proposal_kind = NULL WHERE id = ?").run(skill.id);
          tree.updateNode(skill.id, { stats, score, ...(skill.status === "candidate" ? { status: "open" as const } : {}) });
          if (skill.status === "candidate") res.demoted.push({ id: skill.id, title: skill.name ?? skill.title });
        }
      }
    }
  });
  return res;
}

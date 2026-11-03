import type { ScoreConfig } from "../config.ts";
import type { NuggetRow } from "../state/db.ts";
import { subtreeNuggets, type ProposalKind, type Tree, type TreeNode } from "../state/tree.ts";
import { meetsPromotion, scoreOf, topicStats, type TopicStats } from "./score.ts";

/**
 * Recursive scoring over the knowledge tree. Recurrence is counted over a
 * skill's whole subtree, and the kind of proposal depends on where it sits:
 *
 *   latent / declared skill  → "new"              all evidence counts
 *   live (file) skill        → "update"           only evidence attached since its last render
 *                            → "fix-description"  evidence the file already states ("covered"):
 *                                                 I still had to explain it, so it didn't trigger
 */

export interface SkillStats extends TopicStats {
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
  const base = topicStats({
    title: skill.title,
    summary: skill.summary,
    scope: skill.scope,
    ...(skill.repo ? { repo: skill.repo } : {}),
    members,
  });
  if (skill.origin !== "file") return base;
  const since = skill.renderedAt?.getTime() ?? 0;
  // Both kinds only count since the last render: a merged proposal absorbs them.
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
}

/**
 * Score every skill (depth 1) of every tree. Status rules:
 *  - open → candidate when a proposal is earned; candidate → open when it no longer is
 *  - rejected → candidate again only after `reproposeAfterSessions` new sessions
 *  - proposed / merged are left alone (the proposal lifecycle owns them)
 */
export function scoreTree(tree: Tree, cfg: ScoreConfig): TreeScoreResult {
  const res: TreeScoreResult = { scored: 0, promoted: [], demoted: [] };
  tree.db.tx(() => {
    for (const root of tree.trees()) {
      for (const skill of root.children) {
        const stats = skillStats(skill);
        const score = scoreOf(stats, cfg.weights);
        res.scored++;
        let kind = earnedProposal(skill, stats, cfg);
        if (skill.status === "rejected" && stats.sessions < (skill.rejectedSessions ?? 0) + cfg.promote.reproposeAfterSessions) kind = undefined;

        if (skill.status === "proposed" || skill.status === "merged") {
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

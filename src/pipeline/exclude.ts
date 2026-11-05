import type { Config } from "../config.ts";
import type { PiRunner, Usage } from "../pi/run-pi.ts";
import { Proposals, type Exclusion } from "../state/proposals.ts";
import { subtreeNuggets, type Tree, type TreeNode } from "../state/tree.ts";
import { insertNuggets } from "./insert.ts";

/**
 * Off-topic evidence. When a drafter (or I, in review) leaves a nugget out of a skill, it's
 * taken off that skill, remembered as "not this skill", and re-inserted so it lands in a
 * better skill or starts a new latent one. It never counts toward the skill it was left out of.
 */

export interface Rehomed {
  nuggetId: number;
  title: string;
  reason: string;
  /** Where it was re-filed (node path), or undefined if it's still waiting for the next run. */
  now?: { nodeId: number; path: string };
}

export interface ExclusionResult {
  items: Rehomed[];
  /** Routing calls made to re-file them. */
  usage?: Usage;
}

export async function applyExclusions(
  tree: Tree,
  runner: PiRunner,
  cfg: Config,
  proposalId: number,
  skill: TreeNode,
  raw: { nuggetId: number; reason: string }[],
  by: Exclusion["by"],
  log: (m: string) => void = () => {},
  opts: { refile?: boolean } = {},
): Promise<ExclusionResult> {
  const inSkill = new Map(subtreeNuggets(skill).map((n) => [n.id, n]));
  const seen = new Set<number>();
  const valid = raw.filter((e) => {
    if (!inSkill.has(e.nuggetId)) {
      log(`  ignored exclusion of #${e.nuggetId}: not evidence of this skill`);
      return false;
    }
    if (seen.has(e.nuggetId)) return false;
    seen.add(e.nuggetId);
    return true;
  });
  if (!valid.length) return { items: [] };

  tree.db.tx(() => {
    const at = Date.now();
    new Proposals(tree.db).addExcluded(proposalId, valid.map((e) => ({ nuggetId: e.nuggetId, reason: e.reason.trim(), by, at })));
    for (const e of valid) tree.excludeNugget(e.nuggetId, skill.id);
    tree.pruneEmpty();
  });

  let usage: Usage | undefined;
  if (opts.refile === false) return { items: valid.map((e) => ({ nuggetId: e.nuggetId, title: inSkill.get(e.nuggetId)!.title, reason: e.reason.trim() })) };
  try {
    const nuggets = valid.map((e) => tree.db.getNugget(e.nuggetId)!);
    const r = await insertNuggets(tree, runner, cfg, { nuggets, log });
    usage = r.usage;
  } catch (e) {
    // They stay unplaced (still marked "not this skill"); the next run's insert files them.
    log(`  re-filing off-topic evidence failed: ${e instanceof Error ? e.message : String(e)}; the next run retries`);
  }
  const items = valid.map((e): Rehomed => {
    const n = tree.db.getNugget(e.nuggetId)!;
    const path = n.nodeId !== undefined ? tree.path(n.nodeId).slice(1).map((x) => x.name ?? x.title).join(" › ") : undefined;
    return { nuggetId: n.id, title: n.title, reason: e.reason.trim(), ...(n.nodeId !== undefined ? { now: { nodeId: n.nodeId, path: path! } } : {}) };
  });
  for (const i of items) log(`  off-topic #${i.nuggetId} ${i.title} → ${i.now ? i.now.path : "unplaced (next run files it)"}`);
  return { items, ...(usage ? { usage } : {}) };
}

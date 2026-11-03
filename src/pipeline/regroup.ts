import { Type, type Static } from "typebox";
import type { Config } from "../config.ts";
import type { PiRunner, Usage } from "../pi/run-pi.ts";
import { addUsage, ZERO_USAGE } from "../pi/run-pi.ts";
import type { ClusterWithMembers, StateDb, TopicWithClusters } from "../state/db.ts";
import { truncate } from "../util/text.ts";
import { partitionKey } from "./cluster.ts";
import { syncDeclaredTopics } from "./topics.ts";

export const RegroupSchema = Type.Object({
  newTopics: Type.Array(
    Type.Object({
      key: Type.String({ description: "Short local id you invent, e.g. 't1'." }),
      title: Type.String({ description: "Umbrella topic title, e.g. 'Dotfiles management'." }),
      name: Type.Optional(Type.String({ description: "Skill name: lowercase letters, digits, hyphens." })),
    }),
  ),
  placements: Type.Array(
    Type.Object({
      clusterId: Type.Integer(),
      topicId: Type.Optional(Type.Integer({ description: "An EXISTING topic id to move the cluster under." })),
      newTopicKey: Type.Optional(Type.String({ description: "A key from newTopics." })),
    }),
    { description: "Only clusters that should MOVE. Clusters not listed stay where they are." },
  ),
});
export type RegroupResult = Static<typeof RegroupSchema>;

const REGROUP_SYSTEM_PROMPT = `You reorganize how knowledge an engineer taught their AI coding agents is grouped into skills.

Structure:
- A TOPIC becomes ONE skill (or one section of a repository's AGENTS.md), with one description that says when to use it.
- A topic contains CLUSTERS (subtopics). Each becomes a section of the skill or a reference file (references/<subtopic>.md) loaded only when needed.

The engineer wants FEW skills. Because subtopics carry the details, an umbrella topic (e.g. "Dotfiles management" covering zsh, tmux, and agent configs) is better than many tiny skills, as long as its subtopics share a purpose, a place, or a workflow.

Task: decide which movable clusters should move under another topic, or be gathered under a new umbrella topic.
- Topics marked declared="yes" were defined by the engineer; their description says what they cover. Move clusters there whenever they fall within it.
- Move a cluster only when its knowledge is ABOUT the topic's subject, not when it merely mentions something the topic covers (e.g. the content of some skill is not "agent configuration" just because skills are stored in a config directory).
- Gather clusters into a new topic only when it is coherent enough for one description. Do not create a topic with a single cluster.
- Leave a cluster where it is when no better home exists. Only list clusters that move.
- Only clusters marked movable="yes" may move. Topics marked home="no" cannot receive clusters.
Report ONLY by calling \`regroup\` once.`;

export function regroupSystemPrompt(guidance?: string): string {
  return guidance?.trim() ? `${REGROUP_SYSTEM_PROMPT}\n\nGuidance from the engineer (follow it):\n${guidance.trim()}` : REGROUP_SYSTEM_PROMPT;
}

/** Clusters automation may move: unlocked, in an unlocked topic that has no proposal yet. */
export function isMovable(t: TopicWithClusters, c: ClusterWithMembers): boolean {
  return !c.locked && !t.locked && !t.targetLocked && (t.status === "open" || t.status === "candidate");
}

/** Topics that may receive clusters: anything not yet proposed/merged/rejected. */
export function isHome(t: TopicWithClusters): boolean {
  return t.status === "open" || t.status === "candidate";
}

export function buildRegroupPrompt(partition: string, topics: TopicWithClusters[]): string {
  const lines = [
    `Partition: ${partition === "global" ? "global knowledge (applies across repositories)" : `repository ${partition.slice(5)}`}`,
    "",
    "<topics>",
  ];
  for (const t of topics) {
    lines.push(
      `<topic id="${t.id}"${t.name ? ` name="${t.name}"` : ""} declared="${t.declared ? "yes" : "no"}" home="${isHome(t) ? "yes" : "no"}">`,
      `title: ${t.title}`,
    );
    if (t.description) lines.push(`description: ${t.description}`);
    if (!t.clusters.length) lines.push("  (no clusters yet)");
    for (const c of t.clusters) {
      lines.push(
        `  <cluster id="${c.id}" movable="${isMovable(t, c) ? "yes" : "no"}" nuggets="${c.members.length}">`,
        `  title: ${c.title}`,
        truncate(c.summary, 600),
        "  </cluster>",
      );
    }
    lines.push("</topic>");
  }
  lines.push("</topics>", "", "Call regroup now.");
  return lines.join("\n");
}

export interface RegroupPlan {
  partition: string;
  newTopics: { key: string; title: string; name?: string; clusterIds: number[] }[];
  moves: { clusterId: number; topicId: number }[];
  repairs: string[];
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateRegroup(partition: string, res: RegroupResult, topics: TopicWithClusters[]): RegroupPlan {
  const repairs: string[] = [];
  const topicOf = new Map<number, TopicWithClusters>();
  const movable = new Set<number>();
  for (const t of topics) {
    for (const c of t.clusters) {
      topicOf.set(c.id, t);
      if (isMovable(t, c)) movable.add(c.id);
    }
  }
  const homes = new Set(topics.filter(isHome).map((t) => t.id));
  const newByKey = new Map<string, RegroupPlan["newTopics"][number]>();
  for (const n of res.newTopics) {
    if (newByKey.has(n.key)) {
      repairs.push(`duplicate new topic key ${n.key}`);
      continue;
    }
    const name = n.name && SKILL_NAME.test(n.name) && n.name.length <= 64 ? n.name : undefined;
    if (n.name && !name) repairs.push(`new topic ${n.key}: invalid skill name ${n.name}; dropped`);
    newByKey.set(n.key, { key: n.key, title: n.title, ...(name ? { name } : {}), clusterIds: [] });
  }

  const placed = new Set<number>();
  const moves: RegroupPlan["moves"] = [];
  for (const p of res.placements) {
    if (!movable.has(p.clusterId)) {
      repairs.push(`cluster ${p.clusterId} is not movable; ignored`);
      continue;
    }
    if (placed.has(p.clusterId)) {
      repairs.push(`cluster ${p.clusterId} placed twice; kept first`);
      continue;
    }
    if (p.topicId !== undefined) {
      if (!homes.has(p.topicId)) repairs.push(`cluster ${p.clusterId}: topic ${p.topicId} can't receive clusters; ignored`);
      else if (topicOf.get(p.clusterId)!.id !== p.topicId) {
        moves.push({ clusterId: p.clusterId, topicId: p.topicId });
        placed.add(p.clusterId);
      }
    } else if (p.newTopicKey !== undefined && newByKey.has(p.newTopicKey)) {
      newByKey.get(p.newTopicKey)!.clusterIds.push(p.clusterId);
      placed.add(p.clusterId);
    } else {
      repairs.push(`cluster ${p.clusterId}: no valid target; ignored`);
    }
  }
  const newTopics = [...newByKey.values()].filter((n) => {
    if (n.clusterIds.length >= 2) return true;
    if (n.clusterIds.length === 1) {
      repairs.push(`new topic ${n.key} would hold one cluster; not created`);
      placed.delete(n.clusterIds[0]!);
    }
    return false;
  });
  return { partition, newTopics, moves, repairs };
}

export function applyRegroup(db: StateDb, plan: RegroupPlan, scope: { scope: "global" | "repo"; repo?: string }): void {
  db.tx(() => {
    for (const n of plan.newTopics) {
      const id = db.createTopic({ ...scope, title: n.title, ...(n.name ? { name: n.name } : {}) });
      for (const c of n.clusterIds) db.setClusterTopic(c, id);
    }
    for (const m of plan.moves) db.setClusterTopic(m.clusterId, m.topicId);
    db.deleteEmptyTopics();
  });
}

export interface RegroupRunResult {
  plans: RegroupPlan[];
  moved: number;
  topicsCreated: number;
  usage: Usage;
  calls: number;
}

/**
 * Re-place movable clusters under topics (declared, existing, or new umbrella
 * topics), one model call per partition that has something to decide.
 */
export async function regroup(
  db: StateDb,
  runner: PiRunner,
  cfg: Config,
  opts: { log?: (m: string) => void } = {},
): Promise<RegroupRunResult> {
  const log = opts.log ?? (() => {});
  syncDeclaredTopics(db, cfg.topics);
  const out: RegroupRunResult = { plans: [], moved: 0, topicsCreated: 0, usage: ZERO_USAGE, calls: 0 };

  const byPartition = new Map<string, TopicWithClusters[]>();
  for (const t of db.topics()) byPartition.set(partitionKey(t), [...(byPartition.get(partitionKey(t)) ?? []), t]);

  for (const [partition, topics] of byPartition) {
    const movable = topics.flatMap((t) => t.clusters.filter((c) => isMovable(t, c)));
    const homes = topics.filter(isHome);
    // Nothing to decide: no movable clusters, or nowhere else to put them.
    if (movable.length === 0 || (homes.length <= 1 && movable.length < 2)) continue;
    log(`regroup ${partition}: ${movable.length} movable cluster(s), ${homes.length} topic(s)`);
    const res = await runner.run({
      model: cfg.models.extract,
      thinking: cfg.models.extractThinking,
      systemPrompt: regroupSystemPrompt(cfg.clustering.guidance),
      prompt: buildRegroupPrompt(partition, topics),
      resultTool: { name: "regroup", description: "Move clusters under better topics.", parameters: RegroupSchema },
    });
    out.calls++;
    out.usage = addUsage(out.usage, res.usage);
    const plan = validateRegroup(partition, res.value, topics);
    for (const r of plan.repairs) log(`  repair: ${r}`);
    applyRegroup(db, plan, { scope: topics[0]!.scope, ...(topics[0]!.repo ? { repo: topics[0]!.repo } : {}) });
    out.plans.push(plan);
    out.moved += plan.moves.length + plan.newTopics.reduce((a, n) => a + n.clusterIds.length, 0);
    out.topicsCreated += plan.newTopics.length;
  }
  return out;
}

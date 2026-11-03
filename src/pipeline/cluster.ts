import { Type, type Static } from "typebox";
import type { Config } from "../config.ts";
import type { PiRunner, Usage } from "../pi/run-pi.ts";
import { addUsage, ZERO_USAGE } from "../pi/run-pi.ts";
import type { ClusterWithMembers, NuggetRow, StateDb } from "../state/db.ts";
import { truncate } from "../util/text.ts";

export const AssignSchema = Type.Object({
  newClusters: Type.Array(
    Type.Object({
      key: Type.String({ description: "Short local id you invent, e.g. 'n1'. Referenced by assignments." }),
      title: Type.String({ description: "Topic title, e.g. 'Building Gradle packages'." }),
      summary: Type.String({ description: "The merged knowledge of all members, self-contained markdown." }),
    }),
  ),
  assignments: Type.Array(
    Type.Object({
      nuggetId: Type.Integer(),
      clusterId: Type.Optional(Type.Integer({ description: "An EXISTING cluster id." })),
      newClusterKey: Type.Optional(Type.String({ description: "A key from newClusters." })),
    }),
    { description: "Exactly one entry per new nugget, with exactly one of clusterId / newClusterKey." },
  ),
  updatedClusters: Type.Array(
    Type.Object({
      clusterId: Type.Integer(),
      title: Type.Optional(Type.String()),
      summary: Type.String({ description: "Updated merged knowledge including the newly assigned nuggets." }),
    }),
    { description: "Existing clusters that received members and whose summary should change." },
  ),
});
export type AssignResult = Static<typeof AssignSchema>;

export const CLUSTER_SYSTEM_PROMPT = `You organize "knowledge nuggets" that a software engineer taught their AI coding agents into topic clusters.

Each cluster will later become ONE skill (or one section of a repository's AGENTS.md). The engineer wants FEW skills, each about one coherent topic, but not so broad that the topic is vague.

Rules:
- Put a new nugget in an existing cluster when the same skill/section should hold it: same tool, system, workflow, or convention. Example: "use make release" and "use git worktree, not git worktree" both belong to a "Build and worktree workflow" topic.
- Start a new cluster only when no existing cluster is a natural home. A new cluster may hold several of the new nuggets.
- Do NOT merge unrelated topics just to reduce the count (e.g. "tmux config" and "ssh-agent flags" stay separate).
- A cluster summary is the merged, de-duplicated knowledge of all its members: exact commands, paths, rules, and reasons. Keep conflicting statements and note the conflict; never invent facts.
- Assign every new nugget exactly once. Report results ONLY by calling \`assign_clusters\` once.`;

/** Nuggets and clusters only meet within the same partition (scope + repo). */
export function partitionKey(x: { scope: "global" | "repo"; repo?: string | undefined }): string {
  return x.scope === "global" ? "global" : `repo:${x.repo ?? "?"}`;
}

export interface ClusterPlan {
  partition: string;
  newClusters: { key: string; title: string; summary: string; nuggetIds: number[] }[];
  assignments: { nuggetId: number; clusterId: number }[];
  updatedClusters: { clusterId: number; title?: string; summary: string }[];
  /** Problems fixed up during validation (missing/duplicate assignments, bad ids). */
  repairs: string[];
}

export interface ClusterOutput {
  plans: ClusterPlan[];
  usage: Usage;
  calls: number;
}

function renderNugget(n: NuggetRow): string {
  return [
    `<nugget id="${n.id}" kind="${n.kind}" from="${n.agent}:${n.sessionId.slice(0, 8)}">`,
    `title: ${n.title}`,
    `triggers: ${n.triggers.join("; ")}`,
    truncate(n.knowledge, 1500),
    "</nugget>",
  ].join("\n");
}

function renderCluster(c: ClusterWithMembers): string {
  return [
    `<cluster id="${c.id}" members="${c.members.length}">`,
    `title: ${c.title}`,
    truncate(c.summary, 1500),
    "</cluster>",
  ].join("\n");
}

export function buildClusterPrompt(partition: string, clusters: ClusterWithMembers[], nuggets: NuggetRow[]): string {
  return [
    `Partition: ${partition === "global" ? "global knowledge (applies across repositories)" : `repository ${partition.slice(5)}`}`,
    "",
    "<existing_clusters>",
    clusters.length ? clusters.map(renderCluster).join("\n") : "(none)",
    "</existing_clusters>",
    "",
    "<new_nuggets>",
    nuggets.map(renderNugget).join("\n"),
    "</new_nuggets>",
    "",
    "Call assign_clusters now.",
  ].join("\n");
}

/**
 * Turn a model result into a valid plan: every nugget assigned exactly once,
 * only to clusters of this partition. Anything unassigned gets its own cluster.
 */
export function validatePlan(
  partition: string,
  res: AssignResult,
  nuggets: NuggetRow[],
  clusters: ClusterWithMembers[],
): ClusterPlan {
  const repairs: string[] = [];
  const nuggetIds = new Set(nuggets.map((n) => n.id));
  const clusterIds = new Set(clusters.map((c) => c.id));
  const newByKey = new Map<string, ClusterPlan["newClusters"][number]>();
  for (const c of res.newClusters) {
    if (newByKey.has(c.key)) repairs.push(`duplicate new cluster key ${c.key}`);
    else newByKey.set(c.key, { ...c, nuggetIds: [] });
  }

  const assigned = new Set<number>();
  const assignments: ClusterPlan["assignments"] = [];
  for (const a of res.assignments) {
    if (!nuggetIds.has(a.nuggetId)) {
      repairs.push(`unknown nugget ${a.nuggetId}`);
      continue;
    }
    if (assigned.has(a.nuggetId)) {
      repairs.push(`nugget ${a.nuggetId} assigned twice; kept first`);
      continue;
    }
    if (a.clusterId !== undefined && clusterIds.has(a.clusterId)) {
      assignments.push({ nuggetId: a.nuggetId, clusterId: a.clusterId });
      assigned.add(a.nuggetId);
    } else if (a.newClusterKey !== undefined && newByKey.has(a.newClusterKey)) {
      newByKey.get(a.newClusterKey)!.nuggetIds.push(a.nuggetId);
      assigned.add(a.nuggetId);
    } else {
      repairs.push(`nugget ${a.nuggetId}: invalid target ${a.clusterId ?? a.newClusterKey}`);
    }
  }

  // Unassigned → singleton cluster built from the nugget itself.
  for (const n of nuggets) {
    if (assigned.has(n.id)) continue;
    repairs.push(`nugget ${n.id} unassigned; new cluster`);
    const key = `auto-${n.id}`;
    newByKey.set(key, { key, title: n.title, summary: n.knowledge, nuggetIds: [n.id] });
  }

  const touched = new Set(assignments.map((a) => a.clusterId));
  const updatedClusters = res.updatedClusters.filter((u) => {
    const ok = touched.has(u.clusterId);
    if (!ok) repairs.push(`ignored summary update for untouched cluster ${u.clusterId}`);
    return ok;
  });

  return {
    partition,
    newClusters: [...newByKey.values()].filter((c) => c.nuggetIds.length > 0),
    assignments,
    updatedClusters,
    repairs,
  };
}

/** Persist one validated plan. Every nugget in it must belong to `plan.partition`. */
export function applyPlan(db: StateDb, plan: ClusterPlan, scope: { scope: "global" | "repo"; repo?: string }): number[] {
  const created: number[] = [];
  db.tx(() => {
    for (const c of plan.newClusters) {
      const id = db.createCluster({ title: c.title, summary: c.summary, ...scope });
      created.push(id);
      for (const nid of c.nuggetIds) db.assignNugget(nid, id);
    }
    for (const a of plan.assignments) db.assignNugget(a.nuggetId, a.clusterId);
    for (const u of plan.updatedClusters) db.updateCluster(u.clusterId, { summary: u.summary, ...(u.title ? { title: u.title } : {}) });
  });
  return created;
}

export interface ClusterRunResult {
  plans: ClusterPlan[];
  created: number;
  assigned: number;
  usage: Usage;
  calls: number;
}

/**
 * Assign every unclustered nugget to a cluster, partition by partition, applying
 * each batch before the next so later batches see the clusters it created.
 * A partition with a single nugget and no clusters needs no model call.
 * Re-running with no unclustered nuggets makes no calls and changes nothing.
 */
export async function clusterNuggets(
  db: StateDb,
  runner: PiRunner,
  cfg: Config,
  opts: { batchSize?: number; maxCalls?: number; log?: (m: string) => void } = {},
): Promise<ClusterRunResult> {
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? 30;
  const maxCalls = opts.maxCalls ?? Infinity;

  const byPartition = new Map<string, NuggetRow[]>();
  for (const n of db.unclusteredNuggets()) {
    const k = partitionKey(n);
    byPartition.set(k, [...(byPartition.get(k) ?? []), n]);
  }

  const out: ClusterRunResult = { plans: [], created: 0, assigned: 0, usage: ZERO_USAGE, calls: 0 };
  for (const [partition, nuggets] of byPartition) {
    const scope = { scope: nuggets[0]!.scope, ...(nuggets[0]!.repo ? { repo: nuggets[0]!.repo } : {}) };
    for (let i = 0; i < nuggets.length; i += batchSize) {
      const batch = nuggets.slice(i, i + batchSize);
      const clusters = db.clusters().filter((c) => partitionKey(c) === partition);
      let plan: ClusterPlan;
      if (batch.length === 1 && clusters.length === 0) {
        const n = batch[0]!;
        plan = { partition, newClusters: [{ key: "solo", title: n.title, summary: n.knowledge, nuggetIds: [n.id] }], assignments: [], updatedClusters: [], repairs: [] };
      } else {
        if (out.calls >= maxCalls) {
          log(`cluster: call budget (${maxCalls}) reached; rest waits for next run`);
          return out;
        }
        log(`cluster ${partition}: ${batch.length} nugget(s) vs ${clusters.length} cluster(s)`);
        const res = await runner.run({
          model: cfg.models.extract,
          thinking: cfg.models.extractThinking,
          systemPrompt: CLUSTER_SYSTEM_PROMPT,
          prompt: buildClusterPrompt(partition, clusters, batch),
          resultTool: {
            name: "assign_clusters",
            description: "Assign every new nugget to an existing or new cluster, and update summaries.",
            parameters: AssignSchema,
          },
        });
        out.calls++;
        out.usage = addUsage(out.usage, res.usage);
        plan = validatePlan(partition, res.value, batch, clusters);
      }
      const created = applyPlan(db, plan, scope);
      out.plans.push(plan);
      out.created += created.length;
      out.assigned += batch.length;
      for (const r of plan.repairs) log(`  repair: ${r}`);
    }
  }
  return out;
}

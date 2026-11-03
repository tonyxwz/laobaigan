import type { StateDb, TopicWithClusters } from "../state/db.ts";

/**
 * Hand curation. Every operation locks what it touches, so regroup and the
 * consolidation pass never undo it: my edits win over automation.
 *
 *   topic   = future skill        → merge, split, rename
 *   cluster = subtopic            → move (to a topic), merge, rename
 *   nugget                        → move (to a cluster)
 */

/** Topics that already have a proposal or were merged can't be dissolved. */
function assertMovable(t: TopicWithClusters, what: string): void {
  if (t.status === "proposed" || t.status === "merged") {
    throw new Error(`${what}: topic #${t.id} is ${t.status}; finish or reject its proposal first`);
  }
}

function topic(db: StateDb, id: number): TopicWithClusters {
  const t = db.getTopic(id);
  if (!t) throw new Error(`No topic ${id}`);
  return t;
}

/** Move all clusters of `from` topics under `into`; empty non-declared topics are deleted. */
export function mergeTopics(db: StateDb, into: number, from: number[]): { moved: number[]; deleted: number } {
  const target = topic(db, into);
  if (from.includes(into)) throw new Error("Can't merge a topic into itself");
  const sources = from.map((id) => topic(db, id));
  for (const s of sources) assertMovable(s, "merge");
  const moved: number[] = [];
  let deleted = 0;
  db.tx(() => {
    for (const s of sources) {
      for (const c of s.clusters) {
        db.setClusterTopic(c.id, target.id); // throws on scope/repo mismatch → whole merge rolls back
        db.updateCluster(c.id, { locked: true });
        moved.push(c.id);
      }
    }
    db.updateTopic(target.id, { locked: true });
    deleted = db.deleteEmptyTopics();
  });
  return { moved, deleted };
}

/** Move some clusters of a topic into a new topic. Both topics end up locked. */
export function splitTopic(db: StateDb, topicId: number, clusterIds: number[], title?: string): number {
  const t = topic(db, topicId);
  assertMovable(t, "split");
  const picked = t.clusters.filter((c) => clusterIds.includes(c.id));
  const missing = clusterIds.filter((id) => !picked.some((c) => c.id === id));
  if (missing.length) throw new Error(`Cluster(s) ${missing.join(", ")} are not in topic #${topicId}`);
  if (picked.length === t.clusters.length) throw new Error("A split must leave at least one cluster behind");
  let created = 0;
  db.tx(() => {
    created = db.createTopic({ title: title ?? picked[0]!.title, scope: t.scope, ...(t.repo ? { repo: t.repo } : {}), locked: true });
    for (const c of picked) {
      db.setClusterTopic(c.id, created);
      db.updateCluster(c.id, { locked: true });
    }
    db.updateTopic(t.id, { locked: true });
  });
  return created;
}

/** Rename a topic and/or set its skill name. */
export function renameTopic(db: StateDb, id: number, patch: { title?: string; name?: string }): void {
  topic(db, id);
  if (patch.name !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(patch.name)) {
    throw new Error(`Skill name must be lowercase letters, digits and single hyphens: ${patch.name}`);
  }
  db.updateTopic(id, { ...patch, locked: true });
}

/** Put a cluster under another (or a brand-new) topic. */
export function moveCluster(db: StateDb, clusterId: number, topicId: number): void {
  const c = db.getCluster(clusterId);
  if (!c) throw new Error(`No cluster ${clusterId}`);
  assertMovable(topic(db, c.topicId), "move");
  topic(db, topicId);
  db.tx(() => {
    db.setClusterTopic(clusterId, topicId);
    db.updateCluster(clusterId, { locked: true });
    db.deleteEmptyTopics();
  });
}

/** Fold clusters into one. The summaries are concatenated as sections; re-summarizing is left to consolidation. */
export function mergeClusters(db: StateDb, into: number, from: number[]): void {
  const target = db.getCluster(into);
  if (!target) throw new Error(`No cluster ${into}`);
  if (from.includes(into)) throw new Error("Can't merge a cluster into itself");
  const sources = from.map((id) => {
    const c = db.getCluster(id);
    if (!c) throw new Error(`No cluster ${id}`);
    return c;
  });
  for (const s of sources) assertMovable(topic(db, s.topicId), "merge");
  db.tx(() => {
    const parts = [target.summary];
    for (const s of sources) {
      for (const m of s.members) db.assignNugget(m.id, target.id, { lock: true }); // throws on scope mismatch
      parts.push(`### ${s.title}\n${s.summary}`);
      db.deleteCluster(s.id);
    }
    db.updateCluster(target.id, { summary: parts.join("\n\n"), locked: true });
    db.deleteEmptyTopics();
  });
}

export function renameCluster(db: StateDb, id: number, title: string): void {
  if (!db.getCluster(id)) throw new Error(`No cluster ${id}`);
  db.updateCluster(id, { title, locked: true });
}

/** Move one nugget to another cluster. A cluster left empty is deleted (and then its topic, if empty). */
export function moveNugget(db: StateDb, nuggetId: number, clusterId: number): void {
  const n = db.getNugget(nuggetId);
  if (!n) throw new Error(`No nugget ${nuggetId}`);
  if (!db.getCluster(clusterId)) throw new Error(`No cluster ${clusterId}`);
  db.tx(() => {
    db.assignNugget(nuggetId, clusterId, { lock: true });
    const old = n.clusterId !== undefined ? db.getCluster(n.clusterId) : undefined;
    if (old && old.id !== clusterId && old.members.length === 0) db.deleteCluster(old.id);
    db.deleteEmptyTopics();
  });
}

/** Clear hand-curation locks on a topic (and its clusters/nuggets), letting automation reorganize it again. */
export function unlockTopic(db: StateDb, id: number): void {
  const t = topic(db, id);
  db.tx(() => {
    db.updateTopic(id, { locked: false, targetLocked: false });
    for (const c of t.clusters) {
      db.updateCluster(c.id, { locked: false });
      for (const m of c.members) db.assignNugget(m.id, c.id, { lock: false });
    }
  });
}

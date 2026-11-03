import type { NuggetRow, StateDb, TopicStatus } from "./db.ts";

/**
 * The knowledge tree: one per scope (global, or one repo).
 *
 *   depth 0  root     the always-loaded skill list / the repo's AGENTS.md
 *   depth 1  skill    name + description (always loaded); repo: AGENTS.md section or .agents/skills/<name>
 *   depth 2  section  a SKILL.md section or references/<x>.md (loaded on demand)
 *   nuggets attach to depth 1 or 2.
 */
export type Depth = 0 | 1 | 2;
export const MAX_DEPTH = 2;

export type Origin = "root" | "file" | "declared" | "latent";
export type NodeStatus = TopicStatus;

export interface NodeRow {
  id: number;
  parentId?: number;
  scope: "global" | "repo";
  repo?: string;
  depth: Depth;
  name?: string;
  title: string;
  description?: string;
  summary: string;
  /** Summary is stale (children/nuggets changed); rewritten lazily before rendering. */
  summaryDirty: boolean;
  origin: Origin;
  status: NodeStatus;
  score: number;
  stats?: unknown;
  rejectedSessions?: number;
  locked: boolean;
  sourcePath?: string;
  sourceHash?: string;
  renderedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TreeNode extends NodeRow {
  children: TreeNode[];
  /** Nuggets attached directly to this node. */
  nuggets: NuggetRow[];
}

export type Scope = { scope: "global" | "repo"; repo?: string };

export function kindOf(depth: Depth): "root" | "skill" | "section" {
  return depth === 0 ? "root" : depth === 1 ? "skill" : "section";
}

type Row = Record<string, unknown>;

function toNode(r: Row): NodeRow {
  return {
    id: Number(r.id),
    ...(r.parent_id != null ? { parentId: Number(r.parent_id) } : {}),
    scope: r.scope as "global" | "repo",
    ...(r.repo ? { repo: String(r.repo) } : {}),
    depth: Number(r.depth) as Depth,
    ...(r.name ? { name: String(r.name) } : {}),
    title: String(r.title),
    ...(r.description ? { description: String(r.description) } : {}),
    summary: String(r.summary ?? ""),
    summaryDirty: Number(r.summary_dirty) === 1,
    origin: r.origin as Origin,
    status: r.status as NodeStatus,
    score: Number(r.score),
    ...(r.stats ? { stats: JSON.parse(String(r.stats)) as unknown } : {}),
    ...(r.rejected_sessions != null ? { rejectedSessions: Number(r.rejected_sessions) } : {}),
    locked: Number(r.locked) === 1,
    ...(r.source_path ? { sourcePath: String(r.source_path) } : {}),
    ...(r.source_hash ? { sourceHash: String(r.source_hash) } : {}),
    ...(r.rendered_at != null ? { renderedAt: new Date(Number(r.rendered_at)) } : {}),
    createdAt: new Date(Number(r.created_at)),
    updatedAt: new Date(Number(r.updated_at)),
  };
}

function sameScope(a: { scope: string; repo?: string | undefined }, b: { scope: string; repo?: string | undefined }): boolean {
  return a.scope === b.scope && (a.scope !== "repo" || (a.repo ?? null) === (b.repo ?? null));
}

function label(x: { scope: string; repo?: string | undefined }): string {
  return x.scope === "global" ? "global" : `repo:${x.repo ?? "?"}`;
}

/** Tree operations over the state db. */
export class Tree {
  readonly db: StateDb;
  constructor(db: StateDb) {
    this.db = db;
  }

  private get sql() {
    return this.db.db;
  }

  getNode(id: number): NodeRow | undefined {
    const r = this.sql.prepare("SELECT * FROM node WHERE id = ?").get(id) as Row | undefined;
    return r ? toNode(r) : undefined;
  }

  private mustGet(id: number): NodeRow {
    const n = this.getNode(id);
    if (!n) throw new Error(`No node ${id}`);
    return n;
  }

  /** The root of a scope, created on first use. */
  ensureRoot(scope: Scope): number {
    const repo = scope.scope === "repo" ? (scope.repo ?? null) : null;
    if (scope.scope === "repo" && !repo) throw new Error("A repo scope needs a repo path");
    const r = this.sql.prepare("SELECT id FROM node WHERE depth = 0 AND scope = ? AND repo IS ?").get(scope.scope, repo) as
      | { id: number }
      | undefined;
    if (r) return Number(r.id);
    const now = Date.now();
    return Number(
      this.sql
        .prepare("INSERT INTO node (scope, repo, depth, title, origin, created_at, updated_at) VALUES (?, ?, 0, ?, 'root', ?, ?)")
        .run(scope.scope, repo, scope.scope === "global" ? "Global skills" : repo, now, now).lastInsertRowid,
    );
  }

  /** Create a child node; depth and scope come from the parent. */
  createNode(
    parentId: number,
    n: { title: string; name?: string; description?: string; summary?: string; origin?: Exclude<Origin, "root">; locked?: boolean; sourcePath?: string; sourceHash?: string },
  ): number {
    const parent = this.mustGet(parentId);
    if (parent.depth >= MAX_DEPTH) throw new Error(`Node ${parentId} is a section; sections can't have children`);
    const now = Date.now();
    const id = Number(
      this.sql
        .prepare(
          `INSERT INTO node (parent_id, scope, repo, depth, name, title, description, summary, origin, locked,
                             source_path, source_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parentId,
          parent.scope,
          parent.repo ?? null,
          parent.depth + 1,
          n.name ?? null,
          n.title,
          n.description ?? null,
          n.summary ?? "",
          n.origin ?? "latent",
          n.locked ? 1 : 0,
          n.sourcePath ?? null,
          n.sourceHash ?? null,
          now,
          now,
        ).lastInsertRowid,
    );
    this.markDirty(parentId);
    return id;
  }

  updateNode(
    id: number,
    patch: Partial<
      Pick<
        NodeRow,
        | "name"
        | "title"
        | "description"
        | "summary"
        | "summaryDirty"
        | "origin"
        | "status"
        | "score"
        | "stats"
        | "rejectedSessions"
        | "locked"
        | "sourcePath"
        | "sourceHash"
        | "renderedAt"
      >
    >,
  ): void {
    const cols: Record<string, string> = {
      name: "name",
      title: "title",
      description: "description",
      summary: "summary",
      summaryDirty: "summary_dirty",
      origin: "origin",
      status: "status",
      score: "score",
      stats: "stats",
      rejectedSessions: "rejected_sessions",
      locked: "locked",
      sourcePath: "source_path",
      sourceHash: "source_hash",
      renderedAt: "rendered_at",
    };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(
        k === "stats" ? JSON.stringify(v) : v instanceof Date ? v.getTime() : typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null),
      );
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    vals.push(Date.now(), id);
    if (Number(this.sql.prepare(`UPDATE node SET ${sets.join(", ")} WHERE id = ?`).run(...vals).changes) === 0) throw new Error(`No node ${id}`);
  }

  /** Mark a node and its ancestors as having stale summaries (lazy: rewritten before rendering). */
  markDirty(id: number): void {
    this.sql
      .prepare(
        `WITH RECURSIVE up(id, parent_id) AS (SELECT id, parent_id FROM node WHERE id = ?
           UNION ALL SELECT n.id, n.parent_id FROM node n JOIN up ON n.id = up.parent_id)
         UPDATE node SET summary_dirty = 1 WHERE id IN (SELECT id FROM up) AND depth > 0`,
      )
      .run(id);
  }

  children(id: number): NodeRow[] {
    return (this.sql.prepare("SELECT * FROM node WHERE parent_id = ? ORDER BY id").all(id) as Row[]).map(toNode);
  }

  /** Root → … → node. */
  path(id: number): NodeRow[] {
    const out: NodeRow[] = [];
    for (let n = this.getNode(id); n; n = n.parentId !== undefined ? this.getNode(n.parentId) : undefined) out.unshift(n);
    return out;
  }

  /** Attach a nugget to a skill or section of the same scope. */
  attachNugget(nuggetId: number, nodeId: number, opts: { lock?: boolean } = {}): void {
    const node = this.mustGet(nodeId);
    if (node.depth === 0) throw new Error("Nuggets attach to skills or sections, not to a root");
    const n = this.sql.prepare("SELECT scope, repo, node_id FROM nugget WHERE id = ?").get(nuggetId) as Row | undefined;
    if (!n) throw new Error(`No nugget ${nuggetId}`);
    const ns = { scope: String(n.scope), ...(n.repo ? { repo: String(n.repo) } : {}) };
    if (!sameScope(ns, node)) throw new Error(`Scope mismatch: nugget ${nuggetId} (${label(ns)}) vs node ${nodeId} (${label(node)})`);
    this.sql.prepare("UPDATE nugget SET node_id = ? WHERE id = ?").run(nodeId, nuggetId);
    if (opts.lock !== undefined) this.sql.prepare("UPDATE nugget SET assignment_locked = ? WHERE id = ?").run(opts.lock ? 1 : 0, nuggetId);
    if (n.node_id != null) this.markDirty(Number(n.node_id));
    this.markDirty(nodeId);
  }

  /** Take a nugget out of the tree (e.g. to re-insert it). */
  detachNugget(nuggetId: number): void {
    const n = this.db.getNugget(nuggetId);
    if (!n) throw new Error(`No nugget ${nuggetId}`);
    this.sql.prepare("UPDATE nugget SET node_id = NULL, covered_node_id = NULL WHERE id = ?").run(nuggetId);
    if (n.nodeId !== undefined) this.markDirty(n.nodeId);
  }

  /** Record that a live node already contained this nugget's knowledge (or clear it). */
  setCovered(nuggetId: number, nodeId: number | undefined): void {
    this.sql.prepare("UPDATE nugget SET covered_node_id = ? WHERE id = ?").run(nodeId ?? null, nuggetId);
  }

  /** Nuggets not yet placed in the tree, oldest first. */
  unplacedNuggets(): NuggetRow[] {
    return this.db.nuggets().filter((n) => n.nodeId === undefined);
  }

  /**
   * Move a node under another parent of the same scope, one level up. A skill with
   * sections can't become a section (depth would exceed the cap).
   */
  moveNode(id: number, newParentId: number): void {
    const node = this.mustGet(id);
    const parent = this.mustGet(newParentId);
    if (node.depth === 0) throw new Error("Roots can't move");
    if (!sameScope(node, parent)) throw new Error(`Scope mismatch: node ${id} (${label(node)}) vs node ${newParentId} (${label(parent)})`);
    if (parent.depth + 1 > MAX_DEPTH) throw new Error(`Node ${newParentId} is a section; it can't have children`);
    const depth = parent.depth + 1;
    if (depth !== node.depth) {
      if (this.children(id).length) throw new Error(`Node ${id} has children; it can't change depth`);
      this.sql.prepare("UPDATE node SET depth = ? WHERE id = ?").run(depth, id);
    }
    const old = node.parentId;
    this.sql.prepare("UPDATE node SET parent_id = ?, updated_at = ? WHERE id = ?").run(newParentId, Date.now(), id);
    if (old !== undefined) this.markDirty(old);
    this.markDirty(newParentId);
  }

  /**
   * Delete latent nodes that hold nothing (no children, no nuggets) and have no
   * proposal yet. Roots, file-backed and declared nodes are kept.
   */
  pruneEmpty(): number {
    let total = 0;
    for (;;) {
      const r = this.sql
        .prepare(
          `DELETE FROM node WHERE origin = 'latent' AND status IN ('open', 'candidate')
             AND NOT EXISTS (SELECT 1 FROM node c WHERE c.parent_id = node.id)
             AND NOT EXISTS (SELECT 1 FROM nugget g WHERE g.node_id = node.id)`,
        )
        .run();
      if (Number(r.changes) === 0) return total;
      total += Number(r.changes);
    }
  }

  /** Whole trees, one per root (optionally for one scope), built from two queries. */
  trees(scope?: Scope): TreeNode[] {
    const rows = (this.sql.prepare("SELECT * FROM node ORDER BY depth, id").all() as Row[]).map(toNode);
    const byId = new Map<number, TreeNode>();
    for (const r of rows) byId.set(r.id, { ...r, children: [], nuggets: [] });
    for (const n of this.db.nuggets()) if (n.nodeId !== undefined) byId.get(n.nodeId)?.nuggets.push(n);
    const roots: TreeNode[] = [];
    for (const n of byId.values()) {
      if (n.parentId === undefined) roots.push(n);
      else byId.get(n.parentId)?.children.push(n);
    }
    return scope ? roots.filter((r) => sameScope(r, scope)) : roots;
  }

  /** One node with its subtree. */
  subtree(id: number): TreeNode | undefined {
    const find = (n: TreeNode): TreeNode | undefined => (n.id === id ? n : n.children.map(find).find(Boolean));
    for (const r of this.trees()) {
      const hit = find(r);
      if (hit) return hit;
    }
    return undefined;
  }
}

/** All nuggets in a subtree. */
export function subtreeNuggets(n: TreeNode): NuggetRow[] {
  return [...n.nuggets, ...n.children.flatMap(subtreeNuggets)];
}

/** Depth-1 nodes of a tree. */
export function skillsOf(root: TreeNode): TreeNode[] {
  return root.children;
}

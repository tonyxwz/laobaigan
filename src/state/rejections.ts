import { redact } from "../pipeline/redact.ts";
import type { StateDb } from "./db.ts";
import { Tree } from "./tree.ts";

/**
 * Rejection memory: what a rejected proposal teaches lbg, so similar proposals
 * stop. `lbg proposal reject` writes it without a model call (status pending);
 * the next `lbg run` classifies it. With `--kind` it is active right away.
 *
 *   outdated     the knowledge is stale; its replacement is welcome
 *   not-useful   don't make a skill about this topic
 *   wrong-place  right knowledge, wrong skill: it belongs in `target`
 *   later        not now; only the status matters
 */
export const REJECTION_KINDS = ["outdated", "not-useful", "wrong-place", "later"] as const;
export type RejectionKind = (typeof REJECTION_KINDS)[number];
export const MEMORY_STATUSES = ["pending", "active", "removed"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** What was rejected, frozen at reject time. */
export interface RejectedTopic {
  name?: string;
  title: string;
  description?: string;
  proposalKind: string;
  /** Up to a dozen evidence items (id + title). */
  evidence: { id: number; title: string }[];
}

export interface MemoryRow {
  id: number;
  proposalId: number;
  feedbackId?: number;
  /** The reject reason (from the feedback row). */
  reason: string;
  nodeId?: number;
  scope: "global" | "repo";
  repo?: string;
  kind?: RejectionKind;
  rule?: string;
  topic: RejectedTopic;
  targetNodeId?: number;
  status: MemoryStatus;
  locked: boolean;
  error?: string;
  expiresAt?: Date;
  /** Nuggets insert routed to the rejected skill since (look-alikes caught). */
  caught: number;
  /** Extraction calls it was part of. */
  extractUses: number;
  createdAt: Date;
  classifiedAt?: Date;
}

type Row = Record<string, unknown>;

function toRow(r: Row): MemoryRow {
  return {
    id: Number(r.id),
    proposalId: Number(r.proposal_id),
    ...(r.feedback_id != null ? { feedbackId: Number(r.feedback_id) } : {}),
    reason: String(r.reason ?? ""),
    ...(r.node_id != null ? { nodeId: Number(r.node_id) } : {}),
    scope: r.scope as "global" | "repo",
    ...(r.repo ? { repo: String(r.repo) } : {}),
    ...(r.kind ? { kind: r.kind as RejectionKind } : {}),
    ...(r.rule ? { rule: String(r.rule) } : {}),
    topic: JSON.parse(String(r.topic)) as RejectedTopic,
    ...(r.target_node_id != null ? { targetNodeId: Number(r.target_node_id) } : {}),
    status: r.status as MemoryStatus,
    locked: Number(r.locked) === 1,
    ...(r.error ? { error: String(r.error) } : {}),
    ...(r.expires_at != null ? { expiresAt: new Date(Number(r.expires_at)) } : {}),
    caught: Number(r.caught ?? 0),
    extractUses: Number(r.extract_uses ?? 0),
    createdAt: new Date(Number(r.created_at)),
    ...(r.classified_at != null ? { classifiedAt: new Date(Number(r.classified_at)) } : {}),
  };
}

export function assertKind(k: string): RejectionKind {
  if (!REJECTION_KINDS.includes(k as RejectionKind)) throw new Error(`Bad rejection kind "${k}" (expected ${REJECTION_KINDS.join(", ")})`);
  return k as RejectionKind;
}

/** One line, redacted, bounded. */
export function cleanRule(s: string): string {
  const one = redact(s).text.replace(/\s+/g, " ").trim();
  return one.length > 240 ? `${one.slice(0, 239)}…` : one;
}

export class Rejections {
  readonly db: StateDb;
  constructor(db: StateDb) {
    this.db = db;
  }
  private get sql() {
    return this.db.db;
  }

  /**
   * Keep forgotten evidence in step with a memory: an active `outdated` memory forgets
   * its proposal's evidence; any other kind, or a removed memory, gives it back.
   */
  private syncEvidence(id: number): void {
    const m = this.mustGet(id);
    const tree = new Tree(this.db);
    if (m.status === "active" && m.kind === "outdated") {
      tree.forgetNuggets(this.proposalNuggets(m.proposalId), `outdated (rejection #${m.id})`, m.id);
    } else {
      tree.unforgetNuggets({ memoryId: m.id });
    }
  }

  /** Evidence ids of a proposal that still exist. */
  proposalNuggets(proposalId: number): number[] {
    const r = this.sql.prepare("SELECT nugget_ids FROM proposal WHERE id = ?").get(proposalId) as Row | undefined;
    const ids = r ? (JSON.parse(String(r.nugget_ids)) as number[]) : [];
    return ids.filter((n) => this.sql.prepare("SELECT 1 FROM nugget WHERE id = ?").get(n));
  }

  private select(where: string, ...args: (string | number)[]): MemoryRow[] {
    return (
      this.sql
        .prepare(`SELECT m.*, f.text AS reason FROM rejection_memory m LEFT JOIN feedback f ON f.id = m.feedback_id WHERE ${where} ORDER BY m.id`)
        .all(...args) as Row[]
    ).map(toRow);
  }

  get(id: number): MemoryRow | undefined {
    return this.select("m.id = ?", id)[0];
  }

  mustGet(id: number): MemoryRow {
    const m = this.get(id);
    if (!m) throw new Error(`No rejection memory ${id}`);
    return m;
  }

  list(status?: MemoryStatus[]): MemoryRow[] {
    return status?.length ? this.select(`m.status IN (${status.map(() => "?").join(",")})`, ...status) : this.select("1");
  }

  /** Memories in effect: active (and, from lbg-1ps.7, not expired). */
  inEffect(): MemoryRow[] {
    return this.list(["active"]).filter((m) => !m.expiresAt || m.expiresAt.getTime() > Date.now());
  }

  /** The newest memory in effect for each node. */
  byNode(): Map<number, MemoryRow> {
    const out = new Map<number, MemoryRow>();
    for (const m of this.inEffect()) if (m.nodeId !== undefined) out.set(m.nodeId, m); // ordered by id: newest wins
    return out;
  }

  /** Insert routed `n` nuggets to this memory's skill. */
  addCaught(id: number, n: number): void {
    if (n > 0) this.sql.prepare("UPDATE rejection_memory SET caught = caught + ? WHERE id = ?").run(n, id);
  }

  /** These memories were part of `calls` extraction calls. */
  addExtractUses(ids: number[], calls: number): void {
    if (calls > 0) for (const id of ids) this.sql.prepare("UPDATE rejection_memory SET extract_uses = extract_uses + ? WHERE id = ?").run(calls, id);
  }

  /** Pending memories, oldest first (what the next run classifies). */
  pending(): MemoryRow[] {
    return this.list(["pending"]);
  }

  forNode(nodeId: number): MemoryRow[] {
    return this.select("m.node_id = ? AND m.status != 'removed'", nodeId);
  }

  /**
   * Record a rejection. Without `kind` it is pending (classified by the next lbg run);
   * with `kind` it is active now and the reason is the rule.
   */
  add(m: {
    proposalId: number;
    feedbackId?: number;
    nodeId?: number;
    scope: "global" | "repo";
    repo?: string;
    topic: RejectedTopic;
    kind?: RejectionKind;
    rule?: string;
    targetNodeId?: number;
    /** Default: locked when I gave the kind. */
    locked?: boolean;
    at?: Date;
  }): number {
    const at = (m.at ?? new Date()).getTime();
    const active = m.kind !== undefined;
    const id = Number(
      this.sql
        .prepare(
          `INSERT INTO rejection_memory (proposal_id, feedback_id, node_id, scope, repo, kind, rule, topic, target_node_id, status, locked, created_at, classified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.proposalId,
          m.feedbackId ?? null,
          m.nodeId ?? null,
          m.scope,
          m.repo ?? null,
          m.kind ?? null,
          m.rule !== undefined ? cleanRule(m.rule) : null,
          JSON.stringify(m.topic),
          m.targetNodeId ?? null,
          active ? "active" : "pending",
          (m.locked ?? active) ? 1 : 0, // I chose the kind myself: never reclassify it
          at,
          active ? at : null,
        ).lastInsertRowid,
    );
    if (active) this.syncEvidence(id);
    return id;
  }

  /** The classifier's answer. Skips memories I've locked meanwhile. */
  classify(id: number, c: { kind: RejectionKind; rule: string; targetNodeId?: number }): boolean {
    const r = this.sql
      .prepare(
        `UPDATE rejection_memory SET kind = ?, rule = ?, target_node_id = ?, status = 'active', error = NULL, classified_at = ?
         WHERE id = ? AND status = 'pending' AND locked = 0`,
      )
      .run(c.kind, cleanRule(c.rule), c.targetNodeId ?? null, Date.now(), id);
    if (Number(r.changes) !== 1) return false;
    this.syncEvidence(id);
    return true;
  }

  /** Classification failed: stays pending for the next run. */
  failed(id: number, error: string): void {
    this.sql.prepare("UPDATE rejection_memory SET error = ? WHERE id = ?").run(cleanRule(error), id);
  }

  /** My correction. Locks it (never reclassified) and makes it active. */
  edit(id: number, patch: { kind?: RejectionKind; rule?: string; targetNodeId?: number | null }): MemoryRow {
    const m = this.mustGet(id);
    if (m.status === "removed") throw new Error(`Rejection memory ${id} was forgotten; nothing to edit`);
    const kind = patch.kind ?? m.kind;
    if (!kind) throw new Error(`Rejection memory ${id} isn't classified yet; give --kind`);
    const rule = patch.rule !== undefined ? cleanRule(patch.rule) : (m.rule ?? cleanRule(m.reason || "rejected"));
    const target = patch.targetNodeId === undefined ? (m.targetNodeId ?? null) : patch.targetNodeId;
    this.sql
      .prepare(
        `UPDATE rejection_memory SET kind = ?, rule = ?, target_node_id = ?, status = 'active', locked = 1, error = NULL,
           classified_at = COALESCE(classified_at, ?) WHERE id = ?`,
      )
      .run(kind, rule, kind === "wrong-place" ? target : null, Date.now(), id);
    this.syncEvidence(id);
    return this.mustGet(id);
  }

  /** Stop using it (kept for history). */
  forget(id: number): void {
    this.mustGet(id);
    this.sql.prepare("UPDATE rejection_memory SET status = 'removed' WHERE id = ?").run(id);
    this.syncEvidence(id); // gives back what it forgot
  }
}

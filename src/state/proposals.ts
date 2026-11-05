import { createHash } from "node:crypto";
import type { StateDb } from "./db.ts";
import type { ProposalKind } from "./tree.ts";

/**
 * A proposal: drafted file contents for one depth-1 node (skill or AGENTS.md
 * section), stored in the db. lbg never runs git: accepting writes the files
 * to the target and I commit (or not) myself.
 *
 *   drafting ─┬─► open ─┬─► accepted   files written to the target
 *             │         └─► rejected   node waits for new evidence
 *             └─► failed               node stays a candidate
 *
 * At most one drafting/open proposal per node; while active the node is
 * `proposed` (frozen against curation and re-scoring).
 */
export const PROPOSAL_STATUSES = ["drafting", "open", "accepted", "rejected", "failed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** One file of a draft. Paths are relative to the proposal's `targetRoot`. */
export interface DraftFile {
  path: string;
  /** Hash of the file when drafting started; null = it didn't exist. */
  baseHash: string | null;
  /** New content; null = delete the file. */
  content: string | null;
}

export function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export interface ProposalRow {
  id: number;
  nodeId: number;
  kind: ProposalKind;
  status: ProposalStatus;
  scope: "global" | "repo";
  repo?: string;
  skillName?: string;
  targetRoot: string;
  writable: string[];
  files: DraftFile[];
  summary?: string;
  nuggetIds: number[];
  sessions: number;
  /** When the evidence of the current draft was taken (draft, or the last AI revise). */
  draftedAt: Date;
  usage?: unknown;
  detail?: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
}

export type NewProposal = Pick<ProposalRow, "nodeId" | "kind" | "scope" | "targetRoot" | "writable" | "nuggetIds" | "sessions"> &
  Partial<Pick<ProposalRow, "repo" | "skillName">>;

type Row = Record<string, unknown>;

function toProposal(r: Row): ProposalRow {
  return {
    id: Number(r.id),
    nodeId: Number(r.node_id),
    kind: r.kind as ProposalKind,
    status: r.status as ProposalStatus,
    scope: r.scope as "global" | "repo",
    ...(r.repo ? { repo: String(r.repo) } : {}),
    ...(r.skill_name ? { skillName: String(r.skill_name) } : {}),
    targetRoot: String(r.target_root),
    writable: JSON.parse(String(r.writable)) as string[],
    files: JSON.parse(String(r.files)) as DraftFile[],
    ...(r.summary ? { summary: String(r.summary) } : {}),
    nuggetIds: JSON.parse(String(r.nugget_ids)) as number[],
    sessions: Number(r.sessions),
    draftedAt: new Date(Number(r.drafted_at ?? r.created_at)),
    ...(r.usage ? { usage: JSON.parse(String(r.usage)) as unknown } : {}),
    ...(r.detail ? { detail: String(r.detail) } : {}),
    createdAt: new Date(Number(r.created_at)),
    updatedAt: new Date(Number(r.updated_at)),
    ...(r.closed_at != null ? { closedAt: new Date(Number(r.closed_at)) } : {}),
  };
}

export class Proposals {
  readonly db: StateDb;
  constructor(db: StateDb) {
    this.db = db;
  }
  private get sql() {
    return this.db.db;
  }

  get(id: number): ProposalRow | undefined {
    const r = this.sql.prepare("SELECT * FROM proposal WHERE id = ?").get(id) as Row | undefined;
    return r ? toProposal(r) : undefined;
  }

  mustGet(id: number): ProposalRow {
    const p = this.get(id);
    if (!p) throw new Error(`No proposal ${id}`);
    return p;
  }

  list(status?: ProposalStatus[]): ProposalRow[] {
    const rows = (
      status?.length
        ? this.sql.prepare(`SELECT * FROM proposal WHERE status IN (${status.map(() => "?").join(",")}) ORDER BY id`).all(...status)
        : this.sql.prepare("SELECT * FROM proposal ORDER BY id").all()
    ) as Row[];
    return rows.map(toProposal);
  }

  active(nodeId: number): ProposalRow | undefined {
    const r = this.sql.prepare("SELECT * FROM proposal WHERE node_id = ? AND status IN ('drafting', 'open')").get(nodeId) as Row | undefined;
    return r ? toProposal(r) : undefined;
  }

  forNode(nodeId: number): ProposalRow[] {
    return (this.sql.prepare("SELECT * FROM proposal WHERE node_id = ? ORDER BY id").all(nodeId) as Row[]).map(toProposal);
  }

  /** Start a proposal (drafting) and mark the node `proposed`. */
  create(p: NewProposal): number {
    const node = this.sql.prepare("SELECT depth FROM node WHERE id = ?").get(p.nodeId) as Row | undefined;
    if (!node) throw new Error(`No node ${p.nodeId}`);
    if (Number(node.depth) !== 1) throw new Error(`Proposals are for skills (depth 1); node ${p.nodeId} is depth ${node.depth}`);
    const existing = this.active(p.nodeId);
    if (existing) throw new Error(`Node ${p.nodeId} already has ${existing.status} proposal #${existing.id}`);
    const now = Date.now();
    return this.db.tx(() => {
      const id = Number(
        this.sql
          .prepare(
            `INSERT INTO proposal (node_id, kind, status, scope, repo, skill_name, target_root, writable, nugget_ids, sessions, drafted_at, created_at, updated_at)
             VALUES (?, ?, 'drafting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(p.nodeId, p.kind, p.scope, p.repo ?? null, p.skillName ?? null, p.targetRoot, JSON.stringify(p.writable), JSON.stringify(p.nuggetIds), p.sessions, now, now, now)
          .lastInsertRowid,
      );
      this.setNodeStatus(p.nodeId, "proposed");
      return id;
    });
  }

  private setNodeStatus(nodeId: number, status: string, extra: Record<string, number | null> = {}): void {
    const sets = ["status = ?", "updated_at = ?", ...Object.keys(extra).map((k) => `${k} = ?`)];
    this.sql.prepare(`UPDATE node SET ${sets.join(", ")} WHERE id = ?`).run(status, Date.now(), ...Object.values(extra), nodeId);
  }

  private transition(id: number, from: ProposalStatus[], to: ProposalStatus, fields: Record<string, string | number | null> = {}): ProposalRow {
    const p = this.mustGet(id);
    if (!from.includes(p.status)) throw new Error(`Proposal #${id} is ${p.status}; can't mark it ${to}`);
    const now = Date.now();
    const closing = to !== "drafting" && to !== "open";
    const cols = { status: to, updated_at: now, ...(closing ? { closed_at: now } : {}), ...fields };
    this.sql.prepare(`UPDATE proposal SET ${Object.keys(cols).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(cols), id);
    return p;
  }

  /** Drafting finished and verified: store the files for review. Also used to replace an open draft (revise / edit). */
  markOpen(id: number, files: DraftFile[], summary: string, usage?: unknown, evidence?: { draftedAt: Date; nuggetIds: number[] }): void {
    this.transition(id, ["drafting", "open"], "open", {
      files: JSON.stringify(files),
      summary,
      ...(usage !== undefined ? { usage: JSON.stringify(usage) } : {}),
      ...(evidence ? { drafted_at: evidence.draftedAt.getTime(), nugget_ids: JSON.stringify(evidence.nuggetIds) } : {}),
    });
  }

  /**
   * Drafting takes about a minute. A proposal still `drafting` after `maxAgeMs` means the
   * process died mid-draft (crash, Ctrl-C, timeout): mark it failed so its skill isn't
   * frozen as `proposed` forever. Returns the ids recovered.
   */
  recoverInterrupted(maxAgeMs = 3600e3, now = Date.now()): number[] {
    const stale = this.list(["drafting"]).filter((p) => now - p.createdAt.getTime() > maxAgeMs);
    for (const p of stale) this.markFailed(p.id, "interrupted: lbg exited while drafting");
    return stale.map((p) => p.id);
  }

  /** Drafting failed: the node is a candidate again. */
  markFailed(id: number, detail: string, usage?: unknown): void {
    this.db.tx(() => {
      const p = this.transition(id, ["drafting", "open"], "failed", { detail, ...(usage !== undefined ? { usage: JSON.stringify(usage) } : {}) });
      this.setNodeStatus(p.nodeId, "candidate");
    });
  }

  /** The files were written to the target. The next sync makes the node live (it is `open` again now). */
  markAccepted(id: number): void {
    this.db.tx(() => {
      const p = this.transition(id, ["open"], "accepted");
      this.setNodeStatus(p.nodeId, "open");
    });
  }

  /** I said no. The node returns only after the topic comes up in new sessions. */
  markRejected(id: number, reason?: string): void {
    this.db.tx(() => {
      const p = this.transition(id, ["drafting", "open"], "rejected", reason ? { detail: reason } : {});
      this.setNodeStatus(p.nodeId, "rejected", { rejected_sessions: p.sessions });
    });
  }
}

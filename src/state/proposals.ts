import type { ProposalKind } from "./tree.ts";
import type { StateDb } from "./db.ts";

/**
 * A proposal: one branch + worktree in the target repo, drafted by pi for one
 * depth-1 node (skill or AGENTS.md section). I review and merge it myself.
 *
 *   drafting ─┬─► open ─┬─► merged     (branch reached the base branch)
 *             │         └─► rejected   (I said no; node waits for new evidence)
 *             └─► failed               (drafting or verification failed; node stays a candidate)
 *
 * At most one drafting/open proposal per node. While it is active the node is
 * `proposed`, which freezes it against curation and rebalancing.
 */
export const PROPOSAL_STATUSES = ["drafting", "open", "merged", "rejected", "failed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ProposalRow {
  id: number;
  nodeId: number;
  kind: ProposalKind;
  status: ProposalStatus;
  scope: "global" | "repo";
  repo?: string;
  skillName?: string;
  gitDir?: string;
  workTree: string;
  baseBranch: string;
  baseCommit: string;
  branch: string;
  worktree: string;
  commit?: string;
  writable: string[];
  nuggetIds: number[];
  sessions: number;
  usage?: unknown;
  detail?: string;
  worktreeRemoved: boolean;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
}

export type NewProposal = Omit<ProposalRow, "id" | "status" | "commit" | "usage" | "detail" | "worktreeRemoved" | "createdAt" | "updatedAt" | "closedAt">;

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
    ...(r.git_dir ? { gitDir: String(r.git_dir) } : {}),
    workTree: String(r.work_tree),
    baseBranch: String(r.base_branch),
    baseCommit: String(r.base_commit),
    branch: String(r.branch),
    worktree: String(r.worktree),
    ...(r.commit_sha ? { commit: String(r.commit_sha) } : {}),
    writable: JSON.parse(String(r.writable)) as string[],
    nuggetIds: JSON.parse(String(r.nugget_ids)) as number[],
    sessions: Number(r.sessions),
    ...(r.usage ? { usage: JSON.parse(String(r.usage)) as unknown } : {}),
    ...(r.detail ? { detail: String(r.detail) } : {}),
    worktreeRemoved: Number(r.worktree_removed) === 1,
    createdAt: new Date(Number(r.created_at)),
    updatedAt: new Date(Number(r.updated_at)),
    ...(r.closed_at != null ? { closedAt: new Date(Number(r.closed_at)) } : {}),
  };
}

const ACTIVE: ProposalStatus[] = ["drafting", "open"];

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

  private mustGet(id: number): ProposalRow {
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

  /** The drafting/open proposal for a node, if any. */
  active(nodeId: number): ProposalRow | undefined {
    const r = this.sql.prepare("SELECT * FROM proposal WHERE node_id = ? AND status IN ('drafting', 'open')").get(nodeId) as Row | undefined;
    return r ? toProposal(r) : undefined;
  }

  forNode(nodeId: number): ProposalRow[] {
    return (this.sql.prepare("SELECT * FROM proposal WHERE node_id = ? ORDER BY id").all(nodeId) as Row[]).map(toProposal);
  }

  /** Start a proposal (status drafting) and mark the node `proposed`. */
  create(p: NewProposal): number {
    const node = this.sql.prepare("SELECT depth, status FROM node WHERE id = ?").get(p.nodeId) as Row | undefined;
    if (!node) throw new Error(`No node ${p.nodeId}`);
    if (Number(node.depth) !== 1) throw new Error(`Proposals are for skills (depth 1); node ${p.nodeId} is depth ${node.depth}`);
    const existing = this.active(p.nodeId);
    if (existing) throw new Error(`Node ${p.nodeId} already has ${existing.status} proposal #${existing.id} (${existing.branch})`);
    const now = Date.now();
    return this.db.tx(() => {
      const id = Number(
        this.sql
          .prepare(
            `INSERT INTO proposal (node_id, kind, status, scope, repo, skill_name, git_dir, work_tree, base_branch, base_commit,
                                   branch, worktree, writable, nugget_ids, sessions, created_at, updated_at)
             VALUES (?, ?, 'drafting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.nodeId,
            p.kind,
            p.scope,
            p.repo ?? null,
            p.skillName ?? null,
            p.gitDir ?? null,
            p.workTree,
            p.baseBranch,
            p.baseCommit,
            p.branch,
            p.worktree,
            JSON.stringify(p.writable),
            JSON.stringify(p.nuggetIds),
            p.sessions,
            now,
            now,
          ).lastInsertRowid,
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
    const closing = to === "merged" || to === "rejected" || to === "failed";
    const cols = { status: to, updated_at: now, ...(closing ? { closed_at: now } : {}), ...fields };
    this.sql.prepare(`UPDATE proposal SET ${Object.keys(cols).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(cols), id);
    return p;
  }

  /** Drafting finished and verified: the branch has a commit to review. */
  markOpen(id: number, commit: string, usage?: unknown): void {
    this.transition(id, ["drafting"], "open", { commit_sha: commit, ...(usage !== undefined ? { usage: JSON.stringify(usage) } : {}) });
  }

  /** Drafting or verification failed: the node is a candidate again (retried on a later run). */
  markFailed(id: number, detail: string, usage?: unknown): void {
    this.db.tx(() => {
      const p = this.transition(id, ["drafting", "open"], "failed", { detail, ...(usage !== undefined ? { usage: JSON.stringify(usage) } : {}) });
      this.setNodeStatus(p.nodeId, "candidate");
    });
  }

  /** I merged the branch. The node is `merged` until the next sync picks up the new files. */
  markMerged(id: number): void {
    this.db.tx(() => {
      const p = this.transition(id, ["open"], "merged");
      this.setNodeStatus(p.nodeId, "merged");
    });
  }

  /**
   * I rejected it. The node waits until the topic comes up in new sessions
   * (`rejected_sessions` records how many it had).
   */
  markRejected(id: number, reason?: string): void {
    this.db.tx(() => {
      const p = this.transition(id, ["drafting", "open"], "rejected", reason ? { detail: reason } : {});
      this.setNodeStatus(p.nodeId, "rejected", { rejected_sessions: p.sessions });
    });
  }

  markWorktreeRemoved(id: number): void {
    this.mustGet(id);
    this.sql.prepare("UPDATE proposal SET worktree_removed = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /** Closed proposals whose worktree is still on disk (for cleanup). */
  needingCleanup(): ProposalRow[] {
    return this.list(["merged", "rejected", "failed"]).filter((p) => !p.worktreeRemoved);
  }

  isActive(p: ProposalRow): boolean {
    return ACTIVE.includes(p.status);
  }
}

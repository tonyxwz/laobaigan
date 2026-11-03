import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentId, SessionRef } from "../sources/types.ts";

export const MIGRATIONS: string[] = [
  `CREATE TABLE session (
     agent        TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     version      TEXT NOT NULL,          -- change token of the last *successful* processing
     location     TEXT NOT NULL,
     cwd          TEXT,
     title        TEXT,
     updated_at   INTEGER NOT NULL,       -- epoch ms
     processed_at INTEGER NOT NULL,
     status       TEXT NOT NULL,          -- extracted | skipped | error
     detail       TEXT,                   -- skip reason / error message
     signals      TEXT,                   -- JSON prefilter signals
     PRIMARY KEY (agent, session_id)
   );
   CREATE TABLE turn_seen (
     fingerprint  TEXT PRIMARY KEY,
     agent        TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     seen_at      INTEGER NOT NULL
   );
   CREATE TABLE nugget (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id       INTEGER NOT NULL,
     agent        TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     cwd          TEXT,
     kind         TEXT NOT NULL,
     title        TEXT NOT NULL,
     knowledge    TEXT NOT NULL,
     triggers     TEXT NOT NULL,          -- JSON string[]
     scope        TEXT NOT NULL,          -- global | repo
     repo         TEXT,
     covered_by   TEXT,
     confidence   REAL NOT NULL,
     evidence     TEXT NOT NULL,          -- JSON [{label, fingerprint, ts, quote}]
     cluster_id   INTEGER,
     created_at   INTEGER NOT NULL
   );
   CREATE INDEX nugget_session ON nugget (agent, session_id);
   CREATE INDEX nugget_cluster ON nugget (cluster_id);
   CREATE TABLE run (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     started_at   INTEGER NOT NULL,
     finished_at  INTEGER,
     kind         TEXT NOT NULL,
     dry_run      INTEGER NOT NULL,
     stats        TEXT                    -- JSON counts, tokens, cost, errors
   );`,
  // 2: clusters of nuggets that say the same thing (M2)
  `CREATE TABLE cluster (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     title        TEXT NOT NULL,
     summary      TEXT NOT NULL,          -- canonical merged knowledge, updated as members join
     scope        TEXT NOT NULL,          -- global | repo
     repo         TEXT,                   -- repo root when scope = repo
     status       TEXT NOT NULL DEFAULT 'open', -- open | candidate | proposed | merged | rejected
     score        REAL NOT NULL DEFAULT 0,
     target       TEXT,                   -- e.g. global:update:git-worktree, repo:agents-md:/path
     stats        TEXT,                   -- JSON ClusterStats at last scoring
     rejected_sessions INTEGER,           -- distinct sessions when rejected; re-propose only after growth
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   );
   CREATE INDEX cluster_status ON cluster (status);`,
  // 3: targets set by hand (lbg clusters retarget) survive re-scoring
  `ALTER TABLE cluster ADD COLUMN target_locked INTEGER NOT NULL DEFAULT 0;`,
];

export const CLUSTER_STATUSES = ["open", "candidate", "proposed", "merged", "rejected"] as const;
export type ClusterStatus = (typeof CLUSTER_STATUSES)[number];

export interface NuggetRow {
  id: number;
  runId: number;
  agent: AgentId;
  sessionId: string;
  cwd: string;
  kind: string;
  title: string;
  knowledge: string;
  triggers: string[];
  scope: "global" | "repo";
  repo?: string;
  coveredBy?: string;
  confidence: number;
  evidence: { label: string; fingerprint?: string; ts?: string; quote: string }[];
  clusterId?: number;
  createdAt: Date;
}

export interface ClusterRow {
  id: number;
  title: string;
  summary: string;
  scope: "global" | "repo";
  repo?: string;
  status: ClusterStatus;
  score: number;
  target?: string;
  /** Set by hand; scoring and repo resolution leave it alone. */
  targetLocked: boolean;
  stats?: unknown;
  rejectedSessions?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClusterWithMembers extends ClusterRow {
  members: NuggetRow[];
}

export interface SessionRow {
  agent: AgentId;
  session_id: string;
  version: string;
  status: "extracted" | "skipped" | "error";
  detail: string | null;
}

export interface NuggetInsert {
  runId: number;
  agent: AgentId;
  sessionId: string;
  cwd: string;
  kind: string;
  title: string;
  knowledge: string;
  triggers: string[];
  scope: "global" | "repo";
  repo?: string;
  coveredBy?: string;
  confidence: number;
  evidence: { label: string; fingerprint?: string; ts?: string; quote: string }[];
}

export class StateDb {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const v = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Consistent copy of the database (for dry runs that must behave like real ones). */
  snapshotTo(path: string): StateDb {
    this.db.prepare("VACUUM INTO ?").run(path);
    return new StateDb(path);
  }

  getSession(agent: AgentId, sessionId: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT agent, session_id, version, status, detail FROM session WHERE agent = ? AND session_id = ?")
      .get(agent, sessionId) as SessionRow | undefined;
  }

  /** True if this exact version was already processed successfully (extracted or skipped). */
  isUpToDate(ref: SessionRef): boolean {
    const row = this.getSession(ref.agent, ref.sessionId);
    return !!row && row.version === ref.version && row.status !== "error";
  }

  recordSession(
    ref: SessionRef,
    cwd: string,
    status: SessionRow["status"],
    detail?: string,
    signals?: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO session (agent, session_id, version, location, cwd, title, updated_at, processed_at, status, detail, signals)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent, session_id) DO UPDATE SET
           version = CASE WHEN excluded.status = 'error' THEN session.version ELSE excluded.version END,
           location = excluded.location, cwd = excluded.cwd, title = excluded.title,
           updated_at = excluded.updated_at, processed_at = excluded.processed_at,
           status = excluded.status, detail = excluded.detail, signals = excluded.signals`,
      )
      .run(
        ref.agent,
        ref.sessionId,
        // Errors keep version "" on first insert so the session is retried.
        status === "error" ? "" : ref.version,
        ref.location,
        cwd,
        ref.title ?? null,
        ref.updatedAt.getTime(),
        Date.now(),
        status,
        detail ?? null,
        signals === undefined ? null : JSON.stringify(signals),
      );
  }

  /** Subset of `fingerprints` already recorded. */
  seenFingerprints(fingerprints: Iterable<string>): Set<string> {
    const stmt = this.db.prepare("SELECT 1 FROM turn_seen WHERE fingerprint = ?");
    const out = new Set<string>();
    for (const fp of fingerprints) if (stmt.get(fp)) out.add(fp);
    return out;
  }

  markSeen(agent: AgentId, sessionId: string, fingerprints: Iterable<string>): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO turn_seen (fingerprint, agent, session_id, seen_at) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    for (const fp of fingerprints) stmt.run(fp, agent, sessionId, now);
  }

  insertNugget(n: NuggetInsert): number {
    const r = this.db
      .prepare(
        `INSERT INTO nugget (run_id, agent, session_id, cwd, kind, title, knowledge, triggers, scope, repo,
                             covered_by, confidence, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        n.runId,
        n.agent,
        n.sessionId,
        n.cwd,
        n.kind,
        n.title,
        n.knowledge,
        JSON.stringify(n.triggers),
        n.scope,
        n.repo ?? null,
        n.coveredBy ?? null,
        n.confidence,
        JSON.stringify(n.evidence),
        Date.now(),
      );
    return Number(r.lastInsertRowid);
  }

  startRun(kind: string, dryRun: boolean): number {
    const r = this.db
      .prepare("INSERT INTO run (started_at, kind, dry_run) VALUES (?, ?, ?)")
      .run(Date.now(), kind, dryRun ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  finishRun(id: number, stats: unknown): void {
    this.db.prepare("UPDATE run SET finished_at = ?, stats = ? WHERE id = ?").run(Date.now(), JSON.stringify(stats), id);
  }

  // ---- nuggets & clusters -------------------------------------------------

  /** Nuggets not yet assigned to a cluster, oldest first. */
  unclusteredNuggets(): NuggetRow[] {
    return (this.db.prepare("SELECT * FROM nugget WHERE cluster_id IS NULL ORDER BY id").all() as Row[]).map(toNugget);
  }

  nuggets(): NuggetRow[] {
    return (this.db.prepare("SELECT * FROM nugget ORDER BY id").all() as Row[]).map(toNugget);
  }

  createCluster(c: { title: string; summary: string; scope: "global" | "repo"; repo?: string }): number {
    const now = Date.now();
    const r = this.db
      .prepare(
        "INSERT INTO cluster (title, summary, scope, repo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(c.title, c.summary, c.scope, c.scope === "repo" ? (c.repo ?? null) : null, now, now);
    return Number(r.lastInsertRowid);
  }

  /** Update any subset of mutable cluster fields. */
  updateCluster(
    id: number,
    patch: Partial<
      Pick<ClusterRow, "title" | "summary" | "status" | "score" | "target" | "targetLocked" | "stats" | "rejectedSessions">
    >,
  ): void {
    const cols: Record<string, string> = {
      title: "title",
      summary: "summary",
      status: "status",
      score: "score",
      target: "target",
      targetLocked: "target_locked",
      stats: "stats",
      rejectedSessions: "rejected_sessions",
    };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col || v === undefined) continue;
      if (k === "status" && !CLUSTER_STATUSES.includes(v as ClusterStatus)) throw new Error(`Bad cluster status: ${v}`);
      sets.push(`${col} = ?`);
      vals.push(k === "stats" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null));
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    vals.push(Date.now(), id);
    const r = this.db.prepare(`UPDATE cluster SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    if (Number(r.changes) === 0) throw new Error(`No cluster ${id}`);
  }

  /** Assign a nugget to a cluster. Scope/repo must match (never mix global with repo, or two repos). */
  assignNugget(nuggetId: number, clusterId: number): void {
    const n = this.db.prepare("SELECT scope, repo FROM nugget WHERE id = ?").get(nuggetId) as Row | undefined;
    const c = this.db.prepare("SELECT scope, repo FROM cluster WHERE id = ?").get(clusterId) as Row | undefined;
    if (!n) throw new Error(`No nugget ${nuggetId}`);
    if (!c) throw new Error(`No cluster ${clusterId}`);
    if (n.scope !== c.scope || (n.scope === "repo" && (n.repo ?? null) !== (c.repo ?? null))) {
      throw new Error(
        `Scope mismatch: nugget ${nuggetId} (${n.scope}${n.repo ? `:${n.repo}` : ""}) vs cluster ${clusterId} (${c.scope}${c.repo ? `:${c.repo}` : ""})`,
      );
    }
    this.db.prepare("UPDATE nugget SET cluster_id = ? WHERE id = ?").run(clusterId, nuggetId);
    this.db.prepare("UPDATE cluster SET updated_at = ? WHERE id = ?").run(Date.now(), clusterId);
  }

  getCluster(id: number): ClusterWithMembers | undefined {
    const row = this.db.prepare("SELECT * FROM cluster WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const members = (this.db.prepare("SELECT * FROM nugget WHERE cluster_id = ? ORDER BY id").all(id) as Row[]).map(toNugget);
    return { ...toCluster(row), members };
  }

  /** All clusters (optionally filtered by status) with their member nuggets. */
  clusters(status?: ClusterStatus[]): ClusterWithMembers[] {
    const rows = (
      status?.length
        ? this.db.prepare(`SELECT * FROM cluster WHERE status IN (${status.map(() => "?").join(",")}) ORDER BY id`).all(...status)
        : this.db.prepare("SELECT * FROM cluster ORDER BY id").all()
    ) as Row[];
    const byCluster = new Map<number, NuggetRow[]>();
    for (const n of (this.db.prepare("SELECT * FROM nugget WHERE cluster_id IS NOT NULL ORDER BY id").all() as Row[]).map(toNugget)) {
      const list = byCluster.get(n.clusterId!) ?? [];
      list.push(n);
      byCluster.set(n.clusterId!, list);
    }
    return rows.map((r) => ({ ...toCluster(r), members: byCluster.get(Number(r.id)) ?? [] }));
  }

  counts(): Record<string, number> {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      sessions: one("SELECT count(*) n FROM session"),
      extracted: one("SELECT count(*) n FROM session WHERE status = 'extracted'"),
      skipped: one("SELECT count(*) n FROM session WHERE status = 'skipped'"),
      errors: one("SELECT count(*) n FROM session WHERE status = 'error'"),
      turnsSeen: one("SELECT count(*) n FROM turn_seen"),
      nuggets: one("SELECT count(*) n FROM nugget"),
      unclustered: one("SELECT count(*) n FROM nugget WHERE cluster_id IS NULL"),
      clusters: one("SELECT count(*) n FROM cluster"),
      candidates: one("SELECT count(*) n FROM cluster WHERE status = 'candidate'"),
    };
  }
}

type Row = Record<string, unknown>;

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function toNugget(r: Row): NuggetRow {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    agent: r.agent as AgentId,
    sessionId: String(r.session_id),
    cwd: String(r.cwd ?? ""),
    kind: String(r.kind),
    title: String(r.title),
    knowledge: String(r.knowledge),
    triggers: parseJson(r.triggers, [] as string[]),
    scope: r.scope as "global" | "repo",
    ...(r.repo ? { repo: String(r.repo) } : {}),
    ...(r.covered_by ? { coveredBy: String(r.covered_by) } : {}),
    confidence: Number(r.confidence),
    evidence: parseJson(r.evidence, [] as NuggetRow["evidence"]),
    ...(r.cluster_id != null ? { clusterId: Number(r.cluster_id) } : {}),
    createdAt: new Date(Number(r.created_at)),
  };
}

function toCluster(r: Row): ClusterRow {
  return {
    id: Number(r.id),
    title: String(r.title),
    summary: String(r.summary),
    scope: r.scope as "global" | "repo",
    ...(r.repo ? { repo: String(r.repo) } : {}),
    status: r.status as ClusterStatus,
    score: Number(r.score),
    ...(r.target ? { target: String(r.target) } : {}),
    targetLocked: Number(r.target_locked ?? 0) === 1,
    ...(r.stats ? { stats: parseJson(r.stats, undefined) } : {}),
    ...(r.rejected_sessions != null ? { rejectedSessions: Number(r.rejected_sessions) } : {}),
    createdAt: new Date(Number(r.created_at)),
    updatedAt: new Date(Number(r.updated_at)),
  };
}

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
  // 4: two levels. A topic becomes one skill (or one AGENTS.md section); its clusters
  // are subtopics (a section or references/<x>.md). Status/score/target move to topics.
  // Existing clusters become subtopics of singleton topics with the same id.
  `CREATE TABLE topic (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     name         TEXT,                   -- skill name when declared by the user
     title        TEXT NOT NULL,
     description  TEXT,                   -- user-declared scope of the topic
     scope        TEXT NOT NULL,          -- global | repo
     repo         TEXT,
     declared     INTEGER NOT NULL DEFAULT 0,  -- from config.topics
     locked       INTEGER NOT NULL DEFAULT 0,  -- curated by hand; automation keeps it
     status       TEXT NOT NULL DEFAULT 'open',
     score        REAL NOT NULL DEFAULT 0,
     target       TEXT,
     target_locked INTEGER NOT NULL DEFAULT 0,
     stats        TEXT,
     rejected_sessions INTEGER,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   );
   CREATE INDEX topic_status ON topic (status);
   INSERT INTO topic (id, title, scope, repo, status, score, target, target_locked, stats, rejected_sessions, created_at, updated_at)
     SELECT id, title, scope, repo, status, score, target, target_locked, stats, rejected_sessions, created_at, updated_at FROM cluster;
   ALTER TABLE cluster ADD COLUMN topic_id INTEGER REFERENCES topic (id);
   UPDATE cluster SET topic_id = id;
   DROP INDEX cluster_status;
   ALTER TABLE cluster DROP COLUMN status;
   ALTER TABLE cluster DROP COLUMN score;
   ALTER TABLE cluster DROP COLUMN target;
   ALTER TABLE cluster DROP COLUMN target_locked;
   ALTER TABLE cluster DROP COLUMN stats;
   ALTER TABLE cluster DROP COLUMN rejected_sessions;
   CREATE INDEX cluster_topic ON cluster (topic_id);`,
  // 5: hand curation locks. A locked cluster stays under its topic; a locked nugget
  // stays in its cluster. Regroup and consolidation never move them.
  `ALTER TABLE cluster ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE nugget ADD COLUMN assignment_locked INTEGER NOT NULL DEFAULT 0;`,
  // 6: the knowledge tree (one per scope, mirrors the skills files). Filled from topics/clusters:
  // each topic becomes a depth-1 node with the SAME id; single-cluster topics hold their nuggets
  // directly, multi-cluster topics get one depth-2 section per cluster. topic/cluster tables stay
  // until the CLI switches over to the tree (lbg-lb3.6).
  `CREATE TABLE node (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     parent_id     INTEGER REFERENCES node (id),
     scope         TEXT NOT NULL,          -- global | repo
     repo          TEXT,
     depth         INTEGER NOT NULL,       -- 0 root, 1 skill, 2 section
     name          TEXT,                   -- skill name (depth 1)
     title         TEXT NOT NULL,
     description   TEXT,                   -- routing description (skill) / when to read (section)
     summary       TEXT NOT NULL DEFAULT '',
     summary_dirty INTEGER NOT NULL DEFAULT 0,
     origin        TEXT NOT NULL,          -- root | file | declared | latent
     status        TEXT NOT NULL DEFAULT 'open',
     score         REAL NOT NULL DEFAULT 0,
     stats         TEXT,
     rejected_sessions INTEGER,
     locked        INTEGER NOT NULL DEFAULT 0,
     source_path   TEXT,                   -- file it was parsed from / renders to
     source_hash   TEXT,
     rendered_at   INTEGER,                -- evidence after this counts as "new" for live skills
     legacy_cluster_id INTEGER,            -- provenance from migration 6
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL,
     CHECK (depth BETWEEN 0 AND 2),
     CHECK ((depth = 0) = (parent_id IS NULL))
   );
   CREATE INDEX node_parent ON node (parent_id);
   CREATE INDEX node_scope ON node (scope, repo, depth);
   ALTER TABLE nugget ADD COLUMN node_id INTEGER REFERENCES node (id);
   CREATE INDEX nugget_node ON nugget (node_id);

   -- roots: one per scope/repo in use, with ids after every topic id
   INSERT INTO node (id, scope, repo, depth, title, origin, created_at, updated_at)
     SELECT (SELECT COALESCE(max(id), 0) FROM topic) + row_number() OVER (ORDER BY scope, repo),
            scope, repo, 0, CASE WHEN scope = 'global' THEN 'Global skills' ELSE repo END, 'root', 0, 0
     FROM (SELECT DISTINCT scope, repo FROM topic);
   -- skills keep their topic ids
   INSERT INTO node (id, parent_id, scope, repo, depth, name, title, description, origin, status, score, stats,
                     rejected_sessions, locked, summary, summary_dirty, legacy_cluster_id, created_at, updated_at)
     SELECT t.id,
            (SELECT r.id FROM node r WHERE r.depth = 0 AND r.scope = t.scope AND r.repo IS t.repo),
            t.scope, t.repo, 1, t.name, t.title, t.description,
            CASE WHEN t.declared = 1 THEN 'declared' ELSE 'latent' END, t.status, t.score, t.stats,
            t.rejected_sessions, t.locked,
            CASE WHEN (SELECT count(*) FROM cluster c WHERE c.topic_id = t.id) = 1
                 THEN (SELECT c.summary FROM cluster c WHERE c.topic_id = t.id) ELSE '' END,
            CASE WHEN (SELECT count(*) FROM cluster c WHERE c.topic_id = t.id) > 1 THEN 1 ELSE 0 END,
            CASE WHEN (SELECT count(*) FROM cluster c WHERE c.topic_id = t.id) = 1
                 THEN (SELECT c.id FROM cluster c WHERE c.topic_id = t.id) END,
            t.created_at, t.updated_at
     FROM topic t;
   -- sections: one per cluster of a multi-cluster topic
   INSERT INTO node (parent_id, scope, repo, depth, title, summary, origin, locked, legacy_cluster_id, created_at, updated_at)
     SELECT c.topic_id, c.scope, c.repo, 2, c.title, c.summary, 'latent', c.locked, c.id, c.created_at, c.updated_at
     FROM cluster c WHERE (SELECT count(*) FROM cluster c2 WHERE c2.topic_id = c.topic_id) > 1;
   -- nuggets: to the section of their cluster, or straight to the skill of a single-cluster topic
   UPDATE nugget SET node_id = (SELECT n.id FROM node n WHERE n.legacy_cluster_id = nugget.cluster_id
                                ORDER BY n.depth DESC LIMIT 1)
     WHERE cluster_id IS NOT NULL;`,
  // 7: insert found the nugget already written in a live node: I had to explain something
  // the skill already says, so that skill's description isn't triggering.
  `ALTER TABLE nugget ADD COLUMN covered_node_id INTEGER REFERENCES node (id);`,
  // 8: when a nugget was attached (evidence after a live skill's last render is "new"),
  // and which kind of proposal a candidate skill is for.
  `ALTER TABLE nugget ADD COLUMN attached_at INTEGER;
   UPDATE nugget SET attached_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE node_id IS NOT NULL;
   ALTER TABLE node ADD COLUMN proposal_kind TEXT;`,
  // 9: the tree replaced topics and clusters (lbg-lb3.6).
  `DROP INDEX IF EXISTS nugget_cluster;
   ALTER TABLE nugget DROP COLUMN cluster_id;
   DROP INDEX IF EXISTS cluster_topic;
   DROP TABLE cluster;
   DROP INDEX IF EXISTS topic_status;
   DROP TABLE topic;
   ALTER TABLE node DROP COLUMN legacy_cluster_id;`,
  // 10: proposals. One branch + worktree per proposal for a depth-1 node; I review and merge.
  `CREATE TABLE proposal (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     node_id       INTEGER NOT NULL REFERENCES node (id),
     kind          TEXT NOT NULL,          -- new | update | fix-description
     status        TEXT NOT NULL,          -- drafting | open | merged | rejected | failed
     scope         TEXT NOT NULL,
     repo          TEXT,                   -- repo root for repo scopes
     skill_name    TEXT,
     git_dir       TEXT,                   -- --git-dir when the repo is bare (~/.cfg)
     work_tree     TEXT NOT NULL,          -- main checkout of the target repo
     base_branch   TEXT NOT NULL,
     base_commit   TEXT NOT NULL,
     branch        TEXT NOT NULL,
     worktree      TEXT NOT NULL,
     commit_sha    TEXT,
     writable      TEXT NOT NULL,          -- JSON: paths the drafting session could write
     nugget_ids    TEXT NOT NULL,          -- JSON: evidence used
     sessions      INTEGER NOT NULL,       -- distinct sessions of that evidence
     usage         TEXT,                   -- JSON token usage / cost of drafting
     detail        TEXT,                   -- error, or reject reason
     worktree_removed INTEGER NOT NULL DEFAULT 0,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL,
     closed_at     INTEGER
   );
   CREATE INDEX proposal_node ON proposal (node_id);
   CREATE INDEX proposal_status ON proposal (status);
   CREATE UNIQUE INDEX proposal_one_active ON proposal (node_id) WHERE status IN ('drafting', 'open');
   CREATE UNIQUE INDEX proposal_branch ON proposal (branch, COALESCE(git_dir, work_tree));`,
  // 11: lbg doesn't use git. A proposal is a snapshot of drafted files in the db; accepting
  // writes them to the target, and I commit with git (or not) myself. (No proposals existed yet.)
  `DROP TABLE proposal;
   CREATE TABLE proposal (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     node_id       INTEGER NOT NULL REFERENCES node (id),
     kind          TEXT NOT NULL,          -- new | update | fix-description
     status        TEXT NOT NULL,          -- drafting | open | accepted | rejected | failed
     scope         TEXT NOT NULL,
     repo          TEXT,
     skill_name    TEXT,
     target_root   TEXT NOT NULL,          -- directory the file paths are relative to
     writable      TEXT NOT NULL,          -- JSON: paths the drafting session could write
     files         TEXT NOT NULL DEFAULT '[]', -- JSON [{path, baseHash|null, content|null}]
     summary       TEXT,                   -- the drafter's note for the reviewer
     nugget_ids    TEXT NOT NULL,
     sessions      INTEGER NOT NULL,
     usage         TEXT,
     detail        TEXT,                   -- error, or reject reason
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL,
     closed_at     INTEGER
   );
   CREATE INDEX proposal_node ON proposal (node_id);
   CREATE INDEX proposal_status ON proposal (status);
   CREATE UNIQUE INDEX proposal_one_active ON proposal (node_id) WHERE status IN ('drafting', 'open');
   UPDATE node SET status = 'open' WHERE status = 'merged';`,
  // 12: when the evidence of the current draft was taken. Evidence attached later is "new since
  // the draft": shown in review, and still counts as fresh after the proposal is accepted.
  `ALTER TABLE proposal ADD COLUMN drafted_at INTEGER;
   UPDATE proposal SET drafted_at = created_at;`,
  // 13: the lbg process working on a proposal (drafting it, or a revise/edit session, which
  // can last hours). A live worker holds the proposal; a dead one means it was interrupted.
  `ALTER TABLE proposal ADD COLUMN worker_pid INTEGER;`,
];

/** Lifecycle of a skill: open → candidate (earned a proposal) → proposed → open again (accepted: it's live now) or rejected. */
export const STATUSES = ["open", "candidate", "proposed", "rejected"] as const;
export type Status = (typeof STATUSES)[number];

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
  /** Placed by hand; insert/rebalance keep it where it is. */
  assignmentLocked: boolean;
  /** Knowledge-tree node (skill or section) it is attached to. */
  nodeId?: number;
  /** Live node that already contained this knowledge when it was inserted. */
  coveredNodeId?: number;
  /** When it was attached to its node. */
  attachedAt?: Date;
  createdAt: Date;
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

  // ---- nuggets ---------------------------------------------------------------

  nuggets(): NuggetRow[] {
    return (this.db.prepare("SELECT * FROM nugget ORDER BY id").all() as Row[]).map(toNugget);
  }

  getNugget(id: number): NuggetRow | undefined {
    const r = this.db.prepare("SELECT * FROM nugget WHERE id = ?").get(id) as Row | undefined;
    return r ? toNugget(r) : undefined;
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
      unplaced: one("SELECT count(*) n FROM nugget WHERE node_id IS NULL"),
      skills: one("SELECT count(*) n FROM node WHERE depth = 1"),
      liveSkills: one("SELECT count(*) n FROM node WHERE depth = 1 AND origin = 'file'"),
      candidates: one("SELECT count(*) n FROM node WHERE depth = 1 AND status = 'candidate'"),
      openProposals: one("SELECT count(*) n FROM proposal WHERE status IN ('drafting', 'open')"),
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
    assignmentLocked: Number(r.assignment_locked ?? 0) === 1,
    ...(r.node_id != null ? { nodeId: Number(r.node_id) } : {}),
    ...(r.covered_node_id != null ? { coveredNodeId: Number(r.covered_node_id) } : {}),
    ...(r.attached_at != null ? { attachedAt: new Date(Number(r.attached_at)) } : {}),
    createdAt: new Date(Number(r.created_at)),
  };
}

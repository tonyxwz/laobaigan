import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentId, SessionRef } from "../sources/types.ts";

const MIGRATIONS: string[] = [
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
];

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

  counts(): Record<string, number> {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      sessions: one("SELECT count(*) n FROM session"),
      extracted: one("SELECT count(*) n FROM session WHERE status = 'extracted'"),
      skipped: one("SELECT count(*) n FROM session WHERE status = 'skipped'"),
      errors: one("SELECT count(*) n FROM session WHERE status = 'error'"),
      turnsSeen: one("SELECT count(*) n FROM turn_seen"),
      nuggets: one("SELECT count(*) n FROM nugget"),
    };
  }
}

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Tree } from "../src/state/tree.ts";

const nugget = (over: Partial<NuggetInsert> = {}): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId: "s1",
  cwd: "/repo",
  kind: "fact",
  title: "Logs live in /var/output",
  knowledge: "Logs are in `/apollo/env/X/var/output/logs`.",
  triggers: ["debugging"],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: "logs are in", ts: "2026-01-01T00:00:00.000Z" }],
  ...over,
});

const version = (db: StateDb) => Number((db.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
const tables = (db: StateDb) =>
  (db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("StateDb", () => {
  it("upgrades a v1 database in place, keeping nuggets", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lbg-db-")), "state.db");
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS[0]!);
    raw.exec("PRAGMA user_version = 1");
    raw
      .prepare(
        `INSERT INTO nugget (run_id, agent, session_id, cwd, kind, title, knowledge, triggers, scope, confidence, evidence, created_at)
         VALUES (1, 'pi', 's1', '/r', 'fact', 'old', 'k', '[]', 'global', 0.9, '[]', 0)`,
      )
      .run();
    raw.close();

    const db = new StateDb(path);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.nuggets().map((n) => n.title)).toEqual(["old"]);
    expect(db.counts()).toMatchObject({ nuggets: 1, unplaced: 1, skills: 0 });
    db.close();
  });

  it("migration 9 drops topics/clusters after the tree took them over", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lbg-db9-")), "state.db");
    const raw = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 5)) raw.exec(m);
    raw.exec("PRAGMA user_version = 5");
    raw.exec(`INSERT INTO topic (id, title, scope, status, score, created_at, updated_at) VALUES (4, 'Pi config', 'global', 'candidate', 11, 1, 1);
              INSERT INTO cluster (id, topic_id, title, summary, scope, created_at, updated_at) VALUES (4, 4, 'Pi config', 'sum', 'global', 1, 1);
              INSERT INTO nugget (run_id, agent, session_id, cwd, kind, title, knowledge, triggers, scope, confidence, evidence, cluster_id, created_at)
                VALUES (1, 'pi', 's', '/', 'fact', 't', 'k', '[]', 'global', 0.9, '[]', 4, 0);`);
    raw.close();

    const db = new StateDb(path);
    expect(tables(db)).not.toContain("topic");
    expect(tables(db)).not.toContain("cluster");
    const skill = new Tree(db).getNode(4)!;
    expect(skill).toMatchObject({ title: "Pi config", depth: 1, status: "candidate", summary: "sum" });
    expect(db.nuggets()[0]!.nodeId).toBe(4);
    expect(db.counts()).toMatchObject({ skills: 1, candidates: 1, unplaced: 0 });
  });

  it("round-trips nuggets and takes consistent snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-snap-"));
    const db = new StateDb(join(dir, "a.db"));
    const id = db.insertNugget(nugget());
    expect(db.getNugget(id)).toMatchObject({
      title: "Logs live in /var/output",
      triggers: ["debugging"],
      evidence: [{ label: "U1", quote: "logs are in", ts: "2026-01-01T00:00:00.000Z" }],
      assignmentLocked: false,
    });
    expect(db.getNugget(id)!.nodeId).toBeUndefined();

    const copy = db.snapshotTo(join(dir, "b.db"));
    copy.insertNugget(nugget({ title: "only in copy" }));
    expect(db.counts().nuggets).toBe(1);
    expect(copy.counts().nuggets).toBe(2);
  });
});

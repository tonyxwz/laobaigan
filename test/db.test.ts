import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, StateDb, type NuggetInsert } from "../src/state/db.ts";

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

describe("StateDb clusters", () => {
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
    expect(Number((db.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(MIGRATIONS.length);
    expect(db.unclusteredNuggets().map((n) => n.title)).toEqual(["old"]);
    expect(db.counts()).toMatchObject({ nuggets: 1, unclustered: 1, clusters: 0 });
    db.close();
  });

  it("creates clusters, assigns members, and round-trips fields", () => {
    const db = new StateDb(":memory:");
    const a = db.insertNugget(nugget());
    const b = db.insertNugget(nugget({ agent: "claude", sessionId: "s2", title: "Log location" }));
    const r = db.insertNugget(nugget({ scope: "repo", repo: "/w/Pkg", title: "Pkg uses hatch" }));

    const g = db.createCluster({ title: "Log locations", summary: "…", scope: "global", repo: "/ignored" });
    db.assignNugget(a, g);
    db.assignNugget(b, g);
    expect(db.unclusteredNuggets().map((n) => n.id)).toEqual([r]);

    db.updateCluster(g, { score: 7.5, status: "candidate", target: "global:new", stats: { sessions: 2 } });
    const c = db.getCluster(g)!;
    expect(c).toMatchObject({ title: "Log locations", scope: "global", status: "candidate", score: 7.5, target: "global:new", stats: { sessions: 2 } });
    expect(c.repo).toBeUndefined();
    expect(c.members.map((m) => [m.agent, m.sessionId, m.evidence[0]!.ts])).toEqual([
      ["pi", "s1", "2026-01-01T00:00:00.000Z"],
      ["claude", "s2", "2026-01-01T00:00:00.000Z"],
    ]);
    expect(db.clusters(["candidate"]).map((x) => x.id)).toEqual([g]);
    expect(db.clusters(["open"])).toEqual([]);
    expect(db.counts()).toMatchObject({ clusters: 1, candidates: 1, unclustered: 1 });
  });

  it("refuses to mix scopes or repos in one cluster, and bad statuses", () => {
    const db = new StateDb(":memory:");
    const g = db.insertNugget(nugget());
    const r1 = db.insertNugget(nugget({ scope: "repo", repo: "/w/A" }));
    const r2 = db.insertNugget(nugget({ scope: "repo", repo: "/w/B" }));
    const repoA = db.createCluster({ title: "A", summary: "", scope: "repo", repo: "/w/A" });

    db.assignNugget(r1, repoA);
    expect(() => db.assignNugget(r2, repoA)).toThrow(/Scope mismatch/);
    expect(() => db.assignNugget(g, repoA)).toThrow(/Scope mismatch/);
    expect(() => db.updateCluster(repoA, { status: "bogus" as never })).toThrow(/Bad cluster status/);
    expect(() => db.updateCluster(999, { score: 1 })).toThrow(/No cluster/);
  });
});

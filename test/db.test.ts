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

  it("creates clusters under singleton topics, assigns members, and round-trips topic fields", () => {
    const db = new StateDb(":memory:");
    const a = db.insertNugget(nugget());
    const b = db.insertNugget(nugget({ agent: "claude", sessionId: "s2", title: "Log location" }));
    const r = db.insertNugget(nugget({ scope: "repo", repo: "/w/Pkg", title: "Pkg uses hatch" }));

    const g = db.createCluster({ title: "Log locations", summary: "…", scope: "global", repo: "/ignored" });
    db.assignNugget(a, g);
    db.assignNugget(b, g);
    expect(db.unclusteredNuggets().map((n) => n.id)).toEqual([r]);

    const c = db.getCluster(g)!;
    expect(c.repo).toBeUndefined();
    expect(c.members.map((m) => [m.agent, m.sessionId, m.evidence[0]!.ts])).toEqual([
      ["pi", "s1", "2026-01-01T00:00:00.000Z"],
      ["claude", "s2", "2026-01-01T00:00:00.000Z"],
    ]);

    db.updateTopic(c.topicId, { score: 7.5, status: "candidate", target: "global:new:x", stats: { sessions: 2 } });
    const t = db.getTopic(c.topicId)!;
    expect(t).toMatchObject({ title: "Log locations", scope: "global", status: "candidate", score: 7.5, target: "global:new:x", stats: { sessions: 2 } });
    expect(t.repo).toBeUndefined();
    expect(t.clusters.map((x) => x.id)).toEqual([g]);
    expect(t.members.map((m) => m.id)).toEqual([a, b]);
    expect(t.summary).toBe("…");
    expect(db.topics(["candidate"]).map((x) => x.id)).toEqual([c.topicId]);
    expect(db.topics(["open"])).toEqual([]);
    expect(db.counts()).toMatchObject({ clusters: 1, topics: 1, candidates: 1, unclustered: 1 });
  });

  it("groups several clusters under one topic; summary has a section per cluster", () => {
    const db = new StateDb(":memory:");
    const topic = db.createTopic({ title: "Dotfiles management", scope: "global", name: "dotfiles-management", declared: true });
    const zsh = db.createCluster({ title: "zsh", summary: "profiles", scope: "global", topicId: topic });
    const tmux = db.createCluster({ title: "tmux", summary: "~/.tmux.conf.local", scope: "global" });
    db.setClusterTopic(tmux, topic);
    db.assignNugget(db.insertNugget(nugget({ sessionId: "a" })), zsh);
    db.assignNugget(db.insertNugget(nugget({ sessionId: "b" })), tmux);

    expect(db.deleteEmptyTopics()).toBe(1); // tmux's original singleton topic
    const t = db.getTopic(topic)!;
    expect(t).toMatchObject({ name: "dotfiles-management", declared: true, locked: false });
    expect(t.clusters.map((c) => c.title)).toEqual(["zsh", "tmux"]);
    expect(t.members).toHaveLength(2);
    expect(t.summary).toBe("### zsh\nprofiles\n\n### tmux\n~/.tmux.conf.local");

    // declared topics survive being empty
    const empty = db.createTopic({ title: "Gradle", scope: "global", declared: true });
    expect(db.deleteEmptyTopics()).toBe(0);
    expect(db.getTopic(empty)!.clusters).toEqual([]);
  });

  it("migrates v3 clusters to singleton topics with the same ids", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lbg-db4-")), "state.db");
    const raw = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m);
    raw.exec("PRAGMA user_version = 3");
    raw.exec(`INSERT INTO cluster (id, title, summary, scope, repo, status, score, target, target_locked, stats, created_at, updated_at)
              VALUES (4, 'Pi config', 'sum', 'global', NULL, 'candidate', 11, 'global:new:pi', 1, '{"sessions":3}', 1, 2),
                     (10, 'Evals', 'sum2', 'repo', '/w/D', 'open', 3, NULL, 0, NULL, 1, 2)`);
    raw.exec(`INSERT INTO nugget (run_id, agent, session_id, cwd, kind, title, knowledge, triggers, scope, confidence, evidence, cluster_id, created_at)
              VALUES (1, 'pi', 's', '/', 'fact', 't', 'k', '[]', 'global', 0.9, '[]', 4, 0)`);
    raw.close();

    const db = new StateDb(path);
    expect(db.topics().map((t) => [t.id, t.title, t.status, t.score, t.target ?? null, t.targetLocked, t.repo ?? null])).toEqual([
      [4, "Pi config", "candidate", 11, "global:new:pi", true, null],
      [10, "Evals", "open", 3, null, false, "/w/D"],
    ]);
    expect(db.getTopic(4)!.members).toHaveLength(1);
    expect(db.getCluster(4)).toMatchObject({ topicId: 4, summary: "sum" });
    // AUTOINCREMENT continues after migrated ids
    expect(db.createTopic({ title: "new", scope: "global" })).toBe(11);
  });

  it("refuses to mix scopes or repos, and bad statuses", () => {
    const db = new StateDb(":memory:");
    const g = db.insertNugget(nugget());
    const r1 = db.insertNugget(nugget({ scope: "repo", repo: "/w/A" }));
    const r2 = db.insertNugget(nugget({ scope: "repo", repo: "/w/B" }));
    const repoA = db.createCluster({ title: "A", summary: "", scope: "repo", repo: "/w/A" });
    const globalTopic = db.createTopic({ title: "G", scope: "global" });

    db.assignNugget(r1, repoA);
    expect(() => db.assignNugget(r2, repoA)).toThrow(/Scope mismatch/);
    expect(() => db.assignNugget(g, repoA)).toThrow(/Scope mismatch/);
    expect(() => db.setClusterTopic(repoA, globalTopic)).toThrow(/Scope mismatch/);
    expect(() => db.createCluster({ title: "x", summary: "", scope: "repo", repo: "/w/A", topicId: globalTopic })).toThrow(/Scope mismatch/);
    expect(() => db.updateTopic(globalTopic, { status: "bogus" as never })).toThrow(/Bad topic status/);
    expect(() => db.updateTopic(999, { score: 1 })).toThrow(/No topic/);
    expect(() => db.updateCluster(999, { title: "x" })).toThrow(/No cluster/);
  });
});

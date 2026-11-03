import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { clusterNuggets } from "../src/pipeline/cluster.ts";
import {
  mergeClusters,
  mergeTopics,
  moveCluster,
  moveNugget,
  renameCluster,
  renameTopic,
  splitTopic,
  unlockTopic,
} from "../src/pipeline/curate.ts";
import { scoreTopics } from "../src/pipeline/score.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";

const nugget = (sessionId: string, over: Partial<NuggetInsert> = {}): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId,
  cwd: "/",
  kind: "fact",
  title: sessionId,
  knowledge: "k",
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: "q" }],
  ...over,
});

/** A cluster in its own topic with one nugget from `session`. */
function seed(db: StateDb, title: string, session: string, over: Partial<NuggetInsert> = {}) {
  const scope = { scope: over.scope ?? "global", ...(over.repo ? { repo: over.repo } : {}) } as const;
  const cluster = db.createCluster({ title, summary: `${title} summary`, ...scope });
  const n = db.insertNugget(nugget(session, over));
  db.assignNugget(n, cluster);
  return { cluster, topic: db.getCluster(cluster)!.topicId, nugget: n };
}

describe("curation", () => {
  it("merges topics: clusters move, empty topics go, everything is locked", () => {
    const db = new StateDb(":memory:");
    const pi = seed(db, "pi config", "a");
    const zsh = seed(db, "zsh", "b");
    const tmux = seed(db, "tmux", "c");

    const res = mergeTopics(db, pi.topic, [zsh.topic, tmux.topic]);
    expect(res).toEqual({ moved: [zsh.cluster, tmux.cluster], deleted: 2 });
    const t = db.getTopic(pi.topic)!;
    expect(t.locked).toBe(true);
    expect(t.clusters.map((c) => [c.title, c.locked])).toEqual([
      ["pi config", false],
      ["zsh", true],
      ["tmux", true],
    ]);
    expect(db.topics()).toHaveLength(1);
  });

  it("refuses merges across scopes/repos (atomically) and of proposed topics", () => {
    const db = new StateDb(":memory:");
    const g = seed(db, "g", "a");
    const g2 = seed(db, "g2", "b");
    const r = seed(db, "r", "c", { scope: "repo", repo: "/w/A" });
    expect(() => mergeTopics(db, g.topic, [g2.topic, r.topic])).toThrow(/Scope mismatch/);
    expect(db.getTopic(g2.topic)).toBeDefined(); // rolled back
    expect(db.getCluster(g2.cluster)!.topicId).toBe(g2.topic);

    db.updateTopic(g2.topic, { status: "proposed" });
    expect(() => mergeTopics(db, g.topic, [g2.topic])).toThrow(/proposed/);
    expect(() => mergeTopics(db, g.topic, [g.topic])).toThrow(/itself/);
  });

  it("splits a topic into a new locked topic", () => {
    const db = new StateDb(":memory:");
    const a = seed(db, "a", "s1");
    const b = seed(db, "b", "s2");
    mergeTopics(db, a.topic, [b.topic]);
    const created = splitTopic(db, a.topic, [b.cluster], "B topic");
    expect(db.getTopic(created)).toMatchObject({ title: "B topic", locked: true });
    expect(db.getTopic(created)!.clusters.map((c) => c.id)).toEqual([b.cluster]);
    expect(() => splitTopic(db, a.topic, [a.cluster])).toThrow(/leave at least one/);
    expect(() => splitTopic(db, a.topic, [b.cluster])).toThrow(/not in topic/);
  });

  it("renames topics and clusters; validates skill names", () => {
    const db = new StateDb(":memory:");
    const a = seed(db, "Pi config", "s");
    renameTopic(db, a.topic, { title: "Dotfiles management", name: "dotfiles-management" });
    expect(db.getTopic(a.topic)).toMatchObject({ title: "Dotfiles management", name: "dotfiles-management", locked: true });
    expect(() => renameTopic(db, a.topic, { name: "Dotfiles Mgmt" })).toThrow(/lowercase/);
    renameCluster(db, a.cluster, "pi and opencode");
    expect(db.getCluster(a.cluster)).toMatchObject({ title: "pi and opencode", locked: true });
  });

  it("moves clusters and nuggets, cleaning up what's left empty", () => {
    const db = new StateDb(":memory:");
    const a = seed(db, "a", "s1");
    const b = seed(db, "b", "s2");
    moveCluster(db, b.cluster, a.topic);
    expect(db.getTopic(b.topic)).toBeUndefined();
    expect(db.getTopic(a.topic)!.clusters.map((c) => c.id)).toEqual([a.cluster, b.cluster]);

    moveNugget(db, b.nugget, a.cluster);
    expect(db.getCluster(b.cluster)).toBeUndefined(); // emptied → deleted
    expect(db.getNugget(b.nugget)).toMatchObject({ clusterId: a.cluster, assignmentLocked: true });
  });

  it("merges clusters: members move (locked), summaries concatenate", () => {
    const db = new StateDb(":memory:");
    const a = seed(db, "zsh", "s1");
    const b = seed(db, "shell PATH", "s2");
    mergeClusters(db, a.cluster, [b.cluster]);
    const c = db.getCluster(a.cluster)!;
    expect(c.members.map((m) => [m.id, m.assignmentLocked])).toEqual([
      [a.nugget, false],
      [b.nugget, true],
    ]);
    expect(c.summary).toBe("zsh summary\n\n### shell PATH\nshell PATH summary");
    expect(db.getCluster(b.cluster)).toBeUndefined();
    expect(db.getTopic(b.topic)).toBeUndefined();
  });

  it("curated structure survives clustering and scoring; unlock clears locks", async () => {
    const db = new StateDb(":memory:");
    const a = seed(db, "pi config", "s1");
    const b = seed(db, "zsh", "s2");
    const c = seed(db, "tmux", "s3");
    mergeTopics(db, a.topic, [b.topic, c.topic]);
    renameTopic(db, a.topic, { title: "Dotfiles", name: "dotfiles-management" });

    // a new nugget gets its own cluster/topic; the curated topic is untouched
    db.insertNugget(nugget("s4", { title: "unrelated" }));
    const runner: PiRunner = {
      async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
        const id = Number(/<nugget id="(\d+)"/.exec(req.prompt)![1]);
        return {
          value: { newClusters: [{ key: "k", title: "unrelated", summary: "s" }], assignments: [{ nuggetId: id, newClusterKey: "k" }], updatedClusters: [] } as Static<S>,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        };
      },
    };
    await clusterNuggets(db, runner, DEFAULT_CONFIG);
    const r = scoreTopics(db, [], DEFAULT_CONFIG.score);
    expect(r.promoted).toEqual([{ id: a.topic, title: "Dotfiles", target: "global:new:dotfiles-management", score: 9 }]);
    const t = db.getTopic(a.topic)!;
    expect(t.clusters.map((x) => x.title)).toEqual(["pi config", "zsh", "tmux"]);
    expect(t.locked).toBe(true);

    unlockTopic(db, a.topic);
    const u = db.getTopic(a.topic)!;
    expect([u.locked, u.targetLocked, ...u.clusters.map((x) => x.locked), ...u.members.map((m) => m.assignmentLocked)].every((x) => !x)).toBe(true);
  });
});

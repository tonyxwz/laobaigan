import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { clusterNuggets, clusterSystemPrompt, partitionKey, validatePlan, type AssignResult } from "../src/pipeline/cluster.ts";
import { syncDeclaredTopics, titleFromName } from "../src/pipeline/topics.ts";
import type { Config } from "../src/config.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";

const nugget = (title: string, over: Partial<NuggetInsert> = {}): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId: title,
  cwd: "/r",
  kind: "fact",
  title,
  knowledge: `${title} knowledge`,
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: "q" }],
  ...over,
});

/** Returns canned answers in order, recording prompts. */
class ScriptedRunner implements PiRunner {
  prompts: string[] = [];
  systemPrompts: string[] = [];
  private answers: ((prompt: string) => AssignResult)[];
  constructor(answers: ((prompt: string) => AssignResult)[]) {
    this.answers = answers;
  }
  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    this.prompts.push(req.prompt);
    this.systemPrompts.push(req.systemPrompt);
    const next = this.answers.shift();
    if (!next) throw new Error("unexpected call");
    return { value: next(req.prompt) as Static<S>, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 } };
  }
}

const ids = (prompt: string) => [...prompt.matchAll(/<nugget id="(\d+)"/g)].map((m) => Number(m[1]));

describe("clusterNuggets", () => {
  it("groups by partition, never mixing global and repos; solo partitions need no model call", async () => {
    const db = new StateDb(":memory:");
    const b1 = db.insertNugget(nugget("make release"));
    const b2 = db.insertNugget(nugget("git worktree, not git worktree", { agent: "claude" }));
    const t = db.insertNugget(nugget("tmux conf lives in ~/.tmux.conf.local"));
    const r = db.insertNugget(nugget("Pkg uses hatch", { scope: "repo", repo: "/w/Pkg" }));

    const runner = new ScriptedRunner([
      (p) => {
        expect(ids(p).sort()).toEqual([b1, b2, t]); // only the global partition
        return {
          newClusters: [
            { key: "gradle", title: "Build and worktree workflow", summary: "use make; git worktree" },
            { key: "tmux", title: "tmux", summary: "~/.tmux.conf.local" },
          ],
          assignments: [
            { nuggetId: b1, newClusterKey: "gradle" },
            { nuggetId: b2, newClusterKey: "gradle" },
            { nuggetId: t, newClusterKey: "tmux" },
          ],
          updatedClusters: [],
        };
      },
    ]);
    const res = await clusterNuggets(db, runner, DEFAULT_CONFIG);
    expect(res).toMatchObject({ calls: 1, created: 3, assigned: 4 });

    const clusters = db.clusters();
    expect(clusters.map((c) => [c.title, partitionKey(c), c.members.map((m) => m.id)])).toEqual([
      ["Build and worktree workflow", "global", [b1, b2]],
      ["tmux", "global", [t]],
      ["Pkg uses hatch", "repo:/w/Pkg", [r]],
    ]);

    // Re-run with nothing new: no calls, no changes.
    const again = await clusterNuggets(db, runner, DEFAULT_CONFIG);
    expect(again).toMatchObject({ calls: 0, created: 0, assigned: 0 });
  });

  it("assigns new nuggets to existing clusters and updates their summary", async () => {
    const db = new StateDb(":memory:");
    const a = db.insertNugget(nugget("a"));
    const c = db.createCluster({ title: "Gradle", summary: "old", scope: "global" });
    db.assignNugget(a, c);
    const n = db.insertNugget(nugget("make release, again", { agent: "opencode" }));

    const runner = new ScriptedRunner([
      (p) => {
        expect(p).toContain(`<cluster id="${c}" members="1">`);
        return { newClusters: [], assignments: [{ nuggetId: n, clusterId: c }], updatedClusters: [{ clusterId: c, summary: "new" }] };
      },
    ]);
    await clusterNuggets(db, runner, DEFAULT_CONFIG);
    expect(db.getCluster(c)).toMatchObject({ summary: "new" });
    expect(db.getCluster(c)!.members.map((m) => m.id)).toEqual([a, n]);
  });

  it("later batches see clusters created by earlier batches", async () => {
    const db = new StateDb(":memory:");
    const n = [1, 2, 3].map((i) => db.insertNugget(nugget(`n${i}`)));
    const runner = new ScriptedRunner([
      (p) => ({ newClusters: [{ key: "k", title: "T", summary: "s" }], assignments: ids(p).map((nuggetId) => ({ nuggetId, newClusterKey: "k" })), updatedClusters: [] }),
      (p) => {
        const existing = Number(/<cluster id="(\d+)"/.exec(p)![1]);
        return { newClusters: [], assignments: ids(p).map((nuggetId) => ({ nuggetId, clusterId: existing })), updatedClusters: [] };
      },
    ]);
    await clusterNuggets(db, runner, DEFAULT_CONFIG, { batchSize: 2 });
    expect(db.clusters().map((c) => c.members.map((m) => m.id))).toEqual([n]);
  });

  it("respects the call budget, leaving the rest unclustered", async () => {
    const db = new StateDb(":memory:");
    for (const i of [1, 2, 3, 4]) db.insertNugget(nugget(`n${i}`));
    const runner = new ScriptedRunner([
      (p) => ({ newClusters: [{ key: "k", title: "T", summary: "s" }], assignments: ids(p).map((nuggetId) => ({ nuggetId, newClusterKey: "k" })), updatedClusters: [] }),
    ]);
    const res = await clusterNuggets(db, runner, DEFAULT_CONFIG, { batchSize: 2, maxCalls: 1 });
    expect(res.calls).toBe(1);
    expect(db.unclusteredNuggets()).toHaveLength(2);
  });
});

describe("validatePlan", () => {
  it("repairs missing, duplicate, and invalid assignments", () => {
    const db = new StateDb(":memory:");
    const [a, b, c, d] = [1, 2, 3, 4].map((i) => db.insertNugget(nugget(`n${i}`)));
    const nuggets = db.unclusteredNuggets();
    const plan = validatePlan(
      "global",
      {
        newClusters: [{ key: "k", title: "T", summary: "s" }],
        assignments: [
          { nuggetId: a!, newClusterKey: "k" },
          { nuggetId: a!, clusterId: 99 }, // duplicate
          { nuggetId: b!, clusterId: 99 }, // unknown cluster
          { nuggetId: 12345, newClusterKey: "k" }, // unknown nugget
          { nuggetId: c!, newClusterKey: "nope" }, // unknown key
        ],
        updatedClusters: [{ clusterId: 99, summary: "x" }],
      },
      nuggets,
      [],
    );
    expect(plan.newClusters.map((x) => x.nuggetIds)).toEqual([[a], [b], [c], [d]]);
    expect(plan.updatedClusters).toEqual([]);
    expect(plan.repairs.length).toBeGreaterThanOrEqual(6);
  });
});

describe("StateDb.snapshotTo", () => {
  it("produces an independent copy", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "lbg-snap-"));
    const db = new StateDb(join(dir, "a.db"));
    db.insertNugget(nugget("x"));
    const copy = db.snapshotTo(join(dir, "b.db"));
    copy.createCluster({ title: "only in copy", summary: "", scope: "global" });
    expect(db.counts().clusters).toBe(0);
    expect(copy.counts()).toMatchObject({ clusters: 1, nuggets: 1 });
  });
});

const DOTFILES = {
  name: "dotfiles-management",
  description: "~/.cfg bare repo (ddd alias), zsh profiles, tmux, mise/Homebrew, agent configs for pi/opencode/Claude Code",
};

describe("declared topics", () => {
  it("syncs config.topics: create, update, un-declare", () => {
    const db = new StateDb(":memory:");
    expect(syncDeclaredTopics(db, [DOTFILES]).created).toEqual(["dotfiles-management"]);
    const t = db.topics()[0]!;
    expect(t).toMatchObject({ name: "dotfiles-management", title: "Dotfiles management", declared: true, description: DOTFILES.description });
    expect(titleFromName("makes")).toBe("Gradle builds");

    // unchanged → no-op; changed description → updated
    expect(syncDeclaredTopics(db, [DOTFILES])).toEqual({ created: [], updated: [], undeclared: [] });
    expect(syncDeclaredTopics(db, [{ ...DOTFILES, description: "dotfiles" }]).updated).toEqual(["dotfiles-management"]);

    // removed from config: an empty topic disappears; one with clusters stays as an ordinary topic
    const c = db.createCluster({ title: "tmux", summary: "s", scope: "global", topicId: t.id });
    db.assignNugget(db.insertNugget(nugget("tmux")), c);
    expect(syncDeclaredTopics(db, []).undeclared).toEqual(["dotfiles-management"]);
    expect(db.getTopic(t.id)).toMatchObject({ declared: false, name: "dotfiles-management" });
    // re-declaring adopts the same topic (matched by name)
    syncDeclaredTopics(db, [DOTFILES]);
    expect(db.topics().map((x) => [x.id, x.declared])).toEqual([[t.id, true]]);
  });

  it("offers declared topics (with description) as homes and appends guidance", async () => {
    const db = new StateDb(":memory:");
    const zsh = db.insertNugget(nugget("zsh profiles gated by hostname"));
    const tmux = db.insertNugget(nugget("tmux config lives in ~/.tmux.conf.local"));
    const cfg: Config = { ...DEFAULT_CONFIG, topics: [DOTFILES], clustering: { guidance: "Prefer one umbrella skill per ecosystem." } };

    const runner = new ScriptedRunner([
      (p) => {
        const dot = Number(/<topic id="(\d+)" name="dotfiles-management" declared="yes">/.exec(p)![1]);
        expect(p).toContain(`description: ${DOTFILES.description}`);
        expect(p).toContain("(no clusters yet)");
        return {
          newClusters: [
            { key: "z", title: "zsh", summary: "zsh", topicId: dot },
            { key: "t", title: "tmux", summary: "tmux", topicId: dot },
          ],
          assignments: [
            { nuggetId: zsh, newClusterKey: "z" },
            { nuggetId: tmux, newClusterKey: "t" },
          ],
          updatedClusters: [],
        };
      },
    ]);
    await clusterNuggets(db, runner, cfg);
    expect(runner.systemPrompts[0]).toContain("Guidance from the engineer (follow it):\nPrefer one umbrella skill per ecosystem.");
    expect(runner.systemPrompts[0]).not.toContain("ssh-agent"); // old "keep separate" example is gone

    const topics = db.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ name: "dotfiles-management", declared: true });
    expect(topics[0]!.clusters.map((c) => c.title)).toEqual(["zsh", "tmux"]);
  });

  it("asks the model even for a single nugget when a declared topic exists", async () => {
    const db = new StateDb(":memory:");
    const n = db.insertNugget(nugget("tmux"));
    const runner = new ScriptedRunner([
      (p) => {
        const dot = Number(/<topic id="(\d+)"/.exec(p)![1]);
        return { newClusters: [{ key: "t", title: "tmux", summary: "s", topicId: dot }], assignments: [{ nuggetId: n, newClusterKey: "t" }], updatedClusters: [] };
      },
    ]);
    await clusterNuggets(db, runner, { ...DEFAULT_CONFIG, topics: [DOTFILES] });
    expect(runner.prompts).toHaveLength(1);
    expect(db.topics()[0]!.clusters).toHaveLength(1);
  });

  it("repairs an unknown topicId by starting a new topic", () => {
    const db = new StateDb(":memory:");
    const n = db.insertNugget(nugget("x"));
    const plan = validatePlan(
      "global",
      { newClusters: [{ key: "k", title: "T", summary: "s", topicId: 999 }], assignments: [{ nuggetId: n, newClusterKey: "k" }], updatedClusters: [] },
      db.unclusteredNuggets(),
      [],
    );
    expect(plan.newClusters[0]!.topicId).toBeUndefined();
    expect(plan.repairs).toContain("new cluster k: unknown topic 999; new topic");
  });

  it("keeps the base prompt when there is no guidance", () => {
    expect(clusterSystemPrompt("  ")).toBe(clusterSystemPrompt());
  });
});

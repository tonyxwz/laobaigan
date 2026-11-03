import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { clusterNuggets, partitionKey, validatePlan, type AssignResult } from "../src/pipeline/cluster.ts";
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
  private answers: ((prompt: string) => AssignResult)[];
  constructor(answers: ((prompt: string) => AssignResult)[]) {
    this.answers = answers;
  }
  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    this.prompts.push(req.prompt);
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

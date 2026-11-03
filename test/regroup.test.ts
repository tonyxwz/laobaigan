import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { mergeTopics } from "../src/pipeline/curate.ts";
import { regroup, validateRegroup, type RegroupResult } from "../src/pipeline/regroup.ts";
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

function seed(db: StateDb, title: string, session: string, over: Partial<NuggetInsert> = {}) {
  const scope = { scope: over.scope ?? "global", ...(over.repo ? { repo: over.repo } : {}) } as const;
  const cluster = db.createCluster({ title, summary: `${title} summary`, ...scope });
  db.assignNugget(db.insertNugget(nugget(session, over)), cluster);
  return { cluster, topic: db.getCluster(cluster)!.topicId };
}

class Scripted implements PiRunner {
  prompts: string[] = [];
  private answers: ((p: string) => RegroupResult)[];
  constructor(answers: ((p: string) => RegroupResult)[]) {
    this.answers = answers;
  }
  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    this.prompts.push(req.prompt);
    const next = this.answers.shift();
    if (!next) throw new Error("unexpected call");
    return { value: next(req.prompt) as Static<S>, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 } };
  }
}

const DOT = { name: "dotfiles-management", description: "~/.cfg, zsh, tmux, agent configs" };

describe("regroup", () => {
  it("moves clusters under a declared topic; others stay; empty topics go", async () => {
    const db = new StateDb(":memory:");
    const zsh = seed(db, "zsh profiles", "a");
    const tmux = seed(db, "tmux", "b");
    const pi = seed(db, "pi config", "c");
    const evals = seed(db, "evals", "d");
    const cfg: Config = { ...DEFAULT_CONFIG, topics: [DOT] };

    const runner = new Scripted([
      (p) => {
        const dot = Number(/<topic id="(\d+)" name="dotfiles-management" declared="yes" home="yes">/.exec(p)![1]);
        expect(p).toContain(`<cluster id="${zsh.cluster}" movable="yes"`);
        return { newTopics: [], placements: [zsh, tmux, pi].map((x) => ({ clusterId: x.cluster, topicId: dot })) };
      },
    ]);
    const res = await regroup(db, runner, cfg);
    expect(res).toMatchObject({ calls: 1, moved: 3, topicsCreated: 0 });
    const topics = db.topics();
    expect(topics.map((t) => [t.name ?? t.title, t.clusters.map((c) => c.title)])).toEqual([
      ["evals", ["evals"]],
      ["dotfiles-management", ["zsh profiles", "tmux", "pi config"]],
    ]);
    expect(db.getTopic(evals.topic)).toBeDefined();
  });

  it("gathers clusters under a new umbrella topic (never a single-cluster one)", () => {
    const db = new StateDb(":memory:");
    const a = seed(db, "zsh", "a");
    const b = seed(db, "tmux", "b");
    const c = seed(db, "gradle", "c");
    const plan = validateRegroup(
      "global",
      {
        newTopics: [
          { key: "dot", title: "Dotfiles", name: "dotfiles" },
          { key: "solo", title: "Gradle", name: "Bad Name" },
        ],
        placements: [
          { clusterId: a.cluster, newTopicKey: "dot" },
          { clusterId: b.cluster, newTopicKey: "dot" },
          { clusterId: c.cluster, newTopicKey: "solo" },
        ],
      },
      db.topics(),
    );
    expect(plan.newTopics).toEqual([{ key: "dot", title: "Dotfiles", name: "dotfiles", clusterIds: [a.cluster, b.cluster] }]);
    expect(plan.repairs).toEqual(["new topic solo: invalid skill name Bad Name; dropped", "new topic solo would hold one cluster; not created"]);
  });

  it("never moves locked clusters/topics or clusters of proposed topics, and never into proposed topics", () => {
    const db = new StateDb(":memory:");
    const a = seed(db, "a", "s1");
    const b = seed(db, "b", "s2");
    mergeTopics(db, a.topic, [b.topic]); // curated: topic a locked, cluster b locked
    const p = seed(db, "p", "s3");
    db.updateTopic(p.topic, { status: "proposed" });
    const free = seed(db, "free", "s4");

    const plan = validateRegroup(
      "global",
      {
        newTopics: [],
        placements: [
          { clusterId: a.cluster, topicId: free.topic }, // in locked topic
          { clusterId: b.cluster, topicId: free.topic }, // locked cluster
          { clusterId: p.cluster, topicId: free.topic }, // proposed topic
          { clusterId: free.cluster, topicId: p.topic }, // into proposed topic
          { clusterId: free.cluster, topicId: a.topic }, // ok: locked topics may receive
        ],
      },
      db.topics(),
    );
    expect(plan.moves).toEqual([{ clusterId: free.cluster, topicId: a.topic }]);
    expect(plan.repairs).toHaveLength(4);
  });

  it("makes no call when there is nothing to decide, and never mixes partitions", async () => {
    const db = new StateDb(":memory:");
    seed(db, "only", "a");
    seed(db, "repo thing", "b", { scope: "repo", repo: "/w/A" });
    const runner = new Scripted([]);
    expect(await regroup(db, runner, DEFAULT_CONFIG)).toMatchObject({ calls: 0, moved: 0 });

    seed(db, "other", "c");
    const r2 = new Scripted([
      (p) => {
        expect(p).not.toContain("repo thing");
        return { newTopics: [], placements: [] };
      },
    ]);
    expect(await regroup(db, r2, DEFAULT_CONFIG)).toMatchObject({ calls: 1, moved: 0 });
  });
});

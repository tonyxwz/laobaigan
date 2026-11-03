import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  topicStats,
  formatTarget,
  meetsPromotion,
  parseTarget,
  pickTarget,
  scoreTopics,
  scoreOf,
  similarity,
  skillName,
  type Target,
} from "../src/pipeline/score.ts";
import type { SkillInfo } from "../src/skills/index.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";

const S = DEFAULT_CONFIG.score;

const nugget = (over: Partial<NuggetInsert> = {}): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId: "s1",
  cwd: "/r",
  kind: "fact",
  title: "t",
  knowledge: "k",
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: "q", ts: "2026-01-01T10:00:00.000Z" }],
  ...over,
});

/** Build a cluster (in its own topic, or `topicId`) from nugget overrides; returns the topic plus clusterId. */
function cluster(
  db: StateDb,
  title: string,
  summary: string,
  members: Partial<NuggetInsert>[],
  scope: "global" | "repo" = "global",
  repo?: string,
  topicId?: number,
) {
  const id = db.createCluster({ title, summary, scope, ...(repo ? { repo } : {}), ...(topicId ? { topicId } : {}) });
  for (const m of members) db.assignNugget(db.insertNugget(nugget({ scope, ...(repo ? { repo } : {}), ...m })), id);
  return { ...db.getTopic(db.getCluster(id)!.topicId)!, clusterId: id };
}

const skills: SkillInfo[] = [
  { name: "git-worktree", description: "Create and manage isolated parallel multi-package workspaces with git worktree", path: "", scope: "global" },
  { name: "cloud-credentials", description: "obtaining temporary cloud credentials with vault login", path: "", scope: "global" },
];

describe("stats and score", () => {
  it("counts distinct sessions, agents, days, corrections, coverage", () => {
    const db = new StateDb(":memory:");
    const c = cluster(db, "T", "s", [
      { sessionId: "a", kind: "correction" },
      { sessionId: "a" }, // same session
      { agent: "claude", sessionId: "b", evidence: [{ label: "U2", quote: "", ts: "2026-01-03T00:00:00.000Z" }] },
      { sessionId: "c", coveredBy: "git-worktree" },
    ]);
    const st = topicStats(c);
    expect(st).toMatchObject({ nuggets: 4, sessions: 3, agents: ["claude", "pi"], days: 2, corrections: 1, coveredBy: ["git-worktree"] });
    expect(st.firstSeen).toBe("2026-01-01T10:00:00.000Z");
    // 3*3 + 1*3 + 1*1 + 1*1 - 2
    expect(scoreOf(st, S.weights)).toBe(12);
  });

  it("promotes at 3 sessions, or 2 across agents", () => {
    const base = { nuggets: 0, days: 1, corrections: 0, coveredBy: [] };
    expect(meetsPromotion({ ...base, sessions: 3, agents: ["pi"] }, S.promote)).toBe(true);
    expect(meetsPromotion({ ...base, sessions: 2, agents: ["pi"] }, S.promote)).toBe(false);
    expect(meetsPromotion({ ...base, sessions: 2, agents: ["claude", "pi"] }, S.promote)).toBe(true);
    expect(meetsPromotion({ ...base, sessions: 1, agents: ["claude", "pi"] }, S.promote)).toBe(false);
  });
});

describe("targets", () => {
  it("round-trips target strings, including repo paths with colons", () => {
    const ts: Target[] = [
      { kind: "global:new", name: "makes" },
      { kind: "global:update", skill: "git-worktree" },
      { kind: "global:fix-description", skill: "git-worktree" },
      { kind: "repo:agents-md", repo: "/w/Pkg" },
      { kind: "repo:skill", repo: "/w/a:b", name: "run-evals" },
    ];
    for (const t of ts) expect(parseTarget(formatTarget(t))).toEqual(t);
  });

  it("makes valid skill names", () => {
    expect(skillName("Pi and OpenCode configuration and shared skills")).toBe("pi-opencode-configuration-shared-skills");
    expect(skillName("!!!")).toBe("skill");
    expect(skillName("x".repeat(100)).length).toBeLessThanOrEqual(64);
    expect(skillName("Gradle: builds & worktrees")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("measures token overlap", () => {
    expect(similarity("git worktree workspaces", "use git worktree not git worktree")).toBe(2 / 3);
    expect(similarity("tmux", "")).toBe(0);
    expect(similarity("Pi and OpenCode configuration", "manage gradle workspaces and worktrees")).toBe(0); // stopwords only
    expect(similarity("aws credentials", "aws account")).toBe(0); // one shared word is noise
  });

  it("global: fix-description when most members are covered by a real skill", () => {
    const db = new StateDb(":memory:");
    const c = cluster(db, "multi-package workspace isolation", "use git worktree", [{ coveredBy: "git-worktree" }]);
    expect(pickTarget(c, skills, S)).toEqual({ kind: "global:fix-description", skill: "git-worktree" });
  });

  it("global: update when a minority is covered, or the topic is similar to a skill", () => {
    const db = new StateDb(":memory:");
    const partial = cluster(db, "X", "y", [{ coveredBy: "git-worktree" }, {}, {}]);
    expect(pickTarget(partial, skills, S)).toEqual({ kind: "global:update", skill: "git-worktree" });
    const similar = cluster(db, "AWS credentials for accounts", "use a credential helper to get temporary credentials for an account", [{}]);
    expect(pickTarget(similar, skills, S)).toEqual({ kind: "global:update", skill: "cloud-credentials" });
  });

  it("global: a named topic targets its own name, whatever its members are covered by", () => {
    const db = new StateDb(":memory:");
    const t = cluster(db, "Dotfiles", "x", [{ coveredBy: "git-worktree" }, {}]);
    expect(pickTarget({ ...t, name: "dotfiles-management" }, skills, S)).toEqual({ kind: "global:new", name: "dotfiles-management" });
    expect(pickTarget({ ...t, name: "git-worktree" }, skills, S)).toEqual({ kind: "global:update", skill: "git-worktree" });
  });

  it("global: new for unrelated topics; unverified coverage (?name) doesn't count", () => {
    const db = new StateDb(":memory:");
    const c = cluster(db, "User tmux configuration", "custom config lives in ~/.tmux.conf.local", [{ coveredBy: "?tmux" }]);
    expect(pickTarget(c, skills, S)).toEqual({ kind: "global:new", name: "user-tmux-configuration" });
  });

  it("repo: AGENTS.md for short facts, repo skill for long procedures", () => {
    const db = new StateDb(":memory:");
    const short = cluster(db, "Pkg build", "uses hatch", [{}], "repo", "/w/Pkg");
    expect(pickTarget(short, skills, S)).toEqual({ kind: "repo:agents-md", repo: "/w/Pkg" });
    const long = cluster(db, "Run evaluations", "step ".repeat(400), [{ kind: "procedure" }, { kind: "procedure" }, {}], "repo", "/w/Pkg");
    expect(pickTarget(long, skills, S)).toEqual({ kind: "repo:skill", repo: "/w/Pkg", name: "run-evaluations" });
  });
});

describe("scoreTopics", () => {
  it("promotes eligible topics once, keeps proposed ones, re-promotes grown rejections", () => {
    const db = new StateDb(":memory:");
    const three = cluster(db, "Pi and OpenCode configuration", "s", [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
    const cross = cluster(db, "Evals", "s", [{ sessionId: "a" }, { agent: "claude", sessionId: "z" }], "repo", "/w/D");
    const solo = cluster(db, "tmux", "s", [{ sessionId: "a" }]);
    const proposed = cluster(db, "P", "s", [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
    db.updateTopic(proposed.id, { status: "proposed", target: "global:new:p" });
    const rejected = cluster(db, "R", "s", [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
    db.updateTopic(rejected.id, { status: "rejected", rejectedSessions: 3 });

    const r1 = scoreTopics(db, skills, S);
    expect(r1.promoted.map((p) => [p.id, p.target])).toEqual([
      [three.id, "global:new:pi-opencode-configuration"],
      [cross.id, "repo:agents-md:/w/D"],
    ]);
    expect(db.getTopic(solo.id)).toMatchObject({ status: "open", score: 3 });
    expect(db.getTopic(proposed.id)).toMatchObject({ status: "proposed", target: "global:new:p" });
    expect(db.getTopic(rejected.id)!.status).toBe("rejected");

    // idempotent: nothing newly promoted
    expect(scoreTopics(db, skills, S).promoted).toEqual([]);

    // a hand-set target survives re-scoring
    db.updateTopic(three.id, { target: "global:update:git-worktree", targetLocked: true });
    scoreTopics(db, skills, S);
    expect(db.getTopic(three.id)!.target).toBe("global:update:git-worktree");

    // the rejected topic comes up in 2 more sessions → candidate again
    for (const s of ["d", "e"]) db.assignNugget(db.insertNugget(nugget({ sessionId: s })), rejected.clusterId);
    expect(scoreTopics(db, skills, S).promoted.map((p) => p.id)).toEqual([rejected.id]);
  });

  it("scores a topic on the union of its clusters (umbrella topics surface)", () => {
    const db = new StateDb(":memory:");
    // Three one-session clusters: none is promotable on its own…
    const zsh = cluster(db, "zsh profiles", "s", [{ sessionId: "a" }]);
    const tmux = cluster(db, "tmux", "s", [{ sessionId: "b" }]);
    const pi = cluster(db, "pi config", "s", [{ sessionId: "c" }]);
    expect(scoreTopics(db, skills, S).promoted).toEqual([]);

    // …but under one declared topic they are 3 sessions → promoted, named by the declaration.
    const dot = db.createTopic({ title: "Dotfiles management", name: "dotfiles-management", scope: "global", declared: true });
    for (const c of [zsh, tmux, pi]) db.setClusterTopic(c.clusterId, dot);
    db.deleteEmptyTopics();
    const res = scoreTopics(db, skills, S);
    expect(res.promoted).toEqual([{ id: dot, title: "Dotfiles management", target: "global:new:dotfiles-management", score: 9 }]);
    expect(db.getTopic(dot)!.stats).toMatchObject({ sessions: 3, nuggets: 3 });
    expect(db.topics().map((t) => t.id)).toEqual([dot]);
  });

  it("never promotes empty (declared) topics", () => {
    const db = new StateDb(":memory:");
    db.createTopic({ title: "Gradle", scope: "global", declared: true });
    expect(scoreTopics(db, skills, { ...S, promote: { ...S.promote, minSessions: 0 } }).promoted).toEqual([]);
  });
});

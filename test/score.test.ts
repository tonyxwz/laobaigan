import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  clusterStats,
  formatTarget,
  meetsPromotion,
  parseTarget,
  pickTarget,
  scoreClusters,
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

/** Build a cluster from nugget overrides and return it with members. */
function cluster(db: StateDb, title: string, summary: string, members: Partial<NuggetInsert>[], scope: "global" | "repo" = "global", repo?: string) {
  const id = db.createCluster({ title, summary, scope, ...(repo ? { repo } : {}) });
  for (const m of members) db.assignNugget(db.insertNugget(nugget({ scope, ...(repo ? { repo } : {}), ...m })), id);
  return db.getCluster(id)!;
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
    const st = clusterStats(c);
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

describe("scoreClusters", () => {
  it("promotes eligible clusters once, keeps proposed ones, re-promotes grown rejections", () => {
    const db = new StateDb(":memory:");
    const three = cluster(db, "Pi and OpenCode configuration", "s", [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
    const cross = cluster(db, "Evals", "s", [{ sessionId: "a" }, { agent: "claude", sessionId: "z" }], "repo", "/w/D");
    const solo = cluster(db, "tmux", "s", [{ sessionId: "a" }]);
    const proposed = cluster(db, "P", "s", [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
    db.updateCluster(proposed.id, { status: "proposed", target: "global:new:p" });
    const rejected = cluster(db, "R", "s", [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
    db.updateCluster(rejected.id, { status: "rejected", rejectedSessions: 3 });

    const r1 = scoreClusters(db, skills, S);
    expect(r1.promoted.map((p) => [p.id, p.target])).toEqual([
      [three.id, "global:new:pi-opencode-configuration"],
      [cross.id, "repo:agents-md:/w/D"],
    ]);
    expect(db.getCluster(solo.id)).toMatchObject({ status: "open", score: 3 });
    expect(db.getCluster(proposed.id)).toMatchObject({ status: "proposed", target: "global:new:p" });
    expect(db.getCluster(rejected.id)!.status).toBe("rejected");

    // idempotent: nothing newly promoted
    expect(scoreClusters(db, skills, S).promoted).toEqual([]);

    // a hand-set target survives re-scoring
    db.updateCluster(three.id, { target: "global:update:git-worktree", targetLocked: true });
    scoreClusters(db, skills, S);
    expect(db.getCluster(three.id)!.target).toBe("global:update:git-worktree");

    // the rejected topic comes up in 2 more sessions → candidate again
    for (const s of ["d", "e"]) db.assignNugget(db.insertNugget(nugget({ sessionId: s })), rejected.id);
    expect(scoreClusters(db, skills, S).promoted.map((p) => p.id)).toEqual([rejected.id]);
  });
});

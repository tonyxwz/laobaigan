import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { evidenceStats, evidenceText, meetsPromotion, scoreOf, skillName } from "../src/pipeline/stats.ts";
import type { NuggetRow } from "../src/state/db.ts";

const S = DEFAULT_CONFIG.score;
const n = (over: Partial<NuggetRow>): NuggetRow => ({
  id: 1,
  runId: 1,
  agent: "pi",
  sessionId: "s",
  cwd: "/",
  kind: "fact",
  title: "t",
  knowledge: "k",
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: "q", ts: "2026-01-01T10:00:00.000Z" }],
  assignmentLocked: false,
  createdAt: new Date(0),
  ...over,
});

describe("stats", () => {
  it("counts distinct sessions, agents, days, corrections", () => {
    const st = evidenceStats({
      members: [
        n({ sessionId: "a", kind: "correction" }),
        n({ sessionId: "a" }),
        n({ agent: "claude", sessionId: "b", evidence: [{ label: "U2", quote: "", ts: "2026-01-03T00:00:00.000Z" }] }),
        n({ sessionId: "c", evidence: [] }), // falls back to createdAt (1970-01-01)
      ],
    });
    expect(st).toMatchObject({ nuggets: 4, sessions: 3, agents: ["claude", "pi"], days: 3, corrections: 1, firstSeen: "1970-01-01T00:00:00.000Z" });
    // 3*3 + 1*3 + 2*1 + 1*1
    expect(scoreOf(st, S.weights)).toBe(15);
  });

  it("promotes at 3 sessions, or 2 across agents", () => {
    const base = { nuggets: 0, days: 1, corrections: 0, coveredBy: [] };
    expect(meetsPromotion({ ...base, sessions: 3, agents: ["pi"] }, S.promote)).toBe(true);
    expect(meetsPromotion({ ...base, sessions: 2, agents: ["pi"] }, S.promote)).toBe(false);
    expect(meetsPromotion({ ...base, sessions: 2, agents: ["claude", "pi"] }, S.promote)).toBe(true);
  });

  it("makes valid skill names", () => {
    expect(skillName("Pi and OpenCode configuration and shared skills")).toBe("pi-opencode-configuration-shared-skills");
    expect(skillName("!!!")).toBe("skill");
    expect(skillName("x".repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it("collects everything known about a topic", () => {
    const t = evidenceText({ title: "T", summary: "S", members: [n({ title: "nt", knowledge: "nk", cwd: "/w/Pkg" })] });
    for (const x of ["T", "S", "nt", "nk", "/w/Pkg", "q"]) expect(t).toContain(x);
  });
});

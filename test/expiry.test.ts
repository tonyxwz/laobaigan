import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { rejectProposal } from "../src/pipeline/accept.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import { isExpired, Rejections } from "../src/state/rejections.ts";
import { setup as proposalSetup } from "./proposals.test.ts";

const DAY = 86400e3;

function setup() {
  const s = proposalSetup();
  const p = s.props.create(s.draft());
  s.props.markOpen(p, [], "d");
  return { ...s, p, mem: new Rejections(s.db) };
}

describe("rejection memory expiry", () => {
  it("not-useful expires after expireDays; other kinds don't", () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.p, "noise", { kind: "not-useful" });
    const m = s.mem.mustGet(memoryId);
    expect(m.expiresAt!.getTime() - m.createdAt.getTime()).toBe(90 * DAY);
    for (const kind of ["outdated", "wrong-place", "later"] as const) {
      const t = setup();
      expect(t.mem.mustGet(rejectProposal(t.tree, t.p, "x", { kind }).memoryId).expiresAt).toBeUndefined();
    }
    const never = setup();
    expect(never.mem.mustGet(rejectProposal(never.tree, never.p, "x", { kind: "not-useful", expireDays: 0 }).memoryId).expiresAt).toBeUndefined();
  });

  it("an expired memory stops applying (default rule); keep renews it", () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.p, "noise", { kind: "not-useful" });
    for (const x of ["d", "e", "f"]) s.tree.attachNugget(s.db.insertNugget({ runId: 1, agent: "pi", sessionId: x, cwd: "/", kind: "fact", title: x, knowledge: "k", triggers: [], scope: "global", confidence: 0.9, evidence: [] }), s.skill);
    scoreTree(s.tree, DEFAULT_CONFIG.score);
    expect(s.tree.getNode(s.skill)!.status).toBe("rejected"); // not-useful: never

    s.db.db.prepare("UPDATE rejection_memory SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, memoryId);
    expect(isExpired(s.mem.mustGet(memoryId))).toBe(true);
    expect(s.mem.inEffect()).toEqual([]);
    scoreTree(s.tree, DEFAULT_CONFIG.score);
    expect(s.tree.getNode(s.skill)!.status).toBe("candidate"); // 6 sessions ≥ 3 + 2

    s.tree.updateNode(s.skill, { status: "rejected" });
    const kept = s.mem.keep(memoryId);
    expect(kept.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 89 * DAY);
    scoreTree(s.tree, DEFAULT_CONFIG.score);
    expect(s.tree.getNode(s.skill)!.status).toBe("rejected");
  });

  it("keep only for active not-useful; edit starts or keeps the expiry", () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.p, "x", { kind: "later" });
    expect(() => s.mem.keep(memoryId)).toThrow(/only not-useful memories expire/);
    const m = s.mem.edit(memoryId, { kind: "not-useful" });
    expect(m.expiresAt).toBeInstanceOf(Date);
    s.db.db.prepare("UPDATE rejection_memory SET expires_at = 12345 WHERE id = ?").run(memoryId);
    expect(s.mem.edit(memoryId, { rule: "reworded" }).expiresAt!.getTime()).toBe(12345); // same kind: unchanged
    expect(s.mem.edit(memoryId, { kind: "outdated" }).expiresAt).toBeUndefined();
    s.mem.forget(memoryId);
    expect(() => s.mem.keep(memoryId)).toThrow(/is removed/);
  });

  it("classification sets the expiry for not-useful", () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.p, "noise");
    new Rejections(s.db, { expireDays: 30 }).classify(memoryId, { kind: "not-useful", rule: "No." });
    const m = s.mem.mustGet(memoryId);
    expect(Math.round((m.expiresAt!.getTime() - Date.now()) / DAY)).toBe(30);
  });
});

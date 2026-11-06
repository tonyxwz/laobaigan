import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { rejectProposal } from "../src/pipeline/accept.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import type { RejectionKind } from "../src/state/rejections.ts";
import { Rejections } from "../src/state/rejections.ts";
import { setup as proposalSetup } from "./proposals.test.ts";

const S = DEFAULT_CONFIG.score;

/** A latent skill with 3 sessions, proposed, rejected with `kind`; the memory dated 1s ago. */
function rejected(kind: RejectionKind | "pending", opts: { target?: boolean } = {}) {
  const s = proposalSetup();
  const other = s.tree.createNode(s.root, { title: "Cloud credentials", name: "cloud-credentials" });
  const add = (session: string, node = s.skill) => {
    const id = s.db.insertNugget({ runId: 1, agent: "pi", sessionId: session, cwd: "/", kind: "fact", title: session, knowledge: "k", triggers: [], scope: "global", confidence: 0.9, evidence: [] });
    s.tree.attachNugget(id, node);
    return id;
  };
  add("o", other);
  const p = s.props.create(s.draft());
  s.props.markOpen(p, [{ path: "dotfiles-management/SKILL.md", baseHash: null, content: "x" }], "draft");
  const r = rejectProposal(s.tree, p, "reason", kind === "pending" ? {} : { kind, ...(opts.target ? { targetNodeId: other } : {}) });
  s.db.db.prepare("UPDATE rejection_memory SET created_at = created_at - 1000 WHERE id = ?").run(r.memoryId);
  return { ...s, other, add, memoryId: r.memoryId, mem: new Rejections(s.db) };
}

const status = (s: ReturnType<typeof rejected>) => s.tree.getNode(s.skill)!.status;

describe("kind-aware scoring of rejected skills", () => {
  it("not-useful: never proposed again while the memory is in effect", () => {
    const s = rejected("not-useful");
    for (const x of ["d", "e", "f", "g", "h", "i"]) s.add(x);
    scoreTree(s.tree, S);
    expect(status(s)).toBe("rejected");
    s.mem.forget(s.memoryId); // back to the default rule: 3 + 2 new sessions → candidate
    scoreTree(s.tree, S);
    expect(status(s)).toBe("candidate");
  });

  it("outdated: only evidence attached after the rejection counts", () => {
    const s = rejected("outdated");
    expect(s.tree.subtree(s.skill)!.nuggets).toEqual([]); // the old evidence is forgotten
    s.add("d");
    s.add("e");
    scoreTree(s.tree, S);
    expect(status(s)).toBe("rejected"); // 2 sessions, one agent: not enough
    s.add("f");
    const r = scoreTree(s.tree, S);
    expect(r.promoted).toEqual([{ id: s.skill, title: "dotfiles-management", kind: "new", score: expect.any(Number) }]);
    expect(s.tree.getNode(s.skill)!.stats).toMatchObject({ sessions: 3 });
  });

  it("outdated: evidence that arrived before the rejection but wasn't in the proposal doesn't count", () => {
    const s = proposalSetup();
    const p = s.props.create(s.draft({ nuggetIds: [] })); // nothing to forget
    s.props.markOpen(p, [], "d");
    const { memoryId } = rejectProposal(s.tree, p, "stale", { kind: "outdated" });
    expect(new Rejections(s.db).mustGet(memoryId).kind).toBe("outdated");
    scoreTree(s.tree, S);
    expect(s.tree.getNode(s.skill)!.status).toBe("rejected"); // its 3 sessions predate the rejection
  });

  it("wrong-place: the evidence moves to the target skill and isn't routed back", () => {
    const s = rejected("wrong-place", { target: true });
    const late = s.add("late");
    const r = scoreTree(s.tree, S);
    expect(r.moved).toBe(4);
    expect(s.tree.subtree(s.skill)!.nuggets).toEqual([]);
    expect(s.tree.subtree(s.other)!.nuggets.map((n) => n.id)).toContain(late);
    expect(s.db.getNugget(late)!.excludedFrom).toContain(s.skill);
    expect(s.mem.mustGet(s.memoryId).caught).toBe(4);
    expect(status(s)).toBe("rejected");
    expect(scoreTree(s.tree, S).moved).toBe(0); // idempotent
  });

  it("wrong-place without a target, later, and a pending memory: the default rule", () => {
    for (const kind of ["wrong-place", "later", "pending"] as const) {
      const s = rejected(kind);
      s.add("d");
      scoreTree(s.tree, S);
      expect(status(s)).toBe("rejected"); // 4 sessions < 3 + 2
      s.add("e");
      scoreTree(s.tree, S);
      expect(status(s)).toBe("candidate");
    }
  });
});

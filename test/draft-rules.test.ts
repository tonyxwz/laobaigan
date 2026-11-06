import { describe, expect, it } from "vitest";
import { rejectProposal } from "../src/pipeline/accept.ts";
import { reviewFeedbackPrompt } from "../src/pipeline/review.ts";
import { Rejections } from "../src/state/rejections.ts";
import { setup as proposalSetup } from "./proposals.test.ts";

describe("drafting sees rejection rules", () => {
  it("the skill's own rule, and siblings' rules instead of their raw reasons", () => {
    const s = proposalSetup();
    const sibling = s.tree.createNode(s.root, { title: "tmux", name: "tmux-config" });
    const p1 = s.props.create(s.draft());
    s.props.markOpen(p1, [], "d");
    const own = rejectProposal(s.tree, p1, "meh, too broad").memoryId;
    const p2 = s.props.create({ ...s.draft(), nodeId: sibling, skillName: "tmux-config" });
    s.props.markOpen(p2, [], "d");
    const sib = rejectProposal(s.tree, p2, "key bindings are personal").memoryId;

    // pending memories: only the raw reasons
    let p = reviewFeedbackPrompt(s.tree, s.tree.getNode(s.skill)!);
    expect(p).not.toContain("<rejection_rule>");
    expect(p).toContain('tmux-config: rejected');
    expect(p).toContain('"key bindings are personal"');

    const mem = new Rejections(s.db);
    mem.classify(own, { kind: "wrong-place", rule: "Keep tmux out of dotfiles-management; it has its own skill." });
    mem.classify(sib, { kind: "not-useful", rule: "Don't propose a skill about tmux key bindings." });
    p = reviewFeedbackPrompt(s.tree, s.tree.getNode(s.skill)!);
    expect(p).toContain("<rejection_rule> This skill was rejected before (wrong-place): Keep tmux out of dotfiles-management; it has its own skill.");
    expect(p).toContain("tmux-config: rejected");
    expect(p).toContain("as not-useful: Don't propose a skill about tmux key bindings.");
    expect(p).not.toContain('"key bindings are personal"');

    mem.forget(own);
    expect(reviewFeedbackPrompt(s.tree, s.tree.getNode(s.skill)!)).not.toContain("<rejection_rule>");
  });
});

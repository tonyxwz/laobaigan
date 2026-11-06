import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { rejectProposal } from "../src/pipeline/accept.ts";
import { buildSkillPrompt, insertNuggets } from "../src/pipeline/insert.ts";
import { Rejections } from "../src/state/rejections.ts";
import { setup as proposalSetup } from "./proposals.test.ts";

const nugget = (title: string) => ({ runId: 1, agent: "pi" as const, sessionId: title, cwd: "/", kind: "fact", title, knowledge: title, triggers: [], scope: "global" as const, confidence: 0.9, evidence: [] });

function setup() {
  const s = proposalSetup();
  const id = s.props.create(s.draft());
  s.props.markOpen(id, [{ path: "dotfiles-management/SKILL.md", baseHash: null, content: "x" }], "draft");
  const other = s.tree.createNode(s.root, { title: "Cloud credentials", name: "cloud-credentials" });
  s.tree.attachNugget(s.db.insertNugget(nugget("vault login profiles")), other);
  return { ...s, proposalId: id, other, mem: new Rejections(s.db) };
}

class Router implements PiRunner {
  prompts: string[] = [];
  to: (prompt: string) => number = () => 0;
  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    this.prompts.push(req.prompt);
    const ids = [...req.prompt.matchAll(/<nugget id="(\d+)"/g)].map((m) => Number(m[1]));
    const value =
      req.resultTool.name === "route_to_skills"
        ? { newSkills: [], placements: ids.map((nuggetId) => ({ nuggetId, skillId: this.to(req.prompt) })) }
        : { newSections: [], placements: ids.map((nuggetId) => ({ nuggetId, body: true })) };
    return { value: value as Static<S>, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  }
}

describe("insert and rejected skills", () => {
  it("shows a rejected skill with its rule; look-alikes routed there are counted as caught", async () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.proposalId, "tmux key bindings are personal", { kind: "not-useful" });
    s.db.insertNugget(nugget("tmux prefix is C-a"));
    const r = new Router();
    r.to = () => s.skill;
    const res = await insertNuggets(s.tree, r, DEFAULT_CONFIG);
    expect(r.prompts[0]).toContain(`<skill id="${s.skill}" kind="latent" name="dotfiles-management" rejected="not-useful">`);
    expect(r.prompts[0]).toContain("rejection_rule: tmux key bindings are personal");
    expect(res.skillsCreated).toEqual([]);
    expect(res.caught).toEqual([{ memoryId, skill: "dotfiles-management", nuggets: 1 }]);
    expect(s.mem.mustGet(memoryId).caught).toBe(1);
  });

  it("wrong-place: the rule names the target skill", () => {
    const s = setup();
    rejectProposal(s.tree, s.proposalId, "vault login steps belong with credentials", { kind: "wrong-place", targetNodeId: s.other });
    const root = s.tree.subtree(s.root)!;
    const p = buildSkillPrompt(root, [], new Rejections(s.db).byNode());
    expect(p).toContain(`rejection_rule: vault login steps belong with credentials (route this knowledge to skill id ${s.other}, cloud-credentials)`);
  });

  it("only rejected skills are marked: a pending, forgotten, or re-proposed one isn't", async () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.proposalId, "meh"); // pending: not in effect yet
    const plain = () => buildSkillPrompt(s.tree.subtree(s.root)!, [], new Rejections(s.db).byNode());
    expect(plain()).not.toContain("rejected=");
    s.mem.classify(memoryId, { kind: "later", rule: "Not now." });
    expect(plain()).toContain('rejected="later"');
    s.mem.forget(memoryId);
    expect(plain()).not.toContain("rejected=");

    // a memory in effect, but the skill came back (status no longer rejected): insert doesn't mark it
    const m2 = rejectProposal(s.tree, s.props.create(s.draft()), "x", { kind: "later" }).memoryId;
    s.tree.updateNode(s.skill, { status: "candidate" });
    s.db.insertNugget(nugget("new"));
    const r = new Router();
    r.to = () => s.skill;
    const res = await insertNuggets(s.tree, r, DEFAULT_CONFIG);
    expect(r.prompts[0]).not.toContain("rejected=");
    expect(res.caught).toEqual([]);
    expect(s.mem.mustGet(m2).caught).toBe(0);
  });
});

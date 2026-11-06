import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { rejectProposal } from "../src/pipeline/accept.ts";
import { processSessions } from "../src/pipeline/process.ts";
import type { SessionRef, SourceAdapter, Transcript } from "../src/sources/types.ts";
import { Rejections } from "../src/state/rejections.ts";
import { setup as proposalSetup } from "./proposals.test.ts";

function adapter(cwd: string, id = "s1"): SourceAdapter {
  return {
    agent: "pi",
    available: async () => true,
    async *list(): AsyncIterable<SessionRef> {
      yield { agent: "pi", sessionId: id, location: "/x", cwd, updatedAt: new Date(0), version: "1" };
    },
    load: async (ref): Promise<Transcript> => ({
      agent: "pi",
      sessionId: ref.sessionId,
      location: "/x",
      cwd,
      startedAt: new Date(0),
      updatedAt: new Date(0),
      turns: [{ role: "user", text: "remember: tmux prefix is C-a, and use mise for node", ts: new Date(0), origin: "prompt" }],
    }),
  };
}

class Capture implements PiRunner {
  prompts: string[] = [];
  system: string[] = [];
  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    this.prompts.push(req.prompt);
    this.system.push(req.systemPrompt);
    return { value: { nuggets: [] } as Static<S>, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  }
}

const cfg: Config = { ...DEFAULT_CONFIG, skillsDir: "/nonexistent", settleMinutes: 0 };

/** Rejections of several kinds and scopes. */
function setup() {
  const s = proposalSetup();
  const reject = (kind: "outdated" | "not-useful" | "later", reason: string, scope?: { repo: string }) => {
    let node = s.skill;
    if (scope) node = s.tree.createNode(s.tree.ensureRoot({ scope: "repo", repo: scope.repo }), { title: `repo skill ${reason}`, name: "repo-skill" });
    const p = s.props.create({ ...s.draft(), nodeId: node, ...(scope ? { scope: "repo" as const, repo: scope.repo, skillName: "repo-skill" } : {}) });
    s.props.markOpen(p, [], "d");
    s.tree.updateNode(node, { status: "proposed" });
    return rejectProposal(s.tree, p, reason, { kind }).memoryId;
  };
  const outdated = reject("outdated", "nvm is gone; use mise");
  // the same skill can only have one active proposal at a time; reopen for the next rejections
  const notUseful = reject("not-useful", "tmux key bindings are personal");
  const later = reject("later", "not now");
  const repoA = reject("not-useful", "A-only noise", { repo: "/w/A" });
  const repoB = reject("not-useful", "B-only noise", { repo: "/w/B" });
  return { ...s, outdated, notUseful, later, repoA, repoB };
}

describe("extraction sees rejected topics of the session's scope", () => {
  it("global + this repo's outdated / not-useful memories; not later; not other repos", async () => {
    const s = setup();
    const c = new Capture();
    await processSessions([adapter("/w/A")], s.db, c, cfg);
    const p = c.prompts[0]!;
    expect(p).toContain("<rejected_topics>");
    expect(p).toContain("[outdated] dotfiles-management: nvm is gone; use mise");
    expect(p).toContain("[not-useful] dotfiles-management: tmux key bindings are personal");
    expect(p).toContain("[not-useful] repo-skill (this repository): A-only noise");
    expect(p).not.toContain("B-only noise");
    expect(p).not.toContain("not now");
    expect(p.indexOf("<rejected_topics>")).toBeLessThan(p.indexOf("<transcript>"));
    expect(c.system[0]).toContain('"outdated": don\'t report the old claim again, but DO report what replaces it');

    const mem = new Rejections(s.db);
    expect([s.outdated, s.notUseful, s.repoA].map((id) => mem.mustGet(id).extractUses)).toEqual([1, 1, 1]);
    expect([s.later, s.repoB].map((id) => mem.mustGet(id).extractUses)).toEqual([0, 0]);
  });

  it("no memories → no rejected_topics block; forgotten memories drop out", async () => {
    const s = proposalSetup();
    const c = new Capture();
    await processSessions([adapter("/w/A")], s.db, c, cfg);
    expect(c.prompts[0]).not.toContain("rejected_topics");

    const t = setup();
    for (const m of new Rejections(t.db).list()) new Rejections(t.db).forget(m.id);
    const c2 = new Capture();
    await processSessions([adapter("/w/A", "s2")], t.db, c2, cfg);
    expect(c2.prompts[0]).not.toContain("rejected_topics");
  });
});

import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { rejectProposal } from "../src/pipeline/accept.ts";
import { processSessions } from "../src/pipeline/process.ts";
import { buildDraftPrompt, resolveTarget } from "../src/pipeline/render.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import type { SessionRef, SourceAdapter, Transcript, Turn } from "../src/sources/types.ts";
import { Rejections } from "../src/state/rejections.ts";
import { Tree } from "../src/state/tree.ts";
import { setup as proposalSetup } from "./proposals.test.ts";

function setup() {
  const s = proposalSetup(); // latent "dotfiles-management" with 3 nuggets from 3 sessions → candidate
  const id = s.props.create(s.draft());
  s.props.markOpen(id, [{ path: "dotfiles-management/SKILL.md", baseHash: null, content: "x" }], "draft");
  return { ...s, proposalId: id, mem: new Rejections(s.db) };
}

describe("forgetting nuggets", () => {
  it("forgotten evidence stops counting and drafting, but stays on the node (shown) and in the db", async () => {
    const s = proposalSetup();
    expect(s.tree.getNode(s.skill)!.status).toBe("candidate");
    expect(s.tree.forgetNuggets([s.ids[0]!], "outdated by hand")).toBe(1);
    expect(s.tree.forgetNuggets([s.ids[0]!], "again")).toBe(0); // already forgotten

    const node = s.tree.subtree(s.skill)!;
    expect(node.nuggets.map((n) => n.id)).toEqual(s.ids.slice(1));
    expect(node.forgotten.map((n) => [n.id, n.forgottenReason])).toEqual([[s.ids[0], "outdated by hand"]]);
    expect(s.db.getNugget(s.ids[0]!)!.forgottenAt).toBeInstanceOf(Date);

    // 2 sessions left (one agent): no longer a candidate
    expect(scoreTree(s.tree, DEFAULT_CONFIG.score).demoted.map((d) => d.id)).toEqual([s.skill]);

    const target = await resolveTarget(node, { ...DEFAULT_CONFIG, skillsDir: "/tmp" });
    const prompt = buildDraftPrompt(node, "new", target, []);
    expect(prompt).not.toContain(`#${s.ids[0]} `);
    expect(prompt).toContain(`#${s.ids[1]} `);

    expect(s.tree.unforgetNuggets({ ids: [s.ids[0]!] })).toBe(1);
    expect(scoreTree(s.tree, DEFAULT_CONFIG.score).promoted.map((p) => p.id)).toEqual([s.skill]);
  });

  it("forgotten unplaced nuggets aren't inserted", () => {
    const s = proposalSetup();
    const n = s.db.insertNugget({ runId: 1, agent: "pi", sessionId: "x", cwd: "/", kind: "fact", title: "t", knowledge: "k", triggers: [], scope: "global", confidence: 0.9, evidence: [] });
    expect(s.tree.unplacedNuggets().map((g) => g.id)).toEqual([n]);
    s.tree.forgetNuggets([n], "noise");
    expect(s.tree.unplacedNuggets()).toEqual([]);
  });

  it("an outdated rejection forgets its proposal's evidence; other kinds and forget give it back", () => {
    const s = setup();
    const r = rejectProposal(s.tree, s.proposalId, "we moved off nvm to mise; this is stale", { kind: "outdated" });
    expect(r.forgotten).toBe(3);
    expect(s.db.nuggets().filter((n) => n.forgottenMemory === r.memoryId).map((n) => n.id)).toEqual(s.ids);
    expect(s.db.getNugget(s.ids[0]!)!.forgottenReason).toBe(`outdated (rejection #${r.memoryId})`);

    s.mem.edit(r.memoryId, { kind: "later" });
    expect(s.db.nuggets().filter((n) => n.forgottenAt)).toEqual([]);
    s.mem.edit(r.memoryId, { kind: "outdated" });
    expect(s.db.nuggets().filter((n) => n.forgottenAt)).toHaveLength(3);
    s.mem.forget(r.memoryId);
    expect(s.db.nuggets().filter((n) => n.forgottenAt)).toEqual([]);
  });

  it("a pending memory forgets nothing until the run classifies it outdated", () => {
    const s = setup();
    const r = rejectProposal(s.tree, s.proposalId, "stale");
    expect(r.forgotten).toBe(0);
    s.mem.classify(r.memoryId, { kind: "outdated", rule: "Use mise." });
    expect(s.db.nuggets().filter((n) => n.forgottenAt)).toHaveLength(3);
  });

  it("reject --forget forgets the evidence whatever the kind", () => {
    const s = setup();
    const r = rejectProposal(s.tree, s.proposalId, "not now", { kind: "later", forget: true });
    expect(r.forgotten).toBe(3);
    s.mem.forget(r.memoryId);
    expect(s.db.nuggets().filter((n) => n.forgottenAt)).toEqual([]);
  });

  it("re-extracting the same session doesn't recreate a forgotten nugget", async () => {
    const s = proposalSetup();
    const turns: Turn[] = [{ role: "user", text: "use mise to manage node versions, never nvm", ts: new Date(Date.UTC(2026, 0, 1)), origin: "prompt" }];
    let version = "1";
    const adapter: SourceAdapter = {
      agent: "pi",
      available: async () => true,
      async *list(): AsyncIterable<SessionRef> {
        yield { agent: "pi", sessionId: "sx", location: "/x", cwd: "/nonexistent", updatedAt: new Date(0), version };
      },
      load: async (ref): Promise<Transcript> => ({ agent: "pi", sessionId: ref.sessionId, location: "/x", cwd: "/nonexistent", startedAt: new Date(0), updatedAt: new Date(0), turns }),
    };
    const runner: PiRunner = {
      async run<S extends TSchema>(_req: PiRequest<S>): Promise<PiResult<Static<S>>> {
        const value = { nuggets: [{ kind: "fact", title: "mise not nvm", knowledge: "mise", triggers: [], scope: "global", evidence: [{ label: "U1", quote: "mise" }], confidence: 0.9 }] };
        return { value: value as Static<S>, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } };
      },
    };
    const cfg: Config = { ...DEFAULT_CONFIG, skillsDir: "/nonexistent", settleMinutes: 0 };
    await processSessions([adapter], s.db, runner, cfg);
    const made = s.db.nuggets().filter((n) => n.sessionId === "sx");
    expect(made).toHaveLength(1);
    new Tree(s.db).forgetNuggets([made[0]!.id], "outdated");
    version = "2"; // the session file changed (e.g. resumed without new messages)
    await processSessions([adapter], s.db, runner, cfg);
    expect(s.db.nuggets().filter((n) => n.sessionId === "sx")).toHaveLength(1);
  });
});

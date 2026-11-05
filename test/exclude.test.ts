import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { buildDraftPrompt, draftSkill } from "../src/pipeline/render.ts";
import { insertNuggets } from "../src/pipeline/insert.ts";
import { reviseProposal } from "../src/pipeline/revise.ts";
import { syncTree } from "../src/pipeline/sync.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Proposals } from "../src/state/proposals.ts";
import { subtreeNuggets, Tree } from "../src/state/tree.ts";
import { fauxRunner } from "./helpers/faux.ts";

const nugget = (sessionId: string, title: string): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId,
  cwd: "/",
  kind: "fact",
  title,
  knowledge: `${title}.`,
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: title, ts: "2026-11-01T10:00:00.000Z" }],
});

const SKILL = "---\nname: dotfiles-management\ndescription: Dotfiles in ~/.cfg (zsh, tmux).\n---\n\n# Dotfiles\n\nShared workflow.\n";

/** Latent dotfiles candidate: two on-topic nuggets and one about showing images in kitty. */
async function setup() {
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  await syncTree(tree, { skillsDir, declared: [] });
  const root = tree.ensureRoot({ scope: "global" });
  const dot = tree.createNode(root, { title: "Dotfiles management", name: "dotfiles-management" });
  const ids = [nugget("a", "zsh profiles gated by hostname"), nugget("b", "tmux config lives in ~/.tmux.conf.local"), nugget("c", "kitten icat shows images over ssh")].map((n) => {
    const id = db.insertNugget(n);
    tree.attachNugget(id, dot);
    return id;
  });
  scoreTree(tree, cfg.score);
  return { skillsDir, cfg, db, tree, root, dot, zsh: ids[0]!, tmux: ids[1]!, icat: ids[2]! };
}

describe("insert never routes a nugget back to a skill it was left out of", () => {
  it("shows the ban to the router and repairs a placement there into a new skill", async () => {
    const { db, tree, dot, icat, cfg } = await setup();
    tree.excludeNugget(icat, dot);
    expect(db.getNugget(icat)).toMatchObject({ excludedFrom: [dot] });
    expect(db.getNugget(icat)!.nodeId).toBeUndefined();
    let prompt = "";
    const runner: PiRunner = {
      async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
        prompt = req.prompt;
        return { value: { newSkills: [], placements: [{ nuggetId: icat, skillId: dot }] } as Static<S>, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
      },
    };
    const r = await insertNuggets(tree, runner, cfg);
    expect(prompt).toContain(`not_in_skills: ${dot}`);
    expect(r.repairs).toContain(`nugget ${icat}: was left out of skill ${dot}; new skill`);
    const now = db.getNugget(icat)!.nodeId!;
    expect(tree.path(now)[1]!.id).not.toBe(dot);
  });
});

describe("drafter leaves off-topic evidence out", () => {
  it("records it, takes it off the skill, re-files it elsewhere, and the skill no longer counts it", async () => {
    const { db, tree, dot, icat, zsh, cfg } = await setup();
    const prompt = buildDraftPrompt(tree.subtree(dot)!, "new", { root: cfg.skillsDir, skillName: "dotfiles-management", writable: ["dotfiles-management/"], skillDir: "dotfiles-management" }, []);
    expect(prompt).toContain(`- #${icat} [fact] kitten icat shows images over ssh`);

    const runner = await fauxRunner([
      fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL })], { stopReason: "toolUse" }),
      fauxAssistantMessage(
        [fauxToolCall("report_draft", { summary: "Dotfiles skill.", excluded: [{ nuggetId: icat, reason: "about showing images in the terminal, not dotfiles" }, { nuggetId: 9999, reason: "bogus" }] })],
        { stopReason: "toolUse" },
      ),
      // re-filing: the router puts it in a new skill
      fauxAssistantMessage([fauxToolCall("route_to_skills", { newSkills: [{ key: "t", title: "Terminal images", name: "terminal-images", description: "Show images with kitten icat." }], placements: [{ nuggetId: icat, newSkillKey: "t" }] })], { stopReason: "toolUse" }),
    ]);
    const out = await draftSkill(tree, runner, cfg, dot);
    expect(out).toMatchObject({ status: "open", excluded: [{ nuggetId: icat, reason: "about showing images in the terminal, not dotfiles", now: { path: "terminal-images" } }] });

    const p = new Proposals(db).get((out as { proposalId: number }).proposalId)!;
    expect(p.excluded).toEqual([{ nuggetId: icat, reason: "about showing images in the terminal, not dotfiles", by: "drafter", at: expect.any(Number) }]);
    expect(p.nuggetIds).not.toContain(icat);
    expect(p.nuggetIds).toContain(zsh);
    expect(subtreeNuggets(tree.subtree(dot)!).map((n) => n.id)).not.toContain(icat);
    expect(db.getNugget(icat)).toMatchObject({ excludedFrom: [dot] });
  });

  it("if re-filing fails the nugget stays unplaced (still banned from the skill) for the next run", async () => {
    const { db, tree, dot, icat, cfg } = await setup();
    const runner = await fauxRunner([
      fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("report_draft", { summary: "s", excluded: [{ nuggetId: icat, reason: "off-topic" }] })], { stopReason: "toolUse" }),
      fauxAssistantMessage("I won't route anything."), // never calls route_to_skills → insert fails
      fauxAssistantMessage("Still no."),
    ]);
    const out = await draftSkill(tree, runner, cfg, dot);
    expect(out).toMatchObject({ status: "open", excluded: [{ nuggetId: icat }] });
    expect(db.getNugget(icat)).toMatchObject({ excludedFrom: [dot] });
    expect(db.getNugget(icat)!.nodeId).toBeUndefined();
    expect(tree.unplacedNuggets().map((n) => n.id)).toEqual([icat]);
  });

  it("one-shot revise can leave evidence out too", async () => {
    const { db, tree, dot, icat, cfg } = await setup();
    const props = new Proposals(db);
    const first = await draftSkill(
      tree,
      await fauxRunner([
        fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("report_draft", { summary: "s" })], { stopReason: "toolUse" }),
      ]),
      cfg,
      dot,
    );
    const id = (first as { proposalId: number }).proposalId;
    expect(props.get(id)!.excluded).toEqual([]);
    const r = await reviseProposal(
      tree,
      await fauxRunner([
        fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: `${SKILL}\n## zsh\nGate work config by hostname.\n` })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("report_draft", { summary: "Dropped the icat item.", excluded: [{ nuggetId: icat, reason: "not dotfiles" }] })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("route_to_skills", { newSkills: [{ key: "t", title: "Terminal images", description: "icat" }], placements: [{ nuggetId: icat, newSkillKey: "t" }] })], { stopReason: "toolUse" }),
      ]),
      cfg,
      id,
      "the icat item isn't dotfiles",
    );
    expect(r.problems).toEqual([]);
    expect(r.excluded.map((e) => e.nuggetId)).toEqual([icat]);
    expect(props.get(id)!.excluded).toEqual([{ nuggetId: icat, reason: "not dotfiles", by: "drafter", at: expect.any(Number) }]);
    expect(db.getNugget(icat)!.nodeId).toBeDefined();
  });
});

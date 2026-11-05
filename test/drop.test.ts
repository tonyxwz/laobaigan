import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { dropEvidence } from "../src/pipeline/drop.ts";
import { insertNuggets } from "../src/pipeline/insert.ts";
import { draftSkill } from "../src/pipeline/render.ts";
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

const SKILL = (extra = "") => `---\nname: dotfiles-management\ndescription: Dotfiles in ~/.cfg (zsh, tmux).\n---\n\n# Dotfiles\n\nShared workflow.\n${extra}`;

/** An open proposal for a latent dotfiles skill whose draft includes an icat section. */
async function setup() {
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  await syncTree(tree, { skillsDir, declared: [] });
  const root = tree.ensureRoot({ scope: "global" });
  const dot = tree.createNode(root, { title: "Dotfiles management", name: "dotfiles-management" });
  const other = tree.createNode(root, { title: "Terminal tricks", name: "terminal-tricks" });
  tree.attachNugget(db.insertNugget(nugget("z", "tmux split panes for side-by-side output")), other); // not empty, so it isn't pruned
  const [zsh, tmux, icat] = [nugget("a", "zsh profiles gated by hostname"), nugget("b", "tmux config lives in ~/.tmux.conf.local"), nugget("c", "kitten icat shows images over ssh")].map((n) => {
    const id = db.insertNugget(n);
    tree.attachNugget(id, dot);
    return id;
  });
  scoreTree(tree, cfg.score);
  const out = await draftSkill(
    tree,
    await fauxRunner([
      fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL("\n## Images\nUse kitten icat.\n") })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("report_draft", { summary: "Dotfiles skill." })], { stopReason: "toolUse" }),
    ]),
    cfg,
    dot,
  );
  const id = (out as { proposalId: number }).proposalId;
  return { cfg, db, tree, dot, other, zsh: zsh!, tmux: tmux!, icat: icat!, id, props: new Proposals(db) };
}

describe("lbg proposal drop", () => {
  it("takes evidence off a proposed skill, re-files it, and the next insert never sends it back", async () => {
    const { cfg, db, tree, dot, other, icat, id, props } = await setup();
    expect(tree.getNode(dot)!.status).toBe("proposed");
    const r = await dropEvidence(
      tree,
      await fauxRunner([fauxAssistantMessage([fauxToolCall("route_to_skills", { newSkills: [], placements: [{ nuggetId: icat, skillId: other }] })], { stopReason: "toolUse" })]),
      cfg,
      id,
      [icat],
      { reason: "terminal usage, not dotfiles" },
    );
    expect(r.dropped).toMatchObject([{ nuggetId: icat, reason: "terminal usage, not dotfiles", now: { path: "terminal-tricks" } }]);
    const p = props.get(id)!;
    expect(p.excluded).toMatchObject([{ nuggetId: icat, by: "reviewer", reason: "terminal usage, not dotfiles" }]);
    expect(p.nuggetIds).not.toContain(icat);
    expect(props.droppedSinceDraft(p).map((e) => e.nuggetId)).toEqual([icat]);
    expect(subtreeNuggets(tree.subtree(dot)!).map((n) => n.id)).not.toContain(icat);
    expect(tree.getNode(dot)!.status).toBe("proposed"); // still the same open proposal

    // a later re-insert of that nugget can't land in dotfiles again
    tree.detachNugget(icat);
    const back = await insertNuggets(
      tree,
      await fauxRunner([fauxAssistantMessage([fauxToolCall("route_to_skills", { newSkills: [], placements: [{ nuggetId: icat, skillId: dot }] })], { stopReason: "toolUse" })]),
      cfg,
    );
    expect(back.repairs).toContain(`nugget ${icat}: was left out of skill ${dot}; new skill`);
    expect(tree.path(db.getNugget(icat)!.nodeId!)[1]!.id).not.toBe(dot);
  });

  it("--to puts it where I say, locked; --revise redrafts without it and clears the warning", async () => {
    const { cfg, db, tree, other, icat, id, props } = await setup();
    const r = await dropEvidence(
      tree,
      await fauxRunner([
        fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL() })], { stopReason: "toolUse" }),
        (ctx) => {
          expect(JSON.stringify((ctx as { messages: unknown[] }).messages)).toContain(`#${icat} kitten icat shows images over ssh`);
          return fauxAssistantMessage([fauxToolCall("report_draft", { summary: "Removed the images section." })], { stopReason: "toolUse" });
        },
      ]),
      cfg,
      id,
      [icat],
      { to: other, revise: true },
    );
    expect(db.getNugget(icat)).toMatchObject({ nodeId: other, assignmentLocked: true, excludedFrom: [expect.any(Number)] });
    expect(r.revised).toMatchObject({ problems: [], summary: "Removed the images section." });
    const p = props.get(id)!;
    expect(p.files[0]!.content).not.toContain("icat");
    expect(props.droppedSinceDraft(p)).toEqual([]); // the revise covered it
    expect(p.excluded[0]).toMatchObject({ reason: "dropped in review" });
  });

  it("a revise is told about every item dropped since the draft, not only the last one", async () => {
    const { cfg, tree, other, icat, tmux, id } = await setup();
    await dropEvidence(tree, await fauxRunner([]), cfg, id, [tmux], { to: other });
    let seen = "";
    await dropEvidence(
      tree,
      await fauxRunner([
        (ctx) => {
          seen = JSON.stringify((ctx as { messages: unknown[] }).messages);
          return fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL() })], { stopReason: "toolUse" });
        },
        fauxAssistantMessage([fauxToolCall("report_draft", { summary: "s" })], { stopReason: "toolUse" }),
      ]),
      cfg,
      id,
      [icat],
      { to: other, revise: true },
    );
    expect(seen).toContain(`#${tmux} tmux config lives`);
    expect(seen).toContain(`#${icat} kitten icat`);
  });

  it("refuses nuggets that aren't this proposal's evidence, closed proposals, and bad --to targets", async () => {
    const { cfg, tree, dot, zsh, id, props } = await setup();
    const none = await fauxRunner([]);
    await expect(dropEvidence(tree, none, cfg, id, [9999])).rejects.toThrow(/Not evidence of proposal/);
    await expect(dropEvidence(tree, none, cfg, id, [zsh], { to: dot })).rejects.toThrow(/part of the skill you're dropping from/);
    await expect(dropEvidence(tree, none, cfg, id, [zsh], { to: tree.ensureRoot({ scope: "global" }) })).rejects.toThrow(/is a root/);
    props.markRejected(id);
    await expect(dropEvidence(tree, none, cfg, id, [zsh])).rejects.toThrow(/is rejected; only open proposals/);
  });
});

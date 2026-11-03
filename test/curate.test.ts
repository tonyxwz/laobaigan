import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { mergeSkills, moveNode, moveNugget, renameNode, splitSkill, unlockNode } from "../src/pipeline/curate.ts";
import { detachLatent } from "../src/pipeline/insert.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";
import { subtreeNuggets, Tree } from "../src/state/tree.ts";

const nugget = (sessionId: string, over: Partial<NuggetInsert> = {}): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId,
  cwd: "/",
  kind: "fact",
  title: sessionId,
  knowledge: "k",
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: "q" }],
  ...over,
});

function setup() {
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  const root = tree.ensureRoot({ scope: "global" });
  const add = (node: number, session: string) => {
    const id = db.insertNugget(nugget(session));
    tree.attachNugget(id, node);
    return id;
  };
  /** A latent skill with one section holding one nugget, plus one body nugget. */
  const skill = (title: string, session: string) => {
    const s = tree.createNode(root, { title });
    const sec = tree.createNode(s, { title: `${title} section` });
    add(sec, `${session}-sec`);
    add(s, `${session}-body`);
    return { s, sec };
  };
  return { db, tree, root, add, skill };
}

describe("curation on the tree", () => {
  it("merges skills: sections and body nuggets move, sources disappear, all locked", () => {
    const { tree, root, skill } = setup();
    const zsh = skill("zsh", "a");
    const tmux = skill("tmux", "b");
    const r = mergeSkills(tree, zsh.s, [tmux.s]);
    expect(r).toEqual({ sections: 1, nuggets: 1 });
    const merged = tree.subtree(zsh.s)!;
    expect(merged.locked).toBe(true);
    expect(merged.children.map((c) => [c.title, c.locked])).toEqual([
      ["zsh section", false],
      ["tmux section", true],
    ]);
    expect(merged.nuggets.map((n) => n.assignmentLocked)).toEqual([false, true]);
    expect(subtreeNuggets(merged)).toHaveLength(4);
    expect(tree.children(root).map((c) => c.id)).toEqual([zsh.s]);
  });

  it("refuses to restructure live files, proposals, other scopes, or non-skills", () => {
    const { tree, root, skill } = setup();
    const latent = skill("latent", "a");
    const live = tree.createNode(root, { title: "git-worktree", origin: "file" });
    const liveSection = tree.createNode(live, { title: "Commands", origin: "file" });
    expect(() => mergeSkills(tree, latent.s, [live])).toThrow(/live skill file/);
    expect(() => moveNode(tree, liveSection, latent.s)).toThrow(/live skill file/);
    expect(() => renameNode(tree, live, { title: "x" })).toThrow(/live skill file/);
    expect(() => mergeSkills(tree, latent.s, [latent.sec])).toThrow(/not a skill/);

    const proposed = skill("proposed", "p");
    tree.updateNode(proposed.s, { status: "proposed" });
    expect(() => mergeSkills(tree, latent.s, [proposed.s])).toThrow(/proposed/);

    const repoRoot = tree.ensureRoot({ scope: "repo", repo: "/w/A" });
    const repoSkill = tree.createNode(repoRoot, { title: "repo" });
    tree.createNode(repoSkill, { title: "repo section" });
    expect(() => mergeSkills(tree, latent.s, [repoSkill])).toThrow(/Scope mismatch/);
    expect(tree.getNode(repoSkill)).toBeDefined(); // rolled back
  });

  it("live skills can still receive latent sections and nuggets", () => {
    const { tree, root, skill, db } = setup();
    const live = tree.createNode(root, { title: "git-worktree", origin: "file" });
    const latent = skill("isolation", "a");
    moveNode(tree, latent.sec, live);
    expect(tree.getNode(latent.sec)).toMatchObject({ parentId: live, locked: true });
    const body = latent.s;
    const n = tree.subtree(body)!.nuggets[0]!.id;
    moveNugget(tree, n, live);
    expect(db.getNugget(n)).toMatchObject({ nodeId: live, assignmentLocked: true });
    expect(tree.getNode(body)).toBeUndefined(); // emptied latent skill pruned
  });

  it("splits sections out into a new locked skill; moves a section up to become a skill", () => {
    const { tree, root, skill } = setup();
    const dot = skill("dotfiles", "a");
    const tmux = tree.createNode(dot.s, { title: "tmux" });
    const created = splitSkill(tree, dot.s, [tmux], "tmux setup");
    expect(tree.getNode(created)).toMatchObject({ title: "tmux setup", depth: 1, locked: true });
    expect(tree.getNode(tmux)!.parentId).toBe(created);
    expect(() => splitSkill(tree, dot.s, [tmux])).toThrow(/not in skill/);

    moveNode(tree, dot.sec, root);
    expect(tree.getNode(dot.sec)).toMatchObject({ depth: 1, parentId: root });
  });

  it("renames with valid, unique skill names", () => {
    const { tree, skill } = setup();
    const a = skill("a", "x");
    const b = skill("b", "y");
    renameNode(tree, a.s, { title: "Dotfiles management", name: "dotfiles-management" });
    expect(tree.getNode(a.s)).toMatchObject({ title: "Dotfiles management", name: "dotfiles-management", locked: true });
    expect(() => renameNode(tree, b.s, { name: "dotfiles-management" })).toThrow(/already named/);
    expect(() => renameNode(tree, b.s, { name: "Bad Name" })).toThrow(/lowercase/);
    expect(() => renameNode(tree, a.sec, { name: "x" })).toThrow(/Only skills/);
  });

  it("curated placements survive re-insertion and scoring; unlock releases them", () => {
    const { tree, skill } = setup();
    const a = skill("a", "x");
    const b = skill("b", "y");
    mergeSkills(tree, a.s, [b.s]);
    // the moved nuggets are locked; the merged skill is locked → detachLatent leaves all of it
    expect(detachLatent(tree)).toEqual([]);
    scoreTree(tree, DEFAULT_CONFIG.score);
    expect(subtreeNuggets(tree.subtree(a.s)!)).toHaveLength(4);

    unlockNode(tree, a.s);
    const u = tree.subtree(a.s)!;
    expect([u.locked, ...u.children.map((c) => c.locked), ...subtreeNuggets(u).map((n) => n.assignmentLocked)].every((x) => !x)).toBe(true);
    expect(detachLatent(tree)).toHaveLength(4);
  });
});

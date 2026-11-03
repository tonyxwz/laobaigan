import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { syncTree } from "../src/pipeline/sync.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import { MIGRATIONS, StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Proposals, type NewProposal } from "../src/state/proposals.ts";
import { Tree } from "../src/state/tree.ts";

const nugget = (sessionId: string): NuggetInsert => ({
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
});

function setup() {
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  const root = tree.ensureRoot({ scope: "global" });
  const skill = tree.createNode(root, { title: "Dotfiles", name: "dotfiles-management" });
  const section = tree.createNode(skill, { title: "tmux" });
  const ids = ["a", "b", "c"].map((s) => {
    const id = db.insertNugget(nugget(s));
    tree.attachNugget(id, skill);
    return id;
  });
  scoreTree(tree, DEFAULT_CONFIG.score); // → candidate:new
  const props = new Proposals(db);
  const draft = (over: Partial<NewProposal> = {}): NewProposal => ({
    nodeId: skill,
    kind: "new",
    scope: "global",
    skillName: "dotfiles-management",
    gitDir: "/home/u/.cfg",
    workTree: "/home/u",
    baseBranch: "main",
    baseCommit: "abc123",
    branch: "laobaigan/dotfiles-management-20261103-1405",
    worktree: "/state/worktrees/laobaigan__dotfiles-management-20261103-1405",
    writable: [".config/opencode/skills/dotfiles-management/"],
    nuggetIds: ids,
    sessions: 3,
    ...over,
  });
  return { db, tree, root, skill, section, props, draft, ids };
}

describe("Proposals", () => {
  it("round-trips a proposal and freezes the node while it is active", () => {
    const { tree, skill, props, draft, ids, db } = setup();
    expect(tree.getNode(skill)!.status).toBe("candidate");
    const id = props.create(draft());
    expect(props.get(id)).toMatchObject({
      nodeId: skill,
      kind: "new",
      status: "drafting",
      gitDir: "/home/u/.cfg",
      writable: [".config/opencode/skills/dotfiles-management/"],
      nuggetIds: ids,
      sessions: 3,
      worktreeRemoved: false,
    });
    expect(props.get(id)!.closedAt).toBeUndefined();
    expect(tree.getNode(skill)!.status).toBe("proposed");
    expect(db.counts().openProposals).toBe(1);

    // scoring leaves a proposed node alone
    scoreTree(tree, DEFAULT_CONFIG.score);
    expect(tree.getNode(skill)!.status).toBe("proposed");

    props.markOpen(id, "def456", { cost: 0.12 });
    expect(props.get(id)).toMatchObject({ status: "open", commit: "def456", usage: { cost: 0.12 } });
    expect(props.active(skill)!.id).toBe(id);
  });

  it("allows one active proposal per node, only for skills, with unique branches", () => {
    const { props, draft, section } = setup();
    const id = props.create(draft());
    expect(() => props.create(draft({ branch: "laobaigan/other" }))).toThrow(/already has drafting proposal #/);
    expect(() => props.create(draft({ nodeId: section }))).toThrow(/depth 1/);
    expect(() => props.create(draft({ nodeId: 999 }))).toThrow(/No node/);
    props.markFailed(id, "verification: wrote outside the skill");
    // a retry may reuse the node, but not the branch name in the same repo
    expect(() => props.create(draft())).toThrow(/UNIQUE/);
    expect(props.create(draft({ branch: "laobaigan/dotfiles-management-retry" }))).toBeGreaterThan(id);
  });

  it("failed: the node is a candidate again and keeps the error", () => {
    const { tree, skill, props, draft } = setup();
    const id = props.create(draft());
    props.markFailed(id, "model never called report", { cost: 0.03 });
    expect(props.get(id)).toMatchObject({ status: "failed", detail: "model never called report", usage: { cost: 0.03 } });
    expect(props.get(id)!.closedAt).toBeInstanceOf(Date);
    expect(tree.getNode(skill)!.status).toBe("candidate");
    expect(props.active(skill)).toBeUndefined();
  });

  it("rejected: the node waits for new sessions before it is proposed again", () => {
    const { db, tree, skill, props, draft } = setup();
    const id = props.create(draft());
    props.markOpen(id, "def");
    props.markRejected(id, "too broad, split tmux out");
    expect(props.get(id)).toMatchObject({ status: "rejected", detail: "too broad, split tmux out" });
    expect(tree.getNode(skill)).toMatchObject({ status: "rejected", rejectedSessions: 3 });

    scoreTree(tree, DEFAULT_CONFIG.score);
    expect(tree.getNode(skill)!.status).toBe("rejected");
    for (const s of ["d", "e"]) tree.attachNugget(db.insertNugget(nugget(s)), skill);
    scoreTree(tree, DEFAULT_CONFIG.score);
    expect(tree.getNode(skill)!.status).toBe("candidate");
  });

  it("merged: node is merged until sync; invalid transitions are refused; cleanup list", () => {
    const { tree, skill, props, draft } = setup();
    const id = props.create(draft());
    expect(() => props.markMerged(id)).toThrow(/is drafting; can't mark it merged/);
    props.markOpen(id, "def");
    props.markMerged(id);
    expect(tree.getNode(skill)!.status).toBe("merged");
    expect(() => props.markRejected(id)).toThrow(/is merged/);
    expect(props.list(["merged"]).map((p) => p.id)).toEqual([id]);
    expect(props.needingCleanup().map((p) => p.id)).toEqual([id]);
    props.markWorktreeRemoved(id);
    expect(props.needingCleanup()).toEqual([]);
    expect(props.forNode(skill)).toHaveLength(1);
  });

  it("after merge, the next sync makes the node live and open (new skill and live update)", async () => {
    const { tree, skill, props, draft } = setup();
    const dir = await mkdtemp(join(tmpdir(), "lbg-skills-"));
    const md = (body: string) => `---\nname: dotfiles-management\ndescription: Dotfiles in ~/.cfg.\n---\n\n# Dotfiles\n\n${body}`;
    const id = props.create(draft());
    props.markOpen(id, "def");
    props.markMerged(id);
    await mkdir(join(dir, "dotfiles-management"));
    await writeFile(join(dir, "dotfiles-management", "SKILL.md"), md("v1"));
    await syncTree(tree, { skillsDir: dir, declared: [] });
    expect(tree.getNode(skill)).toMatchObject({ origin: "file", status: "open" });

    // an update proposal to the now-live skill
    tree.updateNode(skill, { status: "candidate", proposalKind: "update" });
    const u = props.create(draft({ kind: "update", branch: "laobaigan/dotfiles-update" }));
    props.markOpen(u, "ghi");
    props.markMerged(u);
    await syncTree(tree, { skillsDir: dir, declared: [] }); // not merged into the live dir yet: unchanged
    expect(tree.getNode(skill)!.status).toBe("merged");
    await writeFile(join(dir, "dotfiles-management", "SKILL.md"), md("v2"));
    await syncTree(tree, { skillsDir: dir, declared: [] });
    expect(tree.getNode(skill)!.status).toBe("open");
  });

  it("migration 10 applies on a v9 database", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lbg-prop-")), "state.db");
    const raw = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 9)) raw.exec(m);
    raw.exec("PRAGMA user_version = 9");
    raw.close();
    const db = new StateDb(path);
    expect(Number((db.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(MIGRATIONS.length);
    expect(new Proposals(db).list()).toEqual([]);
  });
});

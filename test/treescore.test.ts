import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { scoreTree, skillStats } from "../src/pipeline/treescore.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Tree } from "../src/state/tree.ts";

const S = DEFAULT_CONFIG.score;
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
  evidence: [{ label: "U1", quote: "q", ts: "2026-01-01T10:00:00.000Z" }],
  ...over,
});

function setup() {
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  const root = tree.ensureRoot({ scope: "global" });
  /** Attach nuggets from the given sessions to `node`. */
  const add = (node: number, sessions: string[], over: Partial<NuggetInsert> = {}) =>
    sessions.map((s) => {
      const id = db.insertNugget(nugget(s, over));
      tree.attachNugget(id, node);
      return id;
    });
  return { db, tree, root, add };
}

describe("scoreTree", () => {
  it("latent skills: promoted to 'new' over their whole subtree (3 sessions, or 2 across agents)", () => {
    const { tree, root, add } = setup();
    const dot = tree.createNode(root, { title: "Dotfiles", name: "dotfiles-management" });
    const zsh = tree.createNode(dot, { title: "zsh" });
    const tmux = tree.createNode(dot, { title: "tmux" });
    add(zsh, ["a"]);
    add(tmux, ["b"]);
    add(dot, ["c"]); // body
    const two = tree.createNode(root, { title: "Two sessions, one agent" });
    add(two, ["d", "e"]);
    const cross = tree.createNode(root, { title: "Two agents" });
    add(cross, ["f"]);
    add(cross, ["g"], { agent: "claude" });

    const r = scoreTree(tree, S);
    expect(r.promoted.map((p) => [p.title, p.kind])).toEqual([
      ["dotfiles-management", "new"],
      ["Two agents", "new"],
    ]);
    expect(tree.getNode(dot)).toMatchObject({ status: "candidate", proposalKind: "new", stats: { sessions: 3, nuggets: 3 } });
    expect(tree.getNode(two)).toMatchObject({ status: "open" });
    expect(tree.getNode(two)!.proposalKind).toBeUndefined();
    expect(scoreTree(tree, S).promoted).toEqual([]); // idempotent
  });

  it("live skills: only evidence since the last render counts; covered evidence asks for a description fix", () => {
    const { tree, root, add, db } = setup();
    const gradle = tree.createNode(root, { title: "Git worktrees", name: "git-worktree", origin: "file" });
    const cmds = tree.createNode(gradle, { title: "Commands", origin: "file" });
    const old = add(cmds, ["old1", "old2"]);
    db.db.prepare("UPDATE nugget SET attached_at = 1000 WHERE id IN (?, ?)").run(old[0]!, old[1]!);
    tree.updateNode(gradle, { renderedAt: new Date(2000) }); // the old evidence is in the file

    expect(scoreTree(tree, S).promoted).toEqual([]);
    expect(skillStats(tree.subtree(gradle)!)).toMatchObject({ sessions: 2, fresh: { nuggets: 0, sessions: 0 }, covered: { sessions: 0 } });

    // explained again twice, but the file already says it
    const cov = add(cmds, ["c1", "c2"]);
    for (const id of cov) tree.setCovered(id, cmds);
    expect(scoreTree(tree, S).promoted).toEqual([{ id: gradle, title: "git-worktree", kind: "fix-description", score: expect.any(Number) }]);

    // new knowledge from 2 sessions → an update (which can fix the description too)
    add(gradle, ["n1", "n2"]);
    expect(scoreTree(tree, S).promoted.map((p) => p.kind)).toEqual(["update"]);
    expect(tree.getNode(gradle)).toMatchObject({ status: "candidate", proposalKind: "update", stats: { fresh: { sessions: 2 }, covered: { sessions: 2 } } });

    // the proposal is merged: sync re-renders → nothing fresh or covered counts any more → back to open
    tree.updateNode(gradle, { renderedAt: new Date(Date.now() + 1000) });
    const r = scoreTree(tree, S);
    expect(r.demoted).toEqual([{ id: gradle, title: "git-worktree" }]);
    expect(tree.getNode(gradle)!.status).toBe("open");
  });

  it("leaves proposed/merged alone and re-promotes rejected skills only after new sessions", () => {
    const { tree, root, add } = setup();
    const proposed = tree.createNode(root, { title: "P" });
    add(proposed, ["a", "b", "c"]);
    tree.updateNode(proposed, { status: "proposed", proposalKind: "new" });
    const rejected = tree.createNode(root, { title: "R" });
    add(rejected, ["a", "b", "c"]);
    tree.updateNode(rejected, { status: "rejected", rejectedSessions: 3 });

    expect(scoreTree(tree, S).promoted).toEqual([]);
    expect(tree.getNode(proposed)).toMatchObject({ status: "proposed", proposalKind: "new", stats: { sessions: 3 } });
    expect(tree.getNode(rejected)!.status).toBe("rejected");

    add(rejected, ["d", "e"]);
    expect(scoreTree(tree, S).promoted.map((p) => p.id)).toEqual([rejected]);
  });

  it("demotes a latent candidate whose evidence moved away", () => {
    const { tree, root, add } = setup();
    const a = tree.createNode(root, { title: "A" });
    const ids = add(a, ["x", "y", "z"]);
    scoreTree(tree, S);
    expect(tree.getNode(a)!.status).toBe("candidate");
    const b = tree.createNode(root, { title: "B" });
    tree.attachNugget(ids[0]!, b);
    expect(scoreTree(tree, S).demoted.map((d) => d.id)).toEqual([a]);
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, StateDb, type NuggetInsert } from "../src/state/db.ts";
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

describe("migration 6: topics/clusters → tree", () => {
  it("keeps topic ids for skills, makes sections for multi-cluster topics, moves nuggets", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lbg-tree-")), "state.db");
    const raw = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 5)) raw.exec(m);
    raw.exec("PRAGMA user_version = 5");
    raw.exec(`
      INSERT INTO topic (id, name, title, description, scope, repo, declared, locked, status, score, target, stats, created_at, updated_at) VALUES
        (4,  NULL, 'Pi config', NULL, 'global', NULL, 0, 0, 'candidate', 11, 'global:new:pi', '{"sessions":3}', 1, 1),
        (10, NULL, 'Evals', NULL, 'repo', '/w/D', 0, 0, 'open', 3, NULL, NULL, 1, 1),
        (14, 'dotfiles-management', 'Dotfiles', 'zsh, tmux', 'global', NULL, 1, 1, 'open', 0, NULL, NULL, 1, 1),
        (15, 'gradle', 'Gradle', 'b', 'global', NULL, 1, 0, 'open', 0, NULL, NULL, 1, 1);
      INSERT INTO cluster (id, topic_id, title, summary, scope, repo, locked, created_at, updated_at) VALUES
        (4,  4,  'Pi config', 'pi sum', 'global', NULL, 0, 1, 1),
        (10, 10, 'Evals', 'eval sum', 'repo', '/w/D', 0, 1, 1),
        (1,  14, 'zsh', 'zsh sum', 'global', NULL, 1, 1, 1),
        (3,  14, 'tmux', 'tmux sum', 'global', NULL, 0, 1, 1);
      INSERT INTO nugget (id, run_id, agent, session_id, cwd, kind, title, knowledge, triggers, scope, repo, confidence, evidence, cluster_id, created_at) VALUES
        (1, 1, 'pi', 'a', '/', 'fact', 'pi', 'k', '[]', 'global', NULL, 0.9, '[]', 4, 0),
        (2, 1, 'pi', 'b', '/', 'fact', 'zsh', 'k', '[]', 'global', NULL, 0.9, '[]', 1, 0),
        (3, 1, 'pi', 'c', '/', 'fact', 'tmux', 'k', '[]', 'global', NULL, 0.9, '[]', 3, 0),
        (4, 1, 'pi', 'd', '/', 'fact', 'eval', 'k', '[]', 'repo', '/w/D', 0.9, '[]', 10, 0),
        (5, 1, 'pi', 'e', '/', 'fact', 'unplaced', 'k', '[]', 'global', NULL, 0.9, '[]', NULL, 0);`);
    raw.close();

    const db = new StateDb(path);
    const tree = new Tree(db);
    const [global, repo] = tree.trees();
    expect(global).toMatchObject({ depth: 0, scope: "global", origin: "root", title: "Global skills" });
    expect(repo).toMatchObject({ depth: 0, scope: "repo", repo: "/w/D" });
    expect(global!.id).toBeGreaterThan(15); // after all topic ids

    expect(global!.children.map((s) => [s.id, s.title, s.origin, s.status, s.locked])).toEqual([
      [4, "Pi config", "latent", "candidate", false],
      [14, "Dotfiles", "declared", "open", true],
      [15, "Gradle", "declared", "open", false],
    ]);
    const pi = global!.children[0]!;
    expect(pi).toMatchObject({ summary: "pi sum", summaryDirty: false, score: 11, stats: { sessions: 3 } });
    expect(pi.children).toEqual([]);
    expect(pi.nuggets.map((n) => n.id)).toEqual([1]);

    const dot = global!.children[1]!;
    expect(dot).toMatchObject({ name: "dotfiles-management", description: "zsh, tmux", summary: "", summaryDirty: true });
    expect(dot.children.map((s) => [s.depth, s.title, s.summary, s.locked, s.nuggets.map((n) => n.id)])).toEqual([
      [2, "zsh", "zsh sum", true, [2]],
      [2, "tmux", "tmux sum", false, [3]],
    ]);
    expect(subtreeNuggets(dot).map((n) => n.id)).toEqual([2, 3]);
    expect(repo!.children[0]!.nuggets.map((n) => n.id)).toEqual([4]);
    expect(tree.unplacedNuggets().map((n) => n.id)).toEqual([5]);
  });

  it("works on an empty database", () => {
    const db = new StateDb(":memory:");
    expect(new Tree(db).trees()).toEqual([]);
  });
});

describe("Tree", () => {
  it("creates roots lazily, nodes at the right depth, and refuses depth > 2", () => {
    const tree = new Tree(new StateDb(":memory:"));
    const root = tree.ensureRoot({ scope: "global" });
    expect(tree.ensureRoot({ scope: "global" })).toBe(root);
    const repoRoot = tree.ensureRoot({ scope: "repo", repo: "/w/A" });
    expect(repoRoot).not.toBe(root);
    expect(() => tree.ensureRoot({ scope: "repo" })).toThrow(/repo path/);

    const skill = tree.createNode(root, { title: "Dotfiles", name: "dotfiles-management" });
    const section = tree.createNode(skill, { title: "tmux" });
    expect(tree.getNode(skill)).toMatchObject({ depth: 1, scope: "global", origin: "latent" });
    expect(tree.getNode(section)).toMatchObject({ depth: 2 });
    expect(() => tree.createNode(section, { title: "too deep" })).toThrow(/sections can't have children/);
    expect(tree.path(section).map((n) => n.title)).toEqual(["Global skills", "Dotfiles", "tmux"]);
  });

  it("attaches nuggets with scope checks and marks ancestors dirty (not the root)", () => {
    const db = new StateDb(":memory:");
    const tree = new Tree(db);
    const root = tree.ensureRoot({ scope: "global" });
    const skill = tree.createNode(root, { title: "S" });
    const section = tree.createNode(skill, { title: "s" });
    tree.updateNode(skill, { summaryDirty: false });
    const g = db.insertNugget(nugget("a"));
    const r = db.insertNugget(nugget("b", { scope: "repo", repo: "/w/A" }));

    tree.attachNugget(g, section, { lock: true });
    expect(tree.getNode(section)!.summaryDirty).toBe(true);
    expect(tree.getNode(skill)!.summaryDirty).toBe(true);
    expect(tree.getNode(root)!.summaryDirty).toBe(false);
    expect(db.getNugget(g)).toMatchObject({ nodeId: section, assignmentLocked: true });
    expect(() => tree.attachNugget(r, section)).toThrow(/Scope mismatch/);
    expect(() => tree.attachNugget(g, root)).toThrow(/not to a root/);
  });

  it("moves nodes between parents, changing depth only for leaves", () => {
    const db = new StateDb(":memory:");
    const tree = new Tree(db);
    const root = tree.ensureRoot({ scope: "global" });
    const a = tree.createNode(root, { title: "A" });
    const b = tree.createNode(root, { title: "B" });
    const bSection = tree.createNode(b, { title: "b1" });

    tree.moveNode(a, b); // A (no children) becomes a section of B
    expect(tree.getNode(a)).toMatchObject({ depth: 2, parentId: b });
    tree.moveNode(a, root); // and back to a skill
    expect(tree.getNode(a)).toMatchObject({ depth: 1, parentId: root });
    expect(() => tree.moveNode(b, a)).toThrow(/has children/);
    expect(() => tree.moveNode(a, bSection)).toThrow(/section/);
    const other = tree.ensureRoot({ scope: "repo", repo: "/w/A" });
    expect(() => tree.moveNode(a, other)).toThrow(/Scope mismatch/);
  });

  it("prunes empty latent nodes bottom-up, keeping roots, declared and file nodes", () => {
    const db = new StateDb(":memory:");
    const tree = new Tree(db);
    const root = tree.ensureRoot({ scope: "global" });
    const empty = tree.createNode(root, { title: "empty" });
    tree.createNode(empty, { title: "empty section" });
    tree.createNode(root, { title: "declared", origin: "declared" });
    tree.createNode(root, { title: "from file", origin: "file" });
    const proposed = tree.createNode(root, { title: "proposed" });
    tree.updateNode(proposed, { status: "proposed" });
    const used = tree.createNode(root, { title: "used" });
    tree.attachNugget(db.insertNugget(nugget("a")), used);

    expect(tree.pruneEmpty()).toBe(2);
    expect(tree.trees()[0]!.children.map((c) => c.title)).toEqual(["declared", "from file", "proposed", "used"]);
  });
});

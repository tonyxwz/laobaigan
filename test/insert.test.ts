import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { buildSkillPrompt, detachLatent, insertNuggets } from "../src/pipeline/insert.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";
import { subtreeNuggets, Tree } from "../src/state/tree.ts";

const nugget = (title: string, over: Partial<NuggetInsert> = {}): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId: title,
  cwd: "/",
  kind: "fact",
  title,
  knowledge: `${title} knowledge`,
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: "q" }],
  ...over,
});

type Answer = (req: PiRequest<TSchema>) => unknown;
class Scripted implements PiRunner {
  calls: PiRequest<TSchema>[] = [];
  private answers: Answer[];
  constructor(answers: Answer[]) {
    this.answers = answers;
  }
  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    this.calls.push(req as unknown as PiRequest<TSchema>);
    const next = this.answers.shift();
    if (!next) throw new Error(`unexpected call: ${req.resultTool.name}`);
    return { value: next(req as unknown as PiRequest<TSchema>) as Static<S>, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 } };
  }
}

/** Global tree with a live "git-worktree" skill (2 sections) and a declared "dotfiles-management" skill. */
function setup() {
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  const root = tree.ensureRoot({ scope: "global" });
  const gradle = tree.createNode(root, { title: "Git worktrees", name: "git-worktree", description: "Use git worktree.", origin: "file", summary: "intro" });
  const cmds = tree.createNode(gradle, { title: "Commands", origin: "file", summary: "git worktree add -b <branch>" });
  const layout = tree.createNode(gradle, { title: "Layout", origin: "file", summary: "worktrees live in ../worktrees" });
  const dot = tree.createNode(root, { title: "Dotfiles management", name: "dotfiles-management", description: "zsh, tmux, agent configs", origin: "declared" });
  return { db, tree, root, gradle, cmds, layout, dot };
}

const ids = (p: string) => [...p.matchAll(/<nugget id="(\d+)"/g)].map((m) => Number(m[1]));

describe("insertNuggets", () => {
  it("routes to a live skill, then into a live section, flagging already-covered knowledge", async () => {
    const { db, tree, gradle, cmds } = setup();
    const n = db.insertNugget(nugget("Use git worktree, not a second clone"));
    const runner = new Scripted([
      (r) => {
        expect(r.resultTool.name).toBe("route_to_skills");
        expect(r.prompt).toContain(`<skill id="${gradle}" kind="live" name="git-worktree">`);
        expect(r.prompt).toContain('kind="declared" name="dotfiles-management"');
        expect(r.prompt).toContain("sections: Commands | Layout");
        return { newSkills: [], placements: [{ nuggetId: n, skillId: gradle }] };
      },
      (r) => {
        expect(r.resultTool.name).toBe("route_to_sections");
        expect(r.prompt).toContain("git worktree add -b <branch>");
        return { newSections: [], placements: [{ nuggetId: n, sectionId: cmds, alreadyCovered: true }] };
      },
    ]);
    const res = await insertNuggets(tree, runner, DEFAULT_CONFIG);
    expect(res).toMatchObject({ placed: 1, covered: 1, calls: 2, skillsCreated: [], sectionsCreated: [] });
    expect(db.getNugget(n)).toMatchObject({ nodeId: cmds, coveredNodeId: cmds });
    expect(tree.getNode(cmds)!.summaryDirty).toBe(true);
  });

  it("grows sections in a declared skill receiving several nuggets", async () => {
    const { db, tree, dot } = setup();
    const zsh = db.insertNugget(nugget("zsh profiles by hostname"));
    const tmux = db.insertNugget(nugget("tmux config in ~/.tmux.conf.local"));
    const pi = db.insertNugget(nugget("pi skills live in ~/.pi/agent/skills"));
    const runner = new Scripted([
      (r) => ({ newSkills: [], placements: ids(r.prompt).map((nuggetId) => ({ nuggetId, skillId: dot })) }),
      () => ({
        newSections: [
          { key: "z", title: "zsh", description: "shell startup" },
          { key: "t", title: "tmux", description: "tmux" },
          { key: "p", title: "pi", description: "pi agent config" },
        ],
        placements: [
          { nuggetId: zsh, newSectionKey: "z" },
          { nuggetId: tmux, newSectionKey: "t" },
          { nuggetId: pi, newSectionKey: "p" },
        ],
      }),
    ]);
    const res = await insertNuggets(tree, runner, DEFAULT_CONFIG);
    expect(res.sectionsCreated).toEqual(["dotfiles-management › zsh", "dotfiles-management › tmux", "dotfiles-management › pi"]);
    const d = tree.subtree(dot)!;
    expect(d.children.map((c) => [c.title, c.origin, c.nuggets.map((x) => x.id)])).toEqual([
      ["zsh", "latent", [zsh]],
      ["tmux", "latent", [tmux]],
      ["pi", "latent", [pi]],
    ]);
    expect(d.origin).toBe("declared");
  });

  it("creates new skills (valid, unique names); skips level 2 when there is nothing to decide", async () => {
    const { db, tree, root } = setup();
    const a = db.insertNugget(nugget("ssh-agent flags"));
    const b = db.insertNugget(nugget("ssh-agent forwarding"));
    const runner = new Scripted([
      () => ({
        newSkills: [
          { key: "m", title: "SSH auth", name: "Bad Name!", description: "ssh-agent and friends" },
          { key: "m2", title: "Dotfiles management", name: "dotfiles-management", description: "dup name" },
        ],
        placements: [
          { nuggetId: a, newSkillKey: "m" },
          { nuggetId: b, newSkillKey: "m2" },
        ],
      }),
      // level 2 for the new latent skill "m" isn't called (1 nugget); "m2" neither.
    ]);
    const res = await insertNuggets(tree, runner, DEFAULT_CONFIG);
    expect(res.calls).toBe(1);
    expect(res.skillsCreated).toEqual(["ssh-auth", "dotfiles-management-3"]);
    const created = tree.children(root).filter((c) => c.origin === "latent");
    expect(created.map((c) => [c.name, c.description])).toEqual([
      ["ssh-auth", "ssh-agent and friends"],
      ["dotfiles-management-3", "dup name"],
    ]);
    expect(db.getNugget(a)!.nodeId).toBe(created[0]!.id);
  });

  it("makes no call for a single nugget in an empty scope; never mixes scopes", async () => {
    const db = new StateDb(":memory:");
    const tree = new Tree(db);
    db.insertNugget(nugget("repo fact", { scope: "repo", repo: "/w/A" }));
    const runner = new Scripted([]);
    const res = await insertNuggets(tree, runner, DEFAULT_CONFIG);
    expect(res).toMatchObject({ calls: 0, placed: 1, skillsCreated: ["repo-fact"] });
    expect(tree.trees({ scope: "repo", repo: "/w/A" })[0]!.children).toHaveLength(1);
    expect(tree.trees({ scope: "global" })).toEqual([]);
  });

  it("repairs invalid targets: unknown skill → new skill, unknown section → body; covered on latent text is ignored", async () => {
    const { db, tree, dot } = setup();
    const latentSection = tree.createNode(dot, { title: "zsh" });
    const a = db.insertNugget(nugget("alpha"));
    const b = db.insertNugget(nugget("beta"));
    const runner = new Scripted([
      () => ({ newSkills: [], placements: [{ nuggetId: a, skillId: 999 }, { nuggetId: b, skillId: dot }] }),
      () => ({ newSections: [], placements: [{ nuggetId: b, sectionId: latentSection, alreadyCovered: true }] }),
    ]);
    const res = await insertNuggets(tree, runner, DEFAULT_CONFIG);
    expect(res.repairs).toContain("nugget " + a + ": invalid target 999");
    expect(res.skillsCreated).toEqual(["alpha"]);
    expect(db.getNugget(b)).toMatchObject({ nodeId: latentSection });
    expect(db.getNugget(b)!.coveredNodeId).toBeUndefined();
    expect(res.covered).toBe(0);
  });

  it("defers everything when the call budget is exhausted", async () => {
    const { db, tree } = setup();
    db.insertNugget(nugget("a"));
    db.insertNugget(nugget("b"));
    const res = await insertNuggets(tree, new Scripted([]), DEFAULT_CONFIG, { maxCalls: 0 });
    expect(res).toMatchObject({ placed: 0, deferred: 2, calls: 0 });
    expect(tree.unplacedNuggets()).toHaveLength(2);
  });

  it("appends clustering guidance; puts the skill list before the nuggets", async () => {
    const { db, tree, root, gradle } = setup();
    const n = db.insertNugget(nugget("x"));
    const runner = new Scripted([() => ({ newSkills: [], placements: [{ nuggetId: n, skillId: gradle }] }), () => ({ newSections: [], placements: [{ nuggetId: n, body: true }] })]);
    await insertNuggets(tree, runner, { ...DEFAULT_CONFIG, clustering: { guidance: "Prefer umbrellas." } });
    expect(runner.calls[0]!.systemPrompt).toContain("Prefer umbrellas.");
    const p = buildSkillPrompt(tree.subtree(root)!, [db.getNugget(n)!]);
    expect(p.indexOf("<skills>")).toBeLessThan(p.indexOf("<new_nuggets>"));
  });
});

describe("detachLatent", () => {
  it("takes unlocked nuggets out of open/candidate latent skills and prunes them", () => {
    const { db, tree, root, gradle } = setup();
    const latent = tree.createNode(root, { title: "Worktree isolation" });
    const locked = tree.createNode(root, { title: "curated", locked: true });
    const proposed = tree.createNode(root, { title: "proposed" });
    tree.updateNode(proposed, { status: "proposed" });
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((t) => db.insertNugget(nugget(t)));
    tree.attachNugget(a!, latent);
    tree.attachNugget(b!, latent, { lock: true }); // placed by hand: stays
    tree.attachNugget(c!, locked);
    tree.attachNugget(d!, proposed);
    tree.attachNugget(e!, gradle); // live: stays

    expect(detachLatent(tree).map((n) => n.id)).toEqual([a]);
    expect(subtreeNuggets(tree.subtree(latent)!).map((n) => n.id)).toEqual([b]);
    expect(tree.unplacedNuggets().map((n) => n.id)).toEqual([a]);
  });
});

describe("insertNuggets: repo nuggets without a repo", () => {
  it("files them under the session's working directory instead of failing the stage", async () => {
    const db = new StateDb(":memory:");
    const tree = new Tree(db);
    const orphan = db.insertNugget(nugget("eval configs", { scope: "repo", cwd: "/w/bench" })); // no repo (workspace root)
    const lost = db.insertNugget(nugget("nowhere", { scope: "repo", cwd: "" }));
    const global = db.insertNugget(nugget("git push"));
    const res = await insertNuggets(tree, new Scripted([]), DEFAULT_CONFIG);
    expect(res.placed).toBe(2); // single nugget per empty scope: no calls
    expect(db.getNugget(orphan)).toMatchObject({ repo: "/w/bench", nodeId: expect.any(Number) });
    expect(tree.trees({ scope: "repo", repo: "/w/bench" })[0]!.children).toHaveLength(1);
    expect(db.getNugget(global)!.nodeId).toBeDefined();
    expect(db.getNugget(lost)!.nodeId).toBeUndefined();
    expect(res.repairs.join("\n")).toMatch(new RegExp(`nugget ${lost}: repo-specific but no repository`));
  });
});

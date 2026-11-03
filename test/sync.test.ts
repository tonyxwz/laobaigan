import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstSentence, parseAgentsMd, parseSkill, splitByHeading } from "../src/skills/parse.ts";
import { syncDeclared, syncTree } from "../src/pipeline/sync.ts";
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

const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\n# ${name}\n\n${body}`;

async function skillsDir() {
  const dir = await mkdtemp(join(tmpdir(), "lbg-skills-"));
  const write = async (name: string, body: string, refs: Record<string, string> = {}) => {
    await mkdir(join(dir, name, "references"), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), skillMd(name, body));
    for (const [f, c] of Object.entries(refs)) await writeFile(join(dir, name, "references", f), c);
  };
  return { dir, write };
}

describe("parse", () => {
  it("splits on headings, ignoring fenced code", () => {
    const md = "intro\n\n## A\na body\n```sh\n## not a heading\n```\n## B\nb body";
    const { preamble, parts } = splitByHeading(md, 2);
    expect(preamble).toBe("intro");
    expect(parts.map((p) => p.title)).toEqual(["A", "B"]);
    expect(parts[0]!.body).toContain("## not a heading");
  });

  it("parses a SKILL.md with sections and references", () => {
    const p = parseSkill(
      "/s/gradle/SKILL.md",
      skillMd("gradle", "Overview text.\n\n## Build commands\nRun `make`. More.\n\n## Build commands\ndup"),
      [{ path: "/s/gradle/references/release.md", content: "# Releasing\n\nUse bb release." }],
      ["/s/gradle/references/x.py"],
    );
    expect(p).toMatchObject({ name: "gradle", title: "gradle", description: "Use for gradle.", intro: "Overview text." });
    expect(p.sections.map((s) => [s.title, s.sourcePath, s.description])).toEqual([
      ["Build commands", "/s/gradle/SKILL.md#build-commands", "Run `make`."],
      ["Build commands", "/s/gradle/SKILL.md#build-commands-2", "dup"],
      ["Releasing", "/s/gradle/references/release.md", "Use bb release."],
    ]);
    expect(p.resources).toEqual(["/s/gradle/references/x.py"]);
  });

  it("parses AGENTS.md into sections with subsections", () => {
    const a = parseAgentsMd("/r/AGENTS.md", "# Agents\n\nAlways read this.\n\n## Build\nUse hatch.\n### Tests\nRun pytest.\n## Style\nBlack.");
    expect(a.preamble).toBe("Always read this.");
    expect(a.sections.map((s) => [s.title, s.sourcePath, s.sections.map((x) => x.sourcePath)])).toEqual([
      ["Build", "/r/AGENTS.md#build", ["/r/AGENTS.md#build/tests"]],
      ["Style", "/r/AGENTS.md#style", []],
    ]);
  });

  it("regression: a skill's hash doesn't depend on where the skills dir lives", () => {
    const md = skillMd("gradle", "Intro.\n\n## Build\nbuild text");
    const at = (dir: string) =>
      parseSkill(`${dir}/gradle/SKILL.md`, md, [{ path: `${dir}/gradle/references/notes.md`, content: "# Notes\nn" }]).hash;
    expect(at("/home/me/.config/opencode/skills")).toBe(at("/tmp/sandbox/skills"));
    // …but it does change when a reference is renamed or edited
    const renamed = parseSkill("/x/gradle/SKILL.md", md, [{ path: "/x/gradle/references/other.md", content: "# Notes\nn" }]).hash;
    const edited = parseSkill("/x/gradle/SKILL.md", md, [{ path: "/x/gradle/references/notes.md", content: "# Notes\nchanged" }]).hash;
    expect(new Set([at("/x"), renamed, edited]).size).toBe(3);
  });

  it("takes the first sentence outside code for routing", () => {
    expect(firstSentence("```\ntree\n```\nThe layout is flat. Second.")).toBe("The layout is flat.");
  });
});

describe("syncTree", () => {
  it("mirrors skills as live nodes; re-sync is a no-op; edits update; nuggets survive", async () => {
    const { dir, write } = await skillsDir();
    await write("gradle", "Intro.\n\n## Build\nbuild text\n\n## Test\ntest text", { "release.md": "# Release\nrelease text" });
    await write("tmux", "Config lives in ~/.tmux.conf.local.");
    const db = new StateDb(":memory:");
    const tree = new Tree(db);

    let r = await syncTree(tree, { skillsDir: dir, declared: [] });
    expect(r.global.created).toEqual(["gradle", "tmux"]);
    const root = tree.trees({ scope: "global" })[0]!;
    const gradle = root.children.find((c) => c.name === "gradle")!;
    expect(gradle).toMatchObject({ origin: "file", description: "Use for gradle.", summary: "Intro.", summaryDirty: false });
    expect(gradle.renderedAt).toBeInstanceOf(Date);
    expect(gradle.children.map((c) => [c.title, c.origin])).toEqual([
      ["Build", "file"],
      ["Test", "file"],
      ["Release", "file"],
    ]);

    // attach evidence to the "Test" section and the tmux skill
    const test = gradle.children[1]!;
    const g1 = db.insertNugget(nugget("a"));
    tree.attachNugget(g1, test.id);
    const tmux = root.children.find((c) => c.name === "tmux")!;
    tree.attachNugget(db.insertNugget(nugget("b")), tmux.id);

    r = await syncTree(tree, { skillsDir: dir, declared: [] });
    expect(r.global).toMatchObject({ created: [], updated: [], unchanged: 2 });

    // I rename the Test section and delete tmux: the nugget moves up to the skill; tmux turns latent
    await write("gradle", "Intro.\n\n## Build\nbuild text\n\n## Testing\ntest text", { "release.md": "# Release\nrelease text" });
    await rm(join(dir, "tmux"), { recursive: true });
    r = await syncTree(tree, { skillsDir: dir, declared: [] });
    expect(r.global.updated).toEqual(["gradle"]);
    expect(r.global.removed).toEqual(["tmux"]);
    const b2 = tree.subtree(gradle.id)!;
    expect(b2.children.map((c) => c.title)).toEqual(["Build", "Release", "Testing"]);
    expect(b2.nuggets.map((n) => n.id)).toEqual([g1]);
    expect(tree.getNode(tmux.id)).toMatchObject({ origin: "latent" });
    expect(tree.getNode(tmux.id)!.sourcePath).toBeUndefined();
  });

  it("regression: keeps nodes, evidence and render time when the skills dir moves (matched by name)", async () => {
    const { dir, write } = await skillsDir();
    await write("gradle", "Intro.\n\n## Build\nbuild text", { "notes.md": "# Notes\nn" });
    const db = new StateDb(":memory:");
    const tree = new Tree(db);
    await syncTree(tree, { skillsDir: dir, declared: [] });
    const before = tree.trees()[0]!.children[0]!;
    const n = db.insertNugget(nugget("a"));
    tree.attachNugget(n, before.children[0]!.id);

    const moved = await mkdtemp(join(tmpdir(), "lbg-moved-"));
    await mkdir(join(moved, "gradle", "references"), { recursive: true });
    await writeFile(join(moved, "gradle", "SKILL.md"), skillMd("gradle", "Intro.\n\n## Build\nbuild text"));
    await writeFile(join(moved, "gradle", "references", "notes.md"), "# Notes\nn");
    const r = await syncTree(tree, { skillsDir: moved, declared: [] });
    expect(r.global).toMatchObject({ created: [], removed: [], adopted: ["gradle"] });
    const after = tree.trees()[0]!.children;
    expect(after.map((c) => [c.id, c.origin, c.sourcePath])).toEqual([[before.id, "file", join(moved, "gradle", "SKILL.md")]]);
    expect(after[0]!.children.map((c) => [c.id, c.nuggets.map((x) => x.id)])).toEqual([
      [before.children[0]!.id, [n]],
      [before.children[1]!.id, []],
    ]);
    expect(after[0]!.renderedAt).toEqual(before.renderedAt); // a move isn't an edit
  });

  it("deletes vanished skills without evidence; follows symlinked skill dirs", async () => {
    const { dir, write } = await skillsDir();
    const elsewhere = await mkdtemp(join(tmpdir(), "lbg-real-"));
    await mkdir(join(elsewhere, "linked"));
    await writeFile(join(elsewhere, "linked", "SKILL.md"), skillMd("linked", "x"));
    await symlink(join(elsewhere, "linked"), join(dir, "linked"));
    await write("gone", "x");
    const tree = new Tree(new StateDb(":memory:"));
    expect((await syncTree(tree, { skillsDir: dir, declared: [] })).global.created).toEqual(["gone", "linked"]);
    await rm(join(dir, "gone"), { recursive: true });
    await syncTree(tree, { skillsDir: dir, declared: [] });
    expect(tree.trees()[0]!.children.map((c) => c.name)).toEqual(["linked"]);
  });

  it("adopts a latent node when a skill of the same name appears (a merged proposal goes live)", async () => {
    const { dir, write } = await skillsDir();
    const db = new StateDb(":memory:");
    const tree = new Tree(db);
    const root = tree.ensureRoot({ scope: "global" });
    const latent = tree.createNode(root, { title: "Dotfiles", name: "dotfiles-management" });
    const tmuxSection = tree.createNode(latent, { title: "tmux" });
    const n = db.insertNugget(nugget("a"));
    tree.attachNugget(n, tmuxSection);

    await write("dotfiles-management", "Shared workflow.\n\n## tmux\nConfig in ~/.tmux.conf.local.");
    const r = await syncTree(tree, { skillsDir: dir, declared: [] });
    expect(r.global.adopted).toEqual(["dotfiles-management"]);
    const live = tree.subtree(latent)!;
    expect(live).toMatchObject({ id: latent, origin: "file", summary: "Shared workflow." });
    expect(live.children.map((c) => [c.id, c.title, c.origin])).toEqual([[tmuxSection, "tmux", "file"]]);
    expect(subtreeNuggets(live).map((x) => x.id)).toEqual([n]);
  });

  it("syncs repo AGENTS.md and .agents/skills for repos the tree knows", async () => {
    const repo = await mkdtemp(join(tmpdir(), "lbg-repo-"));
    await writeFile(join(repo, "AGENTS.md"), "# Agents\n\nPreamble.\n\n## Build\nUse hatch.\n### Tests\npytest\n## Style\nBlack.");
    await writeFile(join(repo, "CLAUDE.md"), "@AGENTS.md\n");
    await mkdir(join(repo, ".agents", "skills", "run-evals"), { recursive: true });
    await writeFile(join(repo, ".agents", "skills", "run-evals", "SKILL.md"), skillMd("run-evals", "Steps."));
    const { dir } = await skillsDir();
    const tree = new Tree(new StateDb(":memory:"));
    tree.ensureRoot({ scope: "repo", repo }); // the tree knows the repo (it has evidence)

    const r = await syncTree(tree, { skillsDir: dir, declared: [] });
    expect(r.repos[repo]!.created).toEqual(["build", "style", "run-evals"]);
    const root = tree.trees({ scope: "repo", repo })[0]!;
    expect(root).toMatchObject({ summary: "Preamble.", sourcePath: join(repo, "AGENTS.md") });
    expect(root.children.map((c) => [c.title, c.children.map((x) => x.title)])).toEqual([
      ["Build", ["Tests"]],
      ["Style", []],
      ["run-evals", []],
    ]);

    // removing the repo skill doesn't touch AGENTS.md sections, and vice versa
    await rm(join(repo, ".agents"), { recursive: true });
    await syncTree(tree, { skillsDir: dir, declared: [] });
    expect(tree.trees({ scope: "repo", repo })[0]!.children.map((c) => c.title)).toEqual(["Build", "Style"]);
  });
});

describe("syncDeclared", () => {
  it("creates pinned nodes, lets a file skill win, un-declares removed ones", async () => {
    const { dir, write } = await skillsDir();
    await write("gradle", "x");
    const tree = new Tree(new StateDb(":memory:"));
    await syncTree(tree, { skillsDir: dir, declared: [] });

    const r = syncDeclared(tree, [
      { name: "dotfiles-management", description: "zsh, tmux" },
      { name: "gradle", description: "builds" },
    ]);
    expect(r).toMatchObject({ created: ["dotfiles-management"], unchanged: 1 });
    const root = tree.trees()[0]!;
    expect(root.children.map((c) => [c.name, c.origin, c.description])).toEqual([
      ["gradle", "file", "Use for gradle."],
      ["dotfiles-management", "declared", "zsh, tmux"],
    ]);
    expect(syncDeclared(tree, []).removed).toEqual(["dotfiles-management"]);
    expect(tree.trees()[0]!.children.map((c) => c.name)).toEqual(["gradle"]); // empty → pruned
  });
});

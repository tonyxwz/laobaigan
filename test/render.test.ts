import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { acceptProposal, conflicts, proposalDiff, rejectProposal } from "../src/pipeline/accept.ts";
import { draftCandidates, draftSkill } from "../src/pipeline/render.ts";
import { syncTree } from "../src/pipeline/sync.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Proposals } from "../src/state/proposals.ts";
import { Tree } from "../src/state/tree.ts";
import { fauxRunner, toolResults } from "./helpers/faux.ts";

const nugget = (sessionId: string, over: Partial<NuggetInsert> = {}): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId,
  cwd: "/",
  kind: "correction",
  title: `fact from ${sessionId}`,
  knowledge: `knowledge from ${sessionId}`,
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: `quote ${sessionId}`, ts: "2026-11-01T10:00:00.000Z" }],
  ...over,
});

const SKILL_MD = (name: string, desc = "Dotfiles in the ~/.cfg bare repo. Use when editing zsh, tmux, or agent configs.") =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# Dotfiles\n\nShared workflow.\n\nSee references/tmux.md for tmux.\n`;

/** Global skills dir with a live "gradle" skill; a latent dotfiles candidate with two sections. */
async function globalSetup() {
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  await mkdir(join(skillsDir, "gradle"));
  await writeFile(join(skillsDir, "gradle", "SKILL.md"), "---\nname: gradle\ndescription: Gradle builds.\n---\n\n# Gradle\n");
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  await syncTree(tree, { skillsDir, declared: [] });
  const root = tree.ensureRoot({ scope: "global" });
  const dot = tree.createNode(root, { title: "Dotfiles management", name: "dotfiles-management", description: "zsh, tmux, agent configs" });
  const tmux = tree.createNode(dot, { title: "tmux" });
  const zsh = tree.createNode(dot, { title: "zsh" });
  for (const [s, node] of [["a", tmux], ["b", zsh], ["c", dot]] as const) tree.attachNugget(db.insertNugget(nugget(s)), node);
  scoreTree(tree, cfg.score);
  expect(tree.getNode(dot)).toMatchObject({ status: "candidate", proposalKind: "new" });
  return { skillsDir, cfg, db, tree, dot };
}

const report = (summary = "Added the dotfiles skill.") => fauxAssistantMessage([fauxToolCall("report_draft", { summary })], { stopReason: "toolUse" });

describe("draftSkill → accept (global skill)", () => {
  it("drafts in a scratch copy, stores the files, leaves the live dir alone; accept writes and makes it live", async () => {
    const { skillsDir, cfg, db, tree, dot } = await globalSetup();
    let prompt = "";
    let seen: ReturnType<typeof toolResults> = [];
    const runner = await fauxRunner([
      (ctx) => {
        prompt = JSON.stringify((ctx as { messages: unknown[] }).messages);
        return fauxAssistantMessage(
          [
            fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL_MD("dotfiles-management") }),
            fauxToolCall("write", { path: "dotfiles-management/references/tmux.md", content: "# tmux\n\nConfig in ~/.tmux.conf.local.\n" }),
            fauxToolCall("write", { path: "gradle/SKILL.md", content: "pwned" }),
          ],
          { stopReason: "toolUse" },
        );
      },
      (ctx) => {
        seen = toolResults(ctx as never);
        return report();
      },
    ]);

    const out = await draftSkill(tree, runner, cfg, dot);
    expect(out).toMatchObject({ status: "open" });
    expect(prompt).toContain("knowledge from a");
    expect(prompt).toContain('section \\"tmux\\"');
    expect(prompt).toContain("gradle: Gradle builds."); // other skills listed, to avoid duplicates
    expect(seen.find((r) => r.isError)?.text).toMatch(/not writable/);

    // nothing live changed; the draft is in the db
    expect(existsSync(join(skillsDir, "dotfiles-management"))).toBe(false);
    expect(readFileSync(join(skillsDir, "gradle", "SKILL.md"), "utf8")).toContain("Gradle builds");
    const props = new Proposals(db);
    const p = props.get((out as { proposalId: number }).proposalId)!;
    expect(p).toMatchObject({ status: "open", targetRoot: skillsDir, summary: "Added the dotfiles skill." });
    expect(p.files.map((f) => [f.path, f.baseHash])).toEqual([
      ["dotfiles-management/SKILL.md", null],
      ["dotfiles-management/references/tmux.md", null],
    ]);
    expect(tree.getNode(dot)!.status).toBe("proposed");
    expect(await proposalDiff(p)).toContain("+name: dotfiles-management");
    expect((await readdir(tmpdir())).filter((d) => d.startsWith("lbg-draft-"))).toEqual([]); // scratch removed

    // accept
    const acc = await acceptProposal(tree, cfg, p.id);
    expect(acc.written).toEqual(["dotfiles-management/SKILL.md", "dotfiles-management/references/tmux.md"]);
    expect(acc.commitMessage).toMatch(/^skills: add dotfiles-management/);
    expect(readFileSync(join(skillsDir, "dotfiles-management", "references", "tmux.md"), "utf8")).toContain("tmux.conf.local");
    expect(props.get(p.id)!.status).toBe("accepted");
    const live = tree.getNode(dot)!;
    expect(live).toMatchObject({ origin: "file", status: "open" });
    // evidence is absorbed: no new proposal until new sessions arrive
    scoreTree(tree, cfg.score);
    expect(tree.getNode(dot)!.status).toBe("open");
  });

  it("fails verification (bad frontmatter, nothing written), keeps the node a candidate", async () => {
    const { skillsDir, cfg, db, tree, dot } = await globalSetup();
    const runner = await fauxRunner([
      fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL_MD("Dotfiles Management") })], { stopReason: "toolUse" }),
      report(),
    ]);
    const out = await draftSkill(tree, runner, cfg, dot);
    expect(out).toMatchObject({ status: "failed", reason: expect.stringMatching(/frontmatter name must be "dotfiles-management"/) });
    expect(tree.getNode(dot)!.status).toBe("candidate");
    expect(new Proposals(db).list(["failed"])).toHaveLength(1);
    expect(existsSync(join(skillsDir, "dotfiles-management"))).toBe(false);

    const empty = await fauxRunner([report()]);
    expect(await draftSkill(tree, empty, cfg, dot)).toMatchObject({ status: "failed", reason: expect.stringMatching(/no files were changed/) });
  });

  it("refuses stale accepts unless forced; reject keeps the files out", async () => {
    const { skillsDir, cfg, tree, dot, db } = await globalSetup();
    const draftOnce = async () =>
      draftSkill(
        tree,
        await fauxRunner([fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL_MD("dotfiles-management") })], { stopReason: "toolUse" }), report()]),
        cfg,
        dot,
      );
    const first = (await draftOnce()) as { proposalId: number };
    rejectProposal(tree, first.proposalId, "not now");
    expect(existsSync(join(skillsDir, "dotfiles-management"))).toBe(false);
    expect(tree.getNode(dot)!.status).toBe("rejected");

    tree.updateNode(dot, { status: "candidate" });
    const second = (await draftOnce()) as { proposalId: number };
    await mkdir(join(skillsDir, "dotfiles-management"));
    await writeFile(join(skillsDir, "dotfiles-management", "SKILL.md"), "I wrote this by hand meanwhile");
    const p = new Proposals(db).get(second.proposalId)!;
    expect(await conflicts(p)).toEqual([{ path: "dotfiles-management/SKILL.md", reason: "now exists (it didn't when drafted)" }]);
    await expect(acceptProposal(tree, cfg, p.id)).rejects.toThrow(/is stale/);
    await acceptProposal(tree, cfg, p.id, { force: true });
    expect(readFileSync(join(skillsDir, "dotfiles-management", "SKILL.md"), "utf8")).toContain("name: dotfiles-management");
  });
});

describe("draftSkill (repo AGENTS.md section update)", () => {
  async function repoSetup(steps: FauxResponseStep[]) {
    const repo = realpathSync(await mkdtemp(join(tmpdir(), "lbg-repo-")));
    await mkdir(join(repo, ".git"));
    await writeFile(join(repo, "AGENTS.md"), "# Agents\n\nRead me.\n\n## Build\nUse hatch.\n\n## Style\nBlack.\n");
    const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
    const cfg: Config = { ...DEFAULT_CONFIG, skillsDir };
    const db = new StateDb(":memory:");
    const tree = new Tree(db);
    tree.ensureRoot({ scope: "repo", repo });
    await syncTree(tree, { skillsDir, declared: [] });
    const build = tree.trees({ scope: "repo", repo })[0]!.children.find((c) => c.title === "Build")!;
    tree.updateNode(build.id, { renderedAt: new Date(Date.now() - 60_000) });
    for (const s of ["a", "b"]) tree.attachNugget(db.insertNugget(nugget(s, { scope: "repo", repo })), build.id);
    scoreTree(tree, cfg.score);
    expect(tree.getNode(build.id)).toMatchObject({ status: "candidate", proposalKind: "update" });
    return { repo, cfg, tree, build: build.id, runner: await fauxRunner(steps) };
  }

  it("may change only the target section", async () => {
    const good = await repoSetup([
      fauxAssistantMessage([fauxToolCall("edit", { path: "AGENTS.md", edits: [{ oldText: "Use hatch.", newText: "Use hatch: `hatch run test`." }] })], { stopReason: "toolUse" }),
      report("Build: added the test command."),
    ]);
    const out = await draftSkill(good.tree, good.runner, good.cfg, good.build);
    expect(out).toMatchObject({ status: "open", files: [{ path: "AGENTS.md" }] });
    expect(readFileSync(join(good.repo, "AGENTS.md"), "utf8")).toContain("Use hatch.\n"); // untouched until accept
    await acceptProposal(good.tree, good.cfg, (out as { proposalId: number }).proposalId);
    expect(readFileSync(join(good.repo, "AGENTS.md"), "utf8")).toContain("`hatch run test`");

    const bad = await repoSetup([
      fauxAssistantMessage([fauxToolCall("edit", { path: "AGENTS.md", edits: [{ oldText: "Black.", newText: "Ruff." }] })], { stopReason: "toolUse" }),
      report(),
    ]);
    expect(await draftSkill(bad.tree, bad.runner, bad.cfg, bad.build)).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/section "Style" changed; only "Build" may change/),
    });
  });
});

describe("draftCandidates", () => {
  it("skips non-candidates and workspace roots, respects the budget", async () => {
    const { cfg, tree, db, dot } = await globalSetup();
    const ws = realpathSync(await mkdtemp(join(tmpdir(), "lbg-ws-")));
    await mkdir(join(ws, "src", "Pkg", ".git"), { recursive: true });
    await writeFile(join(ws, "packageInfo"), "");
    const wsRoot = tree.ensureRoot({ scope: "repo", repo: ws });
    const wsSkill = tree.createNode(wsRoot, { title: "Workspace facts" });
    for (const s of ["x", "y", "z"]) tree.attachNugget(db.insertNugget(nugget(s, { scope: "repo", repo: ws })), wsSkill);
    scoreTree(tree, cfg.score);

    const out = await draftCandidates(tree, await fauxRunner([]), cfg, { max: 0 });
    expect(out).toEqual([]);
    const skipped = await draftSkill(tree, await fauxRunner([]), cfg, wsSkill);
    expect(skipped).toMatchObject({ status: "skipped", reason: expect.stringMatching(/workspace roots/) });
    expect(await draftSkill(tree, await fauxRunner([]), cfg, tree.ensureRoot({ scope: "global" }))).toMatchObject({ status: "skipped" });
    expect(tree.getNode(dot)!.status).toBe("candidate");
  });
});

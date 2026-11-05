import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { acceptProposal, commitTargetFor, conflicts, newSinceDraft, proposalDiff, rejectProposal } from "../src/pipeline/accept.ts";
import { closeDraft, discardDraft, openDraft, reviseProposal } from "../src/pipeline/revise.ts";
import { skillStats } from "../src/pipeline/treescore.ts";
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

describe("proposalDiff", () => {
  it("emits git-style headers for added, modified and deleted files (git apply accepts it)", async () => {
    const { execFileSync } = await import("node:child_process");
    const root = realpathSync(await mkdtemp(join(tmpdir(), "lbg-diff-")));
    await mkdir(join(root, "s"));
    await writeFile(join(root, "s", "SKILL.md"), "one\ntwo\n");
    await writeFile(join(root, "s", "old.md"), "bye\n");
    const p = {
      targetRoot: root,
      files: [
        { path: "s/SKILL.md", baseHash: "x", content: "one\nTWO\n" },
        { path: "s/new.md", baseHash: null, content: "hi\n" },
        { path: "s/old.md", baseHash: "y", content: null },
      ],
    } as unknown as Parameters<typeof proposalDiff>[0];
    const diff = await proposalDiff(p);
    expect(diff).toContain("diff --git a/s/SKILL.md b/s/SKILL.md\n--- a/s/SKILL.md\n+++ b/s/SKILL.md\n@@ -1,2 +1,2 @@");
    expect(diff).toContain("diff --git a/s/new.md b/s/new.md\nnew file mode 100644\n--- /dev/null\n+++ b/s/new.md");
    expect(diff).toContain("diff --git a/s/old.md b/s/old.md\ndeleted file mode 100644\n--- a/s/old.md\n+++ /dev/null");
    expect(diff).not.toMatch(/\t$/m);
    await writeFile(join(root, "p.diff"), diff);
    execFileSync("git", ["apply", "--check", "--directory=", "p.diff"], { cwd: root });
  });
});

describe("evidence that arrives while a proposal is open", () => {
  const writeSkill = () =>
    fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL_MD("dotfiles-management") })], { stopReason: "toolUse" });

  /** Draft the dotfiles candidate, then attach a nugget from a new session afterwards. */
  async function draftThenNewEvidence() {
    const s = await globalSetup();
    const out = (await draftSkill(s.tree, await fauxRunner([writeSkill(), report()]), s.cfg, s.dot)) as { proposalId: number };
    const props = new Proposals(s.db);
    // the earlier evidence came in two minutes ago, the draft a minute ago; the new nugget arrives now
    s.db.db.prepare("UPDATE nugget SET attached_at = ?").run(Date.now() - 120_000);
    s.db.db.prepare("UPDATE proposal SET drafted_at = ? WHERE id = ?").run(Date.now() - 60_000, out.proposalId);
    const late = s.db.insertNugget(nugget("late"));
    s.tree.attachNugget(late, s.dot);
    return { ...s, props, id: out.proposalId, late };
  }

  it("is listed as new since the draft, and still counts as fresh after accept", async () => {
    const { tree, cfg, props, id, late, dot } = await draftThenNewEvidence();
    const p = props.get(id)!;
    expect(p.nuggetIds).not.toContain(late);
    expect(newSinceDraft(tree, p).map((n) => n.id)).toEqual([late]);

    await acceptProposal(tree, cfg, id);
    const live = tree.subtree(dot)!;
    expect(live.origin).toBe("file");
    expect(live.renderedAt!.getTime()).toBe(p.draftedAt.getTime()); // dated to the draft, not to the accept
    // the late nugget isn't in the files, so it is still new evidence for the live skill
    expect(skillStats(live).fresh).toMatchObject({ nuggets: 1, sessions: 1 });
  });

  it("revise shows it to pi as new and takes it in; a hand edit doesn't", async () => {
    const { tree, cfg, props, id, late } = await draftThenNewEvidence();
    const before = props.get(id)!;

    // hand edit: evidence unchanged
    const ws = await openDraft(tree, id);
    await writeFile(join(ws.scratch, "dotfiles-management/SKILL.md"), SKILL_MD("dotfiles-management", "Edited by hand. Use for dotfiles."));
    await closeDraft(tree, cfg, ws);
    await discardDraft(ws);
    expect(props.get(id)).toMatchObject({ draftedAt: before.draftedAt, nuggetIds: before.nuggetIds });
    expect(newSinceDraft(tree, props.get(id)!)).toHaveLength(1);

    // AI revise: the prompt marks it, and afterwards it's part of the draft's evidence
    let prompt = "";
    const runner = await fauxRunner([
      (ctx) => {
        prompt = JSON.stringify((ctx as { messages: unknown[] }).messages);
        return fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL_MD("dotfiles-management", "Revised. Use for dotfiles.") })], { stopReason: "toolUse" });
      },
      report("Added the late fact."),
    ]);
    const r = await reviseProposal(tree, runner, cfg, id, "add what's new");
    expect(r.problems).toEqual([]);
    expect(prompt).toContain("(NEW SINCE THE DRAFT) fact from late");
    expect(prompt.match(/NEW SINCE THE DRAFT\) fact/g)).toHaveLength(1);
    const after = props.get(id)!;
    expect(after.nuggetIds).toContain(late);
    expect(after.draftedAt.getTime()).toBeGreaterThan(before.draftedAt.getTime());
    expect(newSinceDraft(tree, after)).toEqual([]);
  });
});

describe("committing an already-accepted proposal", () => {
  it("gives its files and message, and notes files edited since", async () => {
    const { cfg, tree, dot, db, skillsDir } = await globalSetup();
    const out = (await draftSkill(
      tree,
      await fauxRunner([fauxAssistantMessage([fauxToolCall("write", { path: "dotfiles-management/SKILL.md", content: SKILL_MD("dotfiles-management") })], { stopReason: "toolUse" }), report()]),
      cfg,
      dot,
    )) as { proposalId: number };
    const props = new Proposals(db);
    await expect(commitTargetFor(tree, props.get(out.proposalId)!)).rejects.toThrow(/is open; only accepted/);

    await acceptProposal(tree, cfg, out.proposalId); // forgot --commit
    let t = await commitTargetFor(tree, props.get(out.proposalId)!);
    expect(t).toMatchObject({ paths: [join(skillsDir, "dotfiles-management", "SKILL.md")], changedSince: [] });
    expect(t.commitMessage).toMatch(/^skills: add dotfiles-management/);

    await writeFile(join(skillsDir, "dotfiles-management", "SKILL.md"), SKILL_MD("dotfiles-management", "Tweaked by hand. Use for dotfiles."));
    t = await commitTargetFor(tree, props.get(out.proposalId)!);
    expect(t.changedSince).toEqual(["dotfiles-management/SKILL.md"]);
  });
});

describe("proposalView (stale proposals)", () => {
  it("shows the draft's own change against its base, plus what changed on disk, instead of reverting newer edits", async () => {
    const { proposalView } = await import("../src/pipeline/accept.ts");
    const { hashContent } = await import("../src/state/proposals.ts");
    const root = realpathSync(await mkdtemp(join(tmpdir(), "lbg-stale-")));
    await mkdir(join(root, "s"));
    const base = "# Dotfiles\n\n## zsh\nprofiles\n";
    const draft = "# Dotfiles\n\n## zsh\nprofiles by hostname\n";
    const mine = "# Dotfiles\n\n## zsh\nprofiles\n\n## Emacs\ninit.el\n"; // my edit after the draft
    await writeFile(join(root, "s", "SKILL.md"), mine);
    const p = { targetRoot: root, files: [{ path: "s/SKILL.md", baseHash: hashContent(base), content: draft, baseContent: base }] } as unknown as Parameters<typeof proposalView>[0];

    const v = await proposalView(p);
    expect(v.files).toEqual([{ path: "s/SKILL.md", stale: true, against: "draft-base", onDisk: expect.stringContaining("+## Emacs") }]);
    expect(v.diff).toContain("+profiles by hostname");
    expect(v.diff).not.toContain("Emacs"); // no fake deletion of my newer section

    // not stale: diff against the file on disk, as before
    await writeFile(join(root, "s", "SKILL.md"), base);
    const fresh = await proposalView(p);
    expect(fresh.files[0]).toMatchObject({ stale: false, against: "current", onDisk: "" });
    expect(fresh.diff).toContain("+profiles by hostname");

    // drafts stored before lbg kept originals: falls back to the current file
    await writeFile(join(root, "s", "SKILL.md"), mine);
    const legacy = await proposalView({ ...p, files: [{ path: "s/SKILL.md", baseHash: hashContent(base), content: draft }] } as typeof p);
    expect(legacy.files[0]).toMatchObject({ stale: true, against: "current" });
    expect(legacy.diff).toContain("-## Emacs");
  });

  it("drafts store the original content of each changed file", async () => {
    const { diffSnapshot } = await import("../src/pipeline/render.ts");
    const scratch = realpathSync(await mkdtemp(join(tmpdir(), "lbg-snap-")));
    await mkdir(join(scratch, "s"));
    await writeFile(join(scratch, "s", "SKILL.md"), "new\n");
    await writeFile(join(scratch, "s", "added.md"), "x\n");
    const files = await diffSnapshot(new Map([["s/SKILL.md", "old\n"], ["s/gone.md", "bye\n"]]), scratch, ["s/"]);
    expect(files.map((f) => [f.path, f.baseContent, f.content])).toEqual([
      ["s/SKILL.md", "old\n", "new\n"],
      ["s/added.md", null, "x\n"],
      ["s/gone.md", "bye\n", null],
    ]);
  });
});

describe("openDraft rebases a stale draft onto newer edits", () => {
  async function staleSetup(draftFile: (base: string) => { content: string; baseContent?: string }) {
    const { openDraft, discardDraft, reviseContext } = await import("../src/pipeline/revise.ts");
    const { hashContent } = await import("../src/state/proposals.ts");
    const { cfg, db, tree, dot, skillsDir } = await globalSetup();
    const base = "---\nname: dotfiles-management\ndescription: d\n---\n\n# Dotfiles\n\n## zsh\nprofiles\n\n## tmux\nconf\n";
    await mkdir(join(skillsDir, "dotfiles-management"), { recursive: true });
    const props = new Proposals(db);
    const id = props.create({ nodeId: dot, kind: "new", scope: "global", targetRoot: skillsDir, writable: ["dotfiles-management/"], nuggetIds: [], sessions: 3, skillName: "dotfiles-management" });
    const f = draftFile(base);
    props.markOpen(id, [{ path: "dotfiles-management/SKILL.md", baseHash: hashContent(base), ...f }], "s");
    props.release(id);
    return { cfg, tree, id, skillsDir, base, openDraft, discardDraft, reviseContext };
  }

  it("merges the draft's own change onto the current file when it applies cleanly", async () => {
    const t = await staleSetup((base) => ({ content: base.replace("profiles", "profiles by hostname"), baseContent: base }));
    await writeFile(join(t.skillsDir, "dotfiles-management", "SKILL.md"), `${t.base}\n## Emacs\ninit.el\n`); // my newer edit
    const ws = await t.openDraft(t.tree, t.id);
    const text = readFileSync(join(ws.scratch, "dotfiles-management", "SKILL.md"), "utf8");
    expect(text).toContain("profiles by hostname");
    expect(text).toContain("## Emacs");
    expect(ws.rebased).toEqual([{ path: "dotfiles-management/SKILL.md", how: "merged" }]);
    await t.discardDraft(ws);
  });

  it("on a conflict keeps my file and gives the reviser the draft's patch", async () => {
    const t = await staleSetup((base) => ({ content: base.replace("profiles", "profiles by hostname"), baseContent: base }));
    await writeFile(join(t.skillsDir, "dotfiles-management", "SKILL.md"), t.base.replace("profiles", "profiles per host (mine)"));
    const ws = await t.openDraft(t.tree, t.id);
    expect(readFileSync(join(ws.scratch, "dotfiles-management", "SKILL.md"), "utf8")).toContain("profiles per host (mine)");
    expect(ws.rebased[0]).toMatchObject({ how: "conflict", draftPatch: expect.stringContaining("+profiles by hostname") });
    expect(t.reviseContext(t.tree, ws)).toContain("is the CURRENT version: keep those edits");
    await t.discardDraft(ws);
  });

  it("old drafts (no stored original): my file plus the old draft as reference", async () => {
    const t = await staleSetup((base) => ({ content: base.replace("profiles", "profiles by hostname") }));
    await writeFile(join(t.skillsDir, "dotfiles-management", "SKILL.md"), `${t.base}\n## Emacs\ninit.el\n`);
    const ws = await t.openDraft(t.tree, t.id);
    expect(readFileSync(join(ws.scratch, "dotfiles-management", "SKILL.md"), "utf8")).toContain("## Emacs");
    expect(ws.rebased[0]).toMatchObject({ how: "legacy" });
    expect(t.reviseContext(t.tree, ws)).toContain("The earlier draft of the whole file was:");
    await t.discardDraft(ws);
  });
});

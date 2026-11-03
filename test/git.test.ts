import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { RepoTarget } from "../src/config.ts";
import {
  commitPaths,
  createWorktree,
  gitRepo,
  isMerged,
  pendingChanges,
  proposalBranchName,
  removeWorktree,
} from "../src/git/worktree.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

beforeAll(() => {
  // commits made through the module use the ambient identity
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  });
});

/** A bare dotfiles-style repo: git dir `<root>/.cfg`, work tree `<root>/home`. */
async function bareDotfiles(): Promise<{ target: RepoTarget; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "lbg-git-"));
  const home = join(root, "home");
  const gitDir = join(root, ".cfg");
  await mkdir(join(home, ".config/opencode/skills/gradle"), { recursive: true });
  await writeFile(join(home, ".config/opencode/skills/gradle/SKILL.md"), "---\nname: gradle\ndescription: x\n---\n");
  await writeFile(join(home, ".zshrc"), "# zsh\n");
  sh(["init", "--bare", "-b", "main", gitDir]);
  const g = [`--git-dir=${gitDir}`, `--work-tree=${home}`];
  sh([...g, "config", "status.showUntrackedFiles", "no"]);
  sh([...g, "add", ".config", ".zshrc"]);
  sh([...g, "commit", "-m", "init"]);
  return { target: { gitDir, workTree: home, baseBranch: "main" }, root };
}

describe("git worktree workflow (bare dotfiles repo)", () => {
  it("creates a branch + worktree, commits only given paths, leaves main untouched", async () => {
    const { target, root } = await bareDotfiles();
    const mainBefore = (await gitRepo(target, ["rev-parse", "main"])).trim();
    const branch = proposalBranchName("laobaigan/", "Gradle Builds!", new Date("2026-11-03T14:05:00Z"));
    expect(branch).toBe("laobaigan/makes-20261103-1405");

    const wt = await createWorktree(target, join(root, "worktrees"), branch);
    expect(wt.baseCommit).toBe(mainBefore);
    expect(existsSync(join(wt.path, ".config/opencode/skills/gradle/SKILL.md"))).toBe(true);

    // edit an existing skill, add a new one, and leave an unrelated stray file
    await writeFile(join(wt.path, ".config/opencode/skills/gradle/SKILL.md"), "---\nname: gradle\ndescription: y\n---\nbody\n");
    await mkdir(join(wt.path, ".config/opencode/skills/logs"), { recursive: true });
    await writeFile(join(wt.path, ".config/opencode/skills/logs/SKILL.md"), "---\nname: logs\ndescription: z\n---\n");
    await writeFile(join(wt.path, "stray.txt"), "x");

    const changed = await pendingChanges(wt.path);
    expect(changed.sort()).toEqual([
      ".config/opencode/skills/gradle/SKILL.md",
      ".config/opencode/skills/logs/SKILL.md",
      "stray.txt",
    ]);

    const sha = await commitPaths(wt.path, changed.filter((p) => p.startsWith(".config/opencode/skills/")), "skills: gradle + logs");
    expect((await gitRepo(target, ["rev-parse", branch])).trim()).toBe(sha);
    expect((await gitRepo(target, ["show", "--name-only", "--format=", sha])).trim().split("\n").sort()).toEqual([
      ".config/opencode/skills/gradle/SKILL.md",
      ".config/opencode/skills/logs/SKILL.md",
    ]);

    // main and the main checkout are untouched
    expect((await gitRepo(target, ["rev-parse", "main"])).trim()).toBe(mainBefore);
    expect(await readFile(join(target.workTree, ".config/opencode/skills/gradle/SKILL.md"), "utf8")).toContain("description: x");
    expect(await isMerged(target, branch)).toBe(false);

    // I merge by hand → detected; cleanup deletes the merged branch
    sh([`--git-dir=${target.gitDir}`, `--work-tree=${target.workTree}`, "merge", "--ff-only", branch]);
    expect(await isMerged(target, branch)).toBe(true);
    await removeWorktree(target, wt, { deleteBranch: "if-merged" });
    expect(existsSync(wt.path)).toBe(false);
    await expect(gitRepo(target, ["rev-parse", "--verify", `refs/heads/${branch}`])).rejects.toThrow();
  });

  it("refuses to reuse an existing branch and keeps unmerged branches on cleanup", async () => {
    const { target, root } = await bareDotfiles();
    const wt = await createWorktree(target, join(root, "wt"), "laobaigan/a");
    await expect(createWorktree(target, join(root, "wt"), "laobaigan/a")).rejects.toThrow(/already exists/);
    expect(await isMerged(target, wt.branch, wt.baseCommit)).toBe(false); // no commits yet
    await writeFile(join(wt.path, ".zshrc"), "# changed\n");
    await commitPaths(wt.path, [".zshrc"], "wip");
    expect(await isMerged(target, wt.branch, wt.baseCommit)).toBe(false); // not merged
    await removeWorktree(target, wt, { deleteBranch: "if-merged" });
    expect((await gitRepo(target, ["branch", "--list", "laobaigan/a"])).trim()).toContain("laobaigan/a");
  });

  it("works for a normal (non-bare) repo too", async () => {
    const root = await mkdtemp(join(tmpdir(), "lbg-git-n-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    sh(["init", "-b", "mainline"], repo);
    await writeFile(join(repo, "AGENTS.md"), "# Agents\n");
    sh(["add", "."], repo);
    sh(["commit", "-m", "init"], repo);
    const target: RepoTarget = { workTree: repo, baseBranch: "mainline" };
    const wt = await createWorktree(target, join(root, "wt"), "laobaigan/agents-md");
    await writeFile(join(wt.path, "AGENTS.md"), "# Agents\n\n## Build\nUse make.\n");
    await commitPaths(wt.path, await pendingChanges(wt.path), "AGENTS.md: build");
    expect(await readFile(join(repo, "AGENTS.md"), "utf8")).toBe("# Agents\n");
  });
});

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxRunner, toolResults } from "./helpers/faux.ts";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { beforeEach, describe, expect, it } from "vitest";
import { GuardError, guardedToolDefinitions, resolveGuard, type FileGuard } from "../src/pi/guard.ts";

const SKILL = ".config/opencode/skills/dotfiles-management/";

/**
 * A dotfiles-style worktree:
 *   wt/.config/opencode/skills/{gradle, dotfiles-management?}/SKILL.md
 *   wt/.pi/agent/skills -> ../../.config/opencode/skills   (relative symlink, like ~/.cfg)
 *   wt/.zshrc, wt/AGENTS.md, wt/.git/HEAD
 *   wt/.config/opencode/skills/evil -> <outside>           (symlink escaping the worktree)
 * plus an `outside` dir with a secret.
 */
async function worktree() {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "lbg-guard-")));
  const wt = join(base, "wt");
  const outside = join(base, "outside");
  await mkdir(join(wt, ".config/opencode/skills/gradle"), { recursive: true });
  await mkdir(join(wt, ".pi/agent"), { recursive: true });
  await mkdir(join(wt, ".git"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(wt, ".config/opencode/skills/gradle/SKILL.md"), "gradle");
  await writeFile(join(wt, ".zshrc"), "zsh");
  await writeFile(join(wt, "AGENTS.md"), "# Agents\n");
  await writeFile(join(wt, ".git/HEAD"), "ref");
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink("../../.config/opencode/skills", join(wt, ".pi/agent/skills"));
  await symlink(outside, join(wt, ".config/opencode/skills/evil"));
  return { base, wt, outside, guard: { root: wt, writable: [SKILL] } satisfies FileGuard };
}

describe("resolveGuard", () => {
  let w: Awaited<ReturnType<typeof worktree>>;
  beforeEach(async () => {
    w = await worktree();
  });

  it("allows reads anywhere in the worktree and writes only in the writable paths", async () => {
    const g = await resolveGuard(w.guard);
    await expect(g.check(join(w.wt, ".zshrc"), "read")).resolves.toBe(join(w.wt, ".zshrc"));
    await expect(g.check(".config/opencode/skills/gradle/SKILL.md", "read")).resolves.toContain("gradle");
    await expect(g.check(`${SKILL}SKILL.md`, "write")).resolves.toBe(join(w.wt, SKILL, "SKILL.md"));
    await expect(g.check(`${SKILL}references/tmux.md`, "write")).resolves.toBe(join(w.wt, SKILL, "references/tmux.md"));
    // through the tracked relative symlink, like ~/.pi/agent/skills in ~/.cfg
    await expect(g.check(".pi/agent/skills/dotfiles-management/SKILL.md", "write")).resolves.toBe(join(w.wt, SKILL, "SKILL.md"));
  });

  it("rejects writes outside the writable paths, with a message naming what is writable", async () => {
    const g = await resolveGuard(w.guard);
    for (const p of [".zshrc", ".config/opencode/skills/gradle/SKILL.md", "AGENTS.md", ".config/opencode/skills/dotfiles-management-evil/x"]) {
      await expect(g.check(p, "write")).rejects.toThrow(new RegExp(`not writable in this proposal\\. Writable: ${SKILL}`));
    }
  });

  it("rejects ../, absolute paths, ~, and symlinks that leave the worktree, for reads too", async () => {
    const g = await resolveGuard(w.guard);
    const escapes = [
      `${SKILL}../../../../../outside/secret.txt`,
      join(w.outside, "secret.txt"),
      "/etc/passwd",
      ".config/opencode/skills/evil/secret.txt",
      ".config/opencode/skills/evil/new-file",
    ];
    for (const p of escapes) {
      await expect(g.check(p, "read")).rejects.toThrow(/outside the worktree/);
      await expect(g.check(p, "write")).rejects.toThrow(/outside the worktree/);
    }
  });

  it("never allows writing .git, even if it were listed", async () => {
    const g = await resolveGuard({ root: w.wt, writable: [".git/", SKILL] });
    await expect(g.check(".git/HEAD", "write")).rejects.toThrow(/\.git is not writable/);
  });

  it("refuses writable entries that escape or aren't relative", async () => {
    await expect(resolveGuard({ root: w.wt, writable: ["../outside/"] })).rejects.toThrow(GuardError);
    await expect(resolveGuard({ root: w.wt, writable: [w.outside] })).rejects.toThrow(GuardError);
    await expect(resolveGuard({ root: w.wt, writable: [".config/opencode/skills/evil/"] })).rejects.toThrow(/escapes/);
  });

  it("an exact-file entry allows that file only (AGENTS.md section proposals)", async () => {
    const g = await resolveGuard({ root: w.wt, writable: ["AGENTS.md"] });
    await expect(g.check("AGENTS.md", "write")).resolves.toBe(join(w.wt, "AGENTS.md"));
    await expect(g.check("AGENTS.md.bak", "write")).rejects.toThrow(GuardError);
    await expect(g.checkMkdir(w.wt)).resolves.toBe(w.wt); // write() mkdirs the parent; harmless
    await expect(g.checkMkdir(join(w.wt, "other"))).rejects.toThrow(GuardError);
  });
});

describe("guardedToolDefinitions", () => {
  it("keeps pi's tool names", async () => {
    const w = await worktree();
    expect((await guardedToolDefinitions(w.guard)).map((t) => t.name)).toEqual(["read", "ls", "find", "grep", "write", "edit"]);
  });
});

// ---- end to end: a real pi session with scripted tool calls (faux provider, no network) ----

const done = Type.Object({ ok: Type.Boolean() });

describe("drafting session with guarded tools (real pi session)", () => {
  it("writes inside the skill folder; escapes are refused and the model sees why", async () => {
    const w = await worktree();
    let seen: ReturnType<typeof toolResults> = [];
    const runner = await fauxRunner([
      fauxAssistantMessage(
        [
          fauxToolCall("read", { path: ".zshrc" }),
          fauxToolCall("write", { path: `${SKILL}SKILL.md`, content: "---\nname: dotfiles-management\n---\n" }),
          fauxToolCall("write", { path: `${SKILL}references/tmux.md`, content: "# tmux\n" }),
          fauxToolCall("write", { path: ".zshrc", content: "pwned" }),
          fauxToolCall("write", { path: ".config/opencode/skills/evil/x.txt", content: "pwned" }),
          fauxToolCall("edit", { path: ".config/opencode/skills/gradle/SKILL.md", edits: [{ oldText: "gradle", newText: "pwned" }] }),
          fauxToolCall("read", { path: join(w.outside, "secret.txt") }),
          fauxToolCall("ls", { path: "../outside" }),
          fauxToolCall("find", { pattern: "*", path: w.outside }),
          fauxToolCall("grep", { pattern: "secret", path: "../outside" }),
        ],
        { stopReason: "toolUse" },
      ),
      (ctx) => {
        seen = toolResults(ctx as never);
        return fauxAssistantMessage([fauxToolCall("report", { ok: true })], { stopReason: "toolUse" });
      },
    ]);

    const res = await runner.run({
      model: "m",
      thinking: "off",
      systemPrompt: "draft",
      prompt: "go",
      tools: ["read", "ls", "find", "grep", "write", "edit"],
      fileGuard: w.guard,
      resultTool: { name: "report", description: "done", parameters: done },
    });
    expect(res.value).toEqual({ ok: true });

    // allowed
    expect(readFileSync(join(w.wt, SKILL, "SKILL.md"), "utf8")).toContain("dotfiles-management");
    expect(existsSync(join(w.wt, SKILL, "references/tmux.md"))).toBe(true);
    // untouched
    expect(await readFile(join(w.wt, ".zshrc"), "utf8")).toBe("zsh");
    expect(await readFile(join(w.wt, ".config/opencode/skills/gradle/SKILL.md"), "utf8")).toBe("gradle");
    expect(existsSync(join(w.outside, "x.txt"))).toBe(false);

    expect(seen.map((r) => [r.name, r.isError])).toEqual([
      ["read", false],
      ["write", false],
      ["write", false],
      ["write", true],
      ["write", true],
      ["edit", true],
      ["read", true],
      ["ls", true],
      ["find", true],
      ["grep", true],
    ]);
    expect(seen[0]!.text).toContain("zsh");
    expect(seen[3]!.text).toMatch(/\.zshrc is not writable in this proposal\. Writable: \.config\/opencode\/skills\/dotfiles-management\//);
    expect(seen[6]!.text).toMatch(/outside the worktree/);
    expect(seen.some((r) => r.text.includes("secret") && !r.isError)).toBe(false);
  });

  it("refuses non-file tools such as bash when a guard is set", async () => {
    const w = await worktree();
    const runner = await fauxRunner([]);
    await expect(
      runner.run({
        model: "m",
        thinking: "off",
        systemPrompt: "x",
        prompt: "x",
        tools: ["read", "bash"],
        fileGuard: w.guard,
        resultTool: { name: "report", description: "done", parameters: done },
      }),
    ).rejects.toThrow(/not allowed with a file guard: bash/);
  });
});

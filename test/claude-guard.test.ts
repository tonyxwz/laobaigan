import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { claudeGuard, claudeToolsFor } from "../src/pi/claude-guard.ts";
import { ClaudeCodeRunner } from "../src/pi/run-claude.ts";
import { GUARDED_TOOLS } from "../src/pi/guard.ts";

/** wt/skills/{git (writable), gradle}/SKILL.md, wt/.git/HEAD, wt/skills/evil -> outside. */
async function worktree() {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "lbg-cguard-")));
  const wt = join(base, "wt");
  const outside = join(base, "outside");
  await mkdir(join(wt, "skills/git"), { recursive: true });
  await mkdir(join(wt, "skills/gradle"), { recursive: true });
  await mkdir(join(wt, ".git"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(wt, "skills/git/SKILL.md"), "git");
  await writeFile(join(wt, "skills/gradle/SKILL.md"), "gradle");
  await writeFile(join(wt, ".git/HEAD"), "ref");
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(wt, "skills/evil"));
  return { wt, outside, guard: { root: wt, writable: ["skills/git/"] } };
}

const allowed = (d: { allow: boolean }) => d.allow;

describe("claudeToolsFor", () => {
  it("maps pi's guarded tools onto Claude Code built-ins, and refuses others", () => {
    expect(claudeToolsFor(GUARDED_TOOLS)).toEqual(["Read", "Glob", "Grep", "Write", "Edit"]);
    expect(() => claudeToolsFor(["read", "bash"])).toThrow(/bash/);
  });
});

describe("claudeGuard", () => {
  it("reads anywhere in the worktree, writes only to writable paths", async () => {
    const { wt, outside, guard } = await worktree();
    const g = await claudeGuard(guard, claudeToolsFor(GUARDED_TOOLS));
    const d = (tool: string, input: unknown) => g.decide(tool, input).then(allowed);

    expect(await d("Read", { file_path: join(wt, "skills/gradle/SKILL.md") })).toBe(true);
    expect(await d("Read", { file_path: "skills/gradle/SKILL.md" })).toBe(true); // relative to the worktree
    expect(await d("Read", { file_path: join(outside, "secret.txt") })).toBe(false);
    expect(await d("Read", { file_path: join(wt, "skills/evil/secret.txt") })).toBe(false); // symlink out
    expect(await d("Read", { file_path: join(wt, "../outside/secret.txt") })).toBe(false);

    expect(await d("Edit", { file_path: join(wt, "skills/git/SKILL.md"), old_string: "a", new_string: "b" })).toBe(true);
    expect(await d("Write", { file_path: join(wt, "skills/git/references/new.md"), content: "x" })).toBe(true);
    expect(await d("Write", { file_path: join(wt, "skills/gradle/SKILL.md"), content: "x" })).toBe(false);
    expect(await d("Edit", { file_path: join(wt, ".git/HEAD"), old_string: "a", new_string: "b" })).toBe(false);
    expect(await d("Write", { file_path: join(outside, "x.md"), content: "x" })).toBe(false);
    expect(await d("Write", { content: "x" })).toBe(false); // no path

    expect(await d("Glob", { pattern: "**/*.md" })).toBe(true);
    expect(await d("Glob", { pattern: "*.md", path: join(wt, "skills") })).toBe(true);
    expect(await d("Glob", { pattern: "../**" })).toBe(false);
    expect(await d("Glob", { pattern: "/etc/*" })).toBe(false);
    expect(await d("Glob", { pattern: "*", path: outside })).toBe(false);
    expect(await d("Grep", { pattern: "secret" })).toBe(true);
    expect(await d("Grep", { pattern: "secret", path: join(wt, "skills/evil") })).toBe(false);
    expect(await d("Grep", { pattern: "secret", glob: "../**" })).toBe(false);

    expect(await d("StructuredOutput", {})).toBe(true);
    expect(await d("Bash", { command: "cat /etc/passwd" })).toBe(false);
    expect(await d("WebFetch", { url: "https://example.com" })).toBe(false);
  });

  it("denies tools the request didn't ask for", async () => {
    const { wt, guard } = await worktree();
    const g = await claudeGuard(guard, claudeToolsFor(["read"]));
    expect(await g.decide("Read", { file_path: join(wt, "skills/git/SKILL.md") }).then(allowed)).toBe(true);
    const w = await g.decide("Write", { file_path: join(wt, "skills/git/SKILL.md"), content: "x" });
    expect(w).toEqual({ allow: false, reason: "Write is not available in this session." });
  });
});

describe("ClaudeCodeRunner with a file guard", () => {
  it("runs in the worktree with the built-in file tools, every call decided by the guard", async () => {
    const { wt, outside, guard } = await worktree();
    const calls: Record<string, any>[] = [];
    const q = ((p: { options: Record<string, any> }) => {
      calls.push(p.options);
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "", structured_output: { ok: true }, total_cost_usd: 0, modelUsage: {} };
      })();
    }) as never;
    const res = await new ClaudeCodeRunner({ query: q }).run({
      model: "opus",
      systemPrompt: "draft",
      prompt: "go",
      tools: [...GUARDED_TOOLS],
      fileGuard: guard,
      resultTool: { name: "report_draft", description: "d", parameters: Type.Object({ ok: Type.Boolean() }) },
    });
    expect(res.value).toEqual({ ok: true });
    const o = calls[0]!;
    expect(o.cwd).toBe(wt);
    expect(o.tools).toEqual(["Read", "Glob", "Grep", "Write", "Edit"]);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.persistSession).toBe(false);
    const hook = async (tool_name: string, tool_input: unknown) =>
      (await o.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t" }, "t", { signal: new AbortController().signal }))
        .hookSpecificOutput;
    expect((await hook("Write", { file_path: join(wt, "skills/git/SKILL.md"), content: "x" })).permissionDecision).toBe("allow");
    const denied = await hook("Write", { file_path: join(wt, "skills/gradle/SKILL.md"), content: "x" });
    expect(denied.permissionDecision).toBe("deny");
    expect(denied.permissionDecisionReason).toMatch(/not writable.*skills\/git\//);
    // The canUseTool backstop decides the same way.
    expect(await o.canUseTool("Read", { file_path: join(outside, "secret.txt") }, {})).toMatchObject({ behavior: "deny" });
    expect(await o.canUseTool("Read", { file_path: join(wt, "skills/gradle/SKILL.md") }, {})).toMatchObject({ behavior: "allow" });
  });
});

describe("claude-guard-hook (the command interactive Claude Code runs)", () => {
  const HOOK = join(import.meta.dirname, "..", "src", "pi", "claude-guard-hook.ts");
  const run = (env: Record<string, string>, input: string) => spawnSync(process.execPath, [HOOK], { input, env: { ...process.env, ...env }, encoding: "utf8" });

  it("prints the guard's decision for the call on stdin", async () => {
    const { wt, guard } = await worktree();
    const LBG_GUARD = JSON.stringify(guard);
    const decide = (tool_name: string, tool_input: unknown) => {
      const r = run({ LBG_GUARD }, JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }));
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout).hookSpecificOutput;
    };
    expect(decide("Write", { file_path: join(wt, "skills/git/SKILL.md"), content: "x" })).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "allow" });
    expect(decide("Write", { file_path: join(wt, "skills/gradle/SKILL.md"), content: "x" })).toMatchObject({ permissionDecision: "deny" });
    expect(decide("Bash", { command: "id" })).toMatchObject({ permissionDecision: "deny" });
  });

  it("fails closed (exit 2 blocks the call)", async () => {
    expect(run({ LBG_GUARD: "" }, "{}").status).toBe(2);
    const { guard } = await worktree();
    expect(run({ LBG_GUARD: JSON.stringify(guard) }, "not json").status).toBe(2);
  });
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentModel, loadConfig } from "../src/config.ts";
import {
  ClaudeCodeRunner,
  claudeSettings,
  modelRunner,
} from "../src/pi/run-claude.ts";
import type { PiRequest, PiRunner } from "../src/pi/run-pi.ts";
import { PiConfigRunner } from "../src/pi/run-pi.ts";

const schema = Type.Object({
  items: Type.Array(Type.String()),
  note: Type.Optional(Type.String()),
});
const req = (
  over: Partial<PiRequest<typeof schema>> = {},
): PiRequest<typeof schema> => ({
  model: "sonnet",
  systemPrompt: "sys",
  prompt: "hello",
  resultTool: { name: "report", description: "d", parameters: schema },
  ...over,
});

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadInputTokens: 2,
  cacheCreationInputTokens: 3,
  webSearchRequests: 0,
  costUSD: 0.01,
  contextWindow: 1,
  maxOutputTokens: 1,
};

/** A fake SDK `query` that records its call and yields the given messages. */
function fakeQuery(messages: unknown[]) {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const q = ((p: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(p);
    return (async function* () {
      yield* messages;
    })();
  }) as never;
  return { q, calls };
}

/** Run the PreToolUse hook the runner passed to the SDK. */
async function hook(
  o: Record<string, any>,
  tool_name: string,
  tool_input: unknown,
): Promise<string> {
  const out = await o.hooks.PreToolUse[0].hooks[0](
    { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t" },
    "t",
    { signal: new AbortController().signal },
  );
  return out.hookSpecificOutput.permissionDecision;
}

describe("ClaudeCodeRunner", () => {
  it("asks for the result tool's schema as structured output, isolated, and returns it with usage", async () => {
    const { q, calls } = fakeQuery([
      { type: "system", subtype: "init" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: { items: ["a"] },
        total_cost_usd: 0.02,
        modelUsage: { s: usage, h: usage },
      },
    ]);
    const res = await new ClaudeCodeRunner({
      query: q,
      executable: "/bin/claude",
    }).run(req({ thinking: "off" }));
    expect(res.value).toEqual({ items: ["a"] });
    expect(res.usage).toEqual({
      input: 20,
      output: 10,
      cacheRead: 4,
      cacheWrite: 6,
      cost: 0.02,
    });
    const o = calls[0]!.options;
    expect(calls[0]!.prompt).toBe("hello");
    expect(o.model).toBe("sonnet");
    expect(o.systemPrompt).toMatch(/^sys\n\n/);
    expect(o.outputFormat).toEqual({
      type: "json_schema",
      schema: JSON.parse(JSON.stringify(schema)),
    });
    expect(o.thinking).toEqual({ type: "disabled" });
    expect(o.tools).toEqual([]);
    expect(o.persistSession).toBe(false); // lbg reads ~/.claude/projects: never write its own calls there
    expect(o.settingSources).toEqual(["user"]);
    expect(o.pathToClaudeCodeExecutable).toBe("/bin/claude");
    // None of my own Claude Code context (like pi's no-context-files), settings files still load.
    expect(o.env).toMatchObject({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      PATH: process.env.PATH,
    });
    expect(o.settings).toEqual({
      disableAllHooks: true,
      outputStyle: "default",
    });
  });

  it("without a guard: no tools, and the hook denies anything but the answer", async () => {
    const { q, calls } = fakeQuery([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: { items: [] },
        total_cost_usd: 0,
        modelUsage: {},
      },
    ]);
    await new ClaudeCodeRunner({ query: q }).run(req());
    const o = calls[0]!.options as Record<string, any>;
    expect(o.tools).toEqual([]);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.systemPrompt).toMatch(
      /^sys\n\n.*`report` is the StructuredOutput tool/,
    );
    expect(await hook(o, "Read", { file_path: "/etc/passwd" })).toBe("deny");
    expect(await hook(o, "StructuredOutput", { items: [] })).toBe("allow");
  });

  it("leaves the model to Claude Code when none is configured", async () => {
    const { q, calls } = fakeQuery([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: { items: [] },
        total_cost_usd: 0,
        modelUsage: {},
      },
    ]);
    await new ClaudeCodeRunner({ query: q }).run(
      req({ model: undefined, thinking: "high" }),
    );
    expect(calls[0]!.options.model).toBeUndefined();
    expect(calls[0]!.options.effort).toBe("high");
  });

  it("fails on errors, missing structured output, and requests that need tools", async () => {
    const err = fakeQuery([
      {
        type: "result",
        subtype: "error_max_structured_output_retries",
        is_error: true,
        errors: ["bad"],
        total_cost_usd: 0,
        modelUsage: {},
      },
    ]);
    await expect(
      new ClaudeCodeRunner({ query: err.q }).run(req()),
    ).rejects.toThrow(/bad/);
    const none = fakeQuery([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "just text",
        total_cost_usd: 0,
        modelUsage: {},
      },
    ]);
    await expect(
      new ClaudeCodeRunner({ query: none.q }).run(req()),
    ).rejects.toThrow(/no structured output.*just text/);
    const empty = fakeQuery([]);
    await expect(
      new ClaudeCodeRunner({ query: empty.q }).run(req()),
    ).rejects.toThrow(/without a result/);
    await expect(
      new ClaudeCodeRunner({ query: empty.q }).run(req({ tools: ["read"] })),
    ).rejects.toThrow(/file guard/);
    expect(empty.calls).toHaveLength(1); // unguarded tools never start Claude Code
  });
});

describe("claudeSettings (config claudeCode.settings + lbg's)", () => {
  it("keeps mine, puts lbg's on top, adds lbg's hooks after mine, merges env", () => {
    const mine = {
      enabledPlugins: { "x@y": false },
      outputStyle: "Concise",
      env: { MINE: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0" },
      hooks: {
        PreToolUse: [
          { matcher: "Write", hooks: [{ type: "command", command: "fmt" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "bell" }] }],
      },
    };
    const lbg = {
      outputStyle: "default",
      env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "guard" }] },
        ],
      },
    };
    expect(claudeSettings(mine, lbg)).toEqual({
      enabledPlugins: { "x@y": false },
      outputStyle: "default",
      env: { MINE: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
      hooks: {
        PreToolUse: [
          { matcher: "Write", hooks: [{ type: "command", command: "fmt" }] },
          { matcher: "*", hooks: [{ type: "command", command: "guard" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "bell" }] }],
      },
    });
    expect(claudeSettings(undefined, { outputStyle: "default" })).toEqual({
      outputStyle: "default",
    });
  });

  it("the SDK runner passes them, with lbg's isolation on top", async () => {
    const { q, calls } = fakeQuery([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: { items: [] },
        total_cost_usd: 0,
        modelUsage: {},
      },
    ]);
    await new ClaudeCodeRunner({
      query: q,
      settings: { enabledPlugins: { "x@y": false }, outputStyle: "Concise" },
    }).run(req());
    expect(calls[0]!.options.settings).toEqual({
      enabledPlugins: { "x@y": false },
      disableAllHooks: true,
      outputStyle: "default",
    });
  });
});

describe("modelRunner", () => {
  it("is the configured agent", () => {
    expect(modelRunner({ agent: "pi", claudeCode: {} })).toBeInstanceOf(
      PiConfigRunner,
    );
    expect(
      modelRunner({ agent: "claude-code", claudeCode: {} }),
    ).toBeInstanceOf(ClaudeCodeRunner);
  });
});

describe("config", () => {
  it("one agent for every stage, its model in its own section; the old top-level keys are refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-cfg-"));
    const ok = join(dir, "ok.json");
    await writeFile(
      ok,
      JSON.stringify({
        agent: "claude-code",
        pi: { model: "anthropic/x" },
        claudeCode: { model: "sonnet", thinking: "low", executable: "claude" },
      }),
    );
    const c = loadConfig(ok);
    expect(c).toMatchObject({
      agent: "claude-code",
      pi: { model: "anthropic/x" },
      claudeCode: { model: "sonnet", thinking: "low" },
    });
    expect(agentModel(c)).toEqual({ model: "sonnet", thinking: "low" });
    expect(agentModel({ ...c, agent: "pi" })).toEqual({ model: "anthropic/x" });
    expect(loadConfig(join(dir, "missing.json"))).toMatchObject({
      agent: "pi",
      pi: {},
      claudeCode: {},
    }); // pi, with pi's own defaults
    expect(c.claudeCode.executable).toBe("claude"); // bare names stay for PATH lookup
    const extra = join(dir, "extra.json");
    await writeFile(
      extra,
      JSON.stringify({
        claudeCode: {
          settings: { enabledPlugins: { "x@y": false }, hooks: { Stop: [] } },
        },
      }),
    );
    expect(loadConfig(extra).claudeCode.settings).toEqual({
      enabledPlugins: { "x@y": false },
      hooks: { Stop: [] },
    });
    for (const unsafe of [
      { disableAllHooks: true },
      { allowManagedHooksOnly: true },
      { permissions: { allow: ["Write"] } },
    ]) {
      await writeFile(
        extra,
        JSON.stringify({ claudeCode: { settings: unsafe } }),
      );
      expect(() => loadConfig(extra)).toThrow(/switch off lbg's file guard/);
    }
    await writeFile(
      extra,
      JSON.stringify({ claudeCode: { settings: { hooks: { Stop: "bell" } } } }),
    );
    expect(() => loadConfig(extra)).toThrow(
      /hooks must map hook events to arrays/,
    );
    await writeFile(extra, JSON.stringify({ claudeCode: { settings: [] } }));
    expect(() => loadConfig(extra)).toThrow(/must be an object/);
    const bad = join(dir, "bad.json");
    for (const old of [
      { models: { extract: "x" } },
      { model: "claude-code/sonnet" },
      { thinking: "low" },
    ]) {
      await writeFile(bad, JSON.stringify(old));
      expect(() => loadConfig(bad)).toThrow(
        /moved into the agent's section.*"agent"/,
      );
    }
    for (const [v, msg] of [
      [{ agent: "claude" }, /config.agent must be one of "pi", "claude-code"/],
      [{ pi: { thinking: "max" } }, /config.pi.thinking/],
      [{ claudeCode: { model: "" } }, /config.claudeCode.model/],
    ] as const) {
      await writeFile(bad, JSON.stringify(v));
      expect(() => loadConfig(bad)).toThrow(msg);
    }
  });
});

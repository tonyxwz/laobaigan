import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { claudeCodeModel, ClaudeCodeRunner, RoutingRunner } from "../src/pi/run-claude.ts";
import type { PiRequest, PiRunner } from "../src/pi/run-pi.ts";

const schema = Type.Object({ items: Type.Array(Type.String()), note: Type.Optional(Type.String()) });
const req = (over: Partial<PiRequest<typeof schema>> = {}): PiRequest<typeof schema> => ({
  model: "claude-code/sonnet",
  systemPrompt: "sys",
  prompt: "hello",
  resultTool: { name: "report", description: "d", parameters: schema },
  ...over,
});

const usage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, webSearchRequests: 0, costUSD: 0.01, contextWindow: 1, maxOutputTokens: 1 };

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

describe("claudeCodeModel", () => {
  it("recognizes claude-code specs only", () => {
    expect(claudeCodeModel("claude-code")).toBe("");
    expect(claudeCodeModel("claude-code/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(claudeCodeModel("anthropic/claude-sonnet-4-5")).toBeUndefined();
    expect(claudeCodeModel("claude-codex")).toBeUndefined();
    expect(claudeCodeModel(undefined)).toBeUndefined();
  });
});

describe("ClaudeCodeRunner", () => {
  it("asks for the result tool's schema as structured output, isolated, and returns it with usage", async () => {
    const { q, calls } = fakeQuery([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", is_error: false, result: "", structured_output: { items: ["a"] }, total_cost_usd: 0.02, modelUsage: { s: usage, h: usage } },
    ]);
    const res = await new ClaudeCodeRunner({ query: q, executable: "/bin/claude" }).run(req({ thinking: "off" }));
    expect(res.value).toEqual({ items: ["a"] });
    expect(res.usage).toEqual({ input: 20, output: 10, cacheRead: 4, cacheWrite: 6, cost: 0.02 });
    const o = calls[0]!.options;
    expect(calls[0]!.prompt).toBe("hello");
    expect(o.model).toBe("sonnet");
    expect(o.systemPrompt).toBe("sys");
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: JSON.parse(JSON.stringify(schema)) });
    expect(o.thinking).toEqual({ type: "disabled" });
    expect(o.tools).toEqual([]);
    expect(o.persistSession).toBe(false); // lbg reads ~/.claude/projects: never write its own calls there
    expect(o.settingSources).toEqual(["user"]);
    expect(o.pathToClaudeCodeExecutable).toBe("/bin/claude");
  });

  it("leaves the model to Claude Code for a bare claude-code spec", async () => {
    const { q, calls } = fakeQuery([{ type: "result", subtype: "success", is_error: false, result: "", structured_output: { items: [] }, total_cost_usd: 0, modelUsage: {} }]);
    await new ClaudeCodeRunner({ query: q }).run(req({ model: "claude-code", thinking: "high" }));
    expect(calls[0]!.options.model).toBeUndefined();
    expect(calls[0]!.options.effort).toBe("high");
  });

  it("fails on errors, missing structured output, and requests that need tools", async () => {
    const err = fakeQuery([{ type: "result", subtype: "error_max_structured_output_retries", is_error: true, errors: ["bad"], total_cost_usd: 0, modelUsage: {} }]);
    await expect(new ClaudeCodeRunner({ query: err.q }).run(req())).rejects.toThrow(/bad/);
    const none = fakeQuery([{ type: "result", subtype: "success", is_error: false, result: "just text", total_cost_usd: 0, modelUsage: {} }]);
    await expect(new ClaudeCodeRunner({ query: none.q }).run(req())).rejects.toThrow(/no structured output.*just text/);
    const empty = fakeQuery([]);
    await expect(new ClaudeCodeRunner({ query: empty.q }).run(req())).rejects.toThrow(/without a result/);
    await expect(new ClaudeCodeRunner({ query: empty.q }).run(req({ tools: ["read"] }))).rejects.toThrow(/file tools/);
    expect(empty.calls).toHaveLength(1); // the tools request never started Claude Code
  });
});

describe("RoutingRunner", () => {
  it("sends claude-code specs to Claude Code and everything else to pi", async () => {
    const seen: string[] = [];
    const fake = (name: string): PiRunner => ({
      run: async (r) => (seen.push(`${name}:${r.model}`), { value: {} as never, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }),
    });
    const r = new RoutingRunner(fake("pi"), fake("cc"));
    await r.run(req({ model: "claude-code/opus" }));
    await r.run(req({ model: "anthropic/claude-opus" }));
    await r.run(req({ model: undefined }));
    expect(seen).toEqual(["cc:claude-code/opus", "pi:anthropic/claude-opus", "pi:undefined"]);
  });
});

describe("config", () => {
  it("accepts Claude Code for extract, not for distill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-cfg-"));
    const ok = join(dir, "ok.json");
    await writeFile(ok, JSON.stringify({ models: { extract: "claude-code/sonnet" }, claudeCode: { executable: "claude" } }));
    const c = loadConfig(ok);
    expect(c.models.extract).toBe("claude-code/sonnet");
    expect(c.claudeCode.executable).toBe("claude"); // bare names stay for PATH lookup
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ models: { distill: "claude-code" } }));
    expect(() => loadConfig(bad)).toThrow(/distill/);
  });
});

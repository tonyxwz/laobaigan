import { query, type Options, type PreToolUseHookInput, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { claudeGuard, claudeToolsFor, STRUCTURED_OUTPUT_TOOL } from "./claude-guard.ts";
import { PiConfigRunner, type PiRequest, type PiResult, type PiRunner, type ThinkingLevel, type Usage } from "./run-pi.ts";

export interface ClaudeCodeOptions {
  /** The `claude` executable. Default: the one bundled with the Agent SDK. */
  executable?: string | undefined;
  /** Settings files to load. Default ["user"]: your login / provider (e.g. Bedrock) settings, no project files. */
  settingSources?: Options["settingSources"] | undefined;
  /** The user's extra settings (config claudeCode.settings); lbg's go on top. */
  settings?: Record<string, unknown> | undefined;
  /** Seam for tests: the SDK's `query`. */
  query?: typeof query;
}

/**
 * The settings for one of lbg's Claude Code sessions: the user's (config claudeCode.settings),
 * then lbg's on top. Hooks are added per event after the user's, so both run (a deny from
 * either wins), and `env` is merged with lbg's variables winning.
 */
export function claudeSettings(user: Record<string, unknown> | undefined, lbg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(user ?? {}), ...lbg };
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const uh = obj(user?.hooks);
  const lh = obj(lbg.hooks);
  if (uh || lh) {
    const hooks: Record<string, unknown[]> = {};
    for (const src of [uh, lh]) for (const [event, groups] of Object.entries(src ?? {})) hooks[event] = [...(hooks[event] ?? []), ...(groups as unknown[])];
    out.hooks = hooks;
  }
  if (obj(user?.env) || obj(lbg.env)) out.env = { ...obj(user?.env), ...obj(lbg.env) };
  return out;
}

/**
 * What keeps the user's own Claude Code context out of lbg's sessions, like pi's
 * no-context-files: no CLAUDE.md or ~/.claude/rules, no auto-memory, the default output
 * style. Settings files still load (`settingSources`), so login and provider settings apply.
 * The variables are Claude Code's own, not Agent SDK options; a test pins them.
 */
export const CLAUDE_CONTEXT_ENV = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as const;
export const CLAUDE_CONTEXT_SETTINGS = { outputStyle: "default" } as const;

/** Claude Code's effort for a pi thinking level ("off" has none: thinking is disabled instead). */
export function claudeEffort(level: ThinkingLevel | undefined): "low" | "medium" | "high" | undefined {
  switch (level) {
    case undefined:
    case "off":
      return undefined;
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}

/** pi's thinking levels mapped onto Claude Code's thinking / effort options. */
function thinkingOptions(level: ThinkingLevel | undefined): Pick<Options, "thinking" | "effort"> {
  if (level === "off") return { thinking: { type: "disabled" } };
  const effort = claudeEffort(level);
  return effort ? { effort } : {};
}

/**
 * One structured answer per request from a headless Claude Code session (the Agent SDK):
 * no skills, no settings hooks, no MCP servers, nothing saved to ~/.claude/projects (which
 * lbg reads as a source). The result tool becomes Claude Code's JSON-schema output format.
 * Requests without tools get none; requests with a file guard (drafting) get Claude Code's
 * built-in file tools, every call checked against the guard first (see claude-guard.ts).
 */
export class ClaudeCodeRunner implements PiRunner {
  private readonly opts: ClaudeCodeOptions;

  constructor(opts: ClaudeCodeOptions = {}) {
    this.opts = opts;
  }

  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    const tools = req.tools ?? [];
    if (tools.length && !req.fileGuard) throw new Error("Claude Code runs tools only with a file guard");
    const model = req.model;
    // With a guard: the proposal worktree, its file tools checked call by call. Without:
    // an empty working directory and no tools.
    const guard = req.fileGuard ? await claudeGuard(req.fileGuard, claudeToolsFor(tools)) : undefined;
    const cwd = guard?.root ?? mkdtempSync(join(tmpdir(), "lbg-claude-"));
    const decide = async (name: string, input: unknown) =>
      guard ? guard.decide(name, input) : name === STRUCTURED_OUTPUT_TOOL ? ({ allow: true } as const) : ({ allow: false, reason: `${name} is not available.` } as const);
    const abort = new AbortController();
    let result: SDKResultMessage | undefined;
    try {
      const messages = (this.opts.query ?? query)({
        prompt: req.prompt,
        options: {
          cwd,
          ...(model ? { model } : {}),
          ...thinkingOptions(req.thinking),
          systemPrompt: `${req.systemPrompt}\n\n${answerNote(req.resultTool.name)}`,
          // The schema is the answer's shape; drop typebox's symbol keys.
          outputFormat: { type: "json_schema", schema: JSON.parse(JSON.stringify(req.resultTool.parameters)) as Record<string, unknown> },
          tools: guard ? claudeToolsFor(tools) : [],
          // Every tool call is decided here, before it runs: a PreToolUse hook (it runs
          // whatever the settings' allow rules or permission mode say), and canUseTool for
          // anything that still reaches the permission check. dontAsk denies the rest.
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    const i = input as PreToolUseHookInput;
                    const d = await decide(i.tool_name, i.tool_input);
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: d.allow ? "allow" : "deny",
                        permissionDecisionReason: d.allow ? "lbg file guard: allowed" : d.reason,
                      },
                    };
                  },
                ],
              },
            ],
          },
          canUseTool: async (name, input) => {
            const d = await decide(name, input);
            return d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.reason };
          },
          permissionMode: "dontAsk",
          skills: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: this.opts.settingSources ?? ["user"],
          // Hooks from settings files and plugins; lbg's own hook above still runs.
          // (also those in claudeCode.settings: background calls run no settings hooks at all).
          settings: claudeSettings(this.opts.settings, { disableAllHooks: true, ...CLAUDE_CONTEXT_SETTINGS }),
          // The SDK replaces the environment, so start from lbg's.
          env: { ...process.env, ...CLAUDE_CONTEXT_ENV },
          persistSession: false,
          maxTurns: guard ? 200 : 4,
          abortController: abort,
          ...(this.opts.executable ? { pathToClaudeCodeExecutable: this.opts.executable } : {}),
        },
      });
      for await (const m of messages) {
        if (m.type === "result") {
          result = m;
          break;
        }
      }
    } finally {
      abort.abort();
      if (!guard) rmSync(cwd, { recursive: true, force: true });
    }
    if (!result) throw new Error("Claude Code ended without a result");
    if (result.subtype !== "success" || result.is_error) {
      const why = result.subtype === "success" ? result.result : result.errors.join("; ") || result.subtype;
      throw new Error(`Claude Code failed (${result.subtype}): ${why.slice(0, 300)}`);
    }
    if (result.structured_output === undefined || result.structured_output === null) {
      throw new Error(`Claude Code returned no structured output. Last reply: ${result.result.slice(0, 300)}`);
    }
    return { value: result.structured_output as Static<S>, usage: usageOf(result) };
  }
}

/** The prompts say "call <resultTool>"; in Claude Code that answer is the structured output. */
function answerNote(resultTool: string): string {
  return `In this session, \`${resultTool}\` is the ${STRUCTURED_OUTPUT_TOOL} tool: give your final answer by calling ${STRUCTURED_OUTPUT_TOOL} with the \`${resultTool}\` arguments, once, when you are done.`;
}

function usageOf(r: SDKResultMessage): Usage {
  const u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: r.total_cost_usd ?? 0 };
  for (const m of Object.values(r.modelUsage ?? {})) {
    u.input += m.inputTokens;
    u.output += m.outputTokens;
    u.cacheRead += m.cacheReadInputTokens;
    u.cacheWrite += m.cacheCreationInputTokens;
  }
  return u;
}

/** The runner lbg uses: the configured agent (config "agent"). */
export function modelRunner(cfg: {
  agent: "pi" | "claude-code";
  claudeCode: { executable?: string; settingSources?: Options["settingSources"]; settings?: Record<string, unknown> };
}): PiRunner {
  if (cfg.agent !== "claude-code") return new PiConfigRunner();
  return new ClaudeCodeRunner({ executable: cfg.claudeCode.executable, settingSources: cfg.claudeCode.settingSources, settings: cfg.claudeCode.settings });
}

import { query, type Options, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { PiConfigRunner, type PiRequest, type PiResult, type PiRunner, type ThinkingLevel, type Usage } from "./run-pi.ts";

/** Model specs routed to Claude Code: "claude-code" (its default model) or "claude-code/<model>". */
export const CLAUDE_CODE_PREFIX = "claude-code";

/** The Claude Code model a spec names: undefined = not a Claude Code spec; "" = Claude Code's default model. */
export function claudeCodeModel(spec: string | undefined): string | undefined {
  if (spec === CLAUDE_CODE_PREFIX) return "";
  if (spec?.startsWith(`${CLAUDE_CODE_PREFIX}/`)) return spec.slice(CLAUDE_CODE_PREFIX.length + 1);
  return undefined;
}

export interface ClaudeCodeOptions {
  /** The `claude` executable. Default: the one bundled with the Agent SDK. */
  executable?: string | undefined;
  /** Settings files to load. Default ["user"]: your login / provider (e.g. Bedrock) settings, no project files. */
  settingSources?: Options["settingSources"] | undefined;
  /** Seam for tests: the SDK's `query`. */
  query?: typeof query;
}

/** pi's thinking levels mapped onto Claude Code's thinking / effort options. */
function thinkingOptions(level: ThinkingLevel | undefined): Pick<Options, "thinking" | "effort"> {
  switch (level) {
    case undefined:
      return {};
    case "off":
      return { thinking: { type: "disabled" } };
    case "minimal":
    case "low":
      return { effort: "low" };
    case "medium":
      return { effort: "medium" };
    default:
      return { effort: "high" };
  }
}

/**
 * One structured answer per request from a headless Claude Code session (the Agent SDK):
 * no tools, no skills, no hooks, no MCP servers, nothing saved to ~/.claude/projects (which
 * lbg reads as a source). The result tool becomes Claude Code's JSON-schema output format.
 * Only for requests without tools: drafting needs pi's guarded file tools.
 */
export class ClaudeCodeRunner implements PiRunner {
  private readonly opts: ClaudeCodeOptions;

  constructor(opts: ClaudeCodeOptions = {}) {
    this.opts = opts;
  }

  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    if (req.tools?.length || req.fileGuard) {
      throw new Error(`Claude Code can't run this stage (it needs file tools); use a pi model for it (got ${req.model})`);
    }
    const model = claudeCodeModel(req.model);
    // An empty working directory: nothing to pick up, nothing to touch.
    const cwd = mkdtempSync(join(tmpdir(), "lbg-claude-"));
    const abort = new AbortController();
    let result: SDKResultMessage | undefined;
    try {
      const messages = (this.opts.query ?? query)({
        prompt: req.prompt,
        options: {
          cwd,
          ...(model ? { model } : {}),
          ...thinkingOptions(req.thinking),
          systemPrompt: req.systemPrompt,
          // The schema is the answer's shape; drop typebox's symbol keys.
          outputFormat: { type: "json_schema", schema: JSON.parse(JSON.stringify(req.resultTool.parameters)) as Record<string, unknown> },
          tools: [],
          skills: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: this.opts.settingSources ?? ["user"],
          settings: { disableAllHooks: true },
          persistSession: false,
          permissionMode: "dontAsk",
          maxTurns: 4,
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
      rmSync(cwd, { recursive: true, force: true });
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

/** Sends "claude-code[/model]" requests to Claude Code and everything else to pi. */
export class RoutingRunner implements PiRunner {
  private readonly pi: PiRunner;
  private readonly claude: PiRunner;

  constructor(pi: PiRunner, claude: PiRunner) {
    this.pi = pi;
    this.claude = claude;
  }

  run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    return (claudeCodeModel(req.model) !== undefined ? this.claude : this.pi).run(req);
  }
}

/** The runner lbg uses: pi, plus Claude Code for "claude-code[/model]" specs. */
export function modelRunner(cfg: { claudeCode: { executable?: string; settingSources?: Options["settingSources"] } }): PiRunner {
  return new RoutingRunner(
    new PiConfigRunner(),
    new ClaudeCodeRunner({ executable: cfg.claudeCode.executable, settingSources: cfg.claudeCode.settingSources }),
  );
}

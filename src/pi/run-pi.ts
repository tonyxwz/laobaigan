import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  type CreateAgentSessionOptions,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GUARDED_TOOLS, guardedToolDefinitions, type FileGuard, type GuardedToolName } from "./guard.ts";

/** The only provider laobaigan may use. */
export const PROVIDER = "amazon-bedrock";

export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface ResultTool<S extends TSchema> {
  name: string;
  description: string;
  parameters: S;
}

export interface PiRequest<S extends TSchema> {
  /** Bedrock model id, e.g. "global.openai.gpt-6.1-sol". */
  model: string;
  thinking: ThinkingLevel;
  systemPrompt: string;
  prompt: string;
  /** The tool the model must call with its answer; the run ends right after. */
  resultTool: ResultTool<S>;
  /** Built-in tools to enable (e.g. ["read","write"]). Default: none. */
  tools?: string[];
  /** Working directory for built-in tools. */
  cwd?: string;
  /**
   * Confine file tools to a worktree (writes only to `writable`). With a guard, `tools`
   * may only name guarded file tools; cwd becomes the guard's root.
   */
  fileGuard?: FileGuard;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface PiResult<T> {
  value: T;
  usage: Usage;
}

/** Abstraction over pi so pipeline stages can be tested without a model. */
export interface PiRunner {
  run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>>;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/** A loader that discovers nothing: no extensions, skills, prompts, or AGENTS.md. */
function minimalLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * Headless, in-memory pi sessions through the SDK. `resolve` picks the runtime and
 * model for a request; `allowModel` vets the model the session ends up using.
 */
export class SdkPiRunner implements PiRunner {
  private readonly resolve: (id: string) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>;
  private readonly allowModel: (m: { provider: string; id: string }) => boolean;

  constructor(
    resolve: (id: string) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>,
    allowModel: (m: { provider: string; id: string }) => boolean = () => true,
  ) {
    this.resolve = resolve;
    this.allowModel = allowModel;
  }

  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    const { runtime, model } = await this.resolve(req.model);
    const tools = req.tools ?? [];
    let fileTools: ToolDefinition[] = [];
    let cwd = req.cwd ?? process.cwd();
    if (req.fileGuard) {
      // Every file tool is the guarded version; anything else (bash, …) is refused.
      const bad = tools.filter((t) => !(GUARDED_TOOLS as readonly string[]).includes(t));
      if (bad.length) throw new Error(`Tools not allowed with a file guard: ${bad.join(", ")}`);
      fileTools = await guardedToolDefinitions(req.fileGuard, tools as GuardedToolName[]);
      cwd = req.fileGuard.root;
    }

    let captured: { value: Static<S> } | undefined;
    const tool = defineTool({
      name: req.resultTool.name,
      label: req.resultTool.name,
      description: req.resultTool.description,
      parameters: req.resultTool.parameters,
      async execute(_id, params) {
        captured = { value: params as Static<S> };
        return { content: [{ type: "text", text: "Recorded. You are done." }], details: undefined, terminate: true };
      },
    });

    const { session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel: req.thinking,
      modelRuntime: runtime,
      resourceLoader: minimalLoader(req.systemPrompt),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 3 },
      }),
      sessionManager: SessionManager.inMemory(cwd),
      tools: [...tools, req.resultTool.name],
      // Custom tools replace built-ins of the same name.
      customTools: [...fileTools, tool],
    });

    try {
      await session.prompt(req.prompt);
      if (!captured) {
        await session.prompt(
          `You did not call \`${req.resultTool.name}\`. Call it now with your final answer (use empty lists if there is nothing to report).`,
        );
      }
      if (session.model && !this.allowModel(session.model)) {
        throw new Error(`Session switched to a disallowed model ${session.model.provider}/${session.model.id}`);
      }
      const stats = session.getSessionStats();
      if (!captured) {
        const last = session.getLastAssistantText?.() ?? "";
        throw new Error(`Model never called ${req.resultTool.name}. Last reply: ${last.slice(0, 300)}`);
      }
      return {
        value: captured.value,
        usage: {
          input: stats.tokens.input,
          output: stats.tokens.output,
          cacheRead: stats.tokens.cacheRead,
          cacheWrite: stats.tokens.cacheWrite,
          cost: stats.cost,
        },
      };
    } finally {
      session.dispose();
    }
  }
}

/** Real runner: headless, in-memory pi sessions on Amazon Bedrock only. */
export class BedrockPiRunner extends SdkPiRunner {
  constructor() {
    let runtime: Promise<ModelRuntime> | undefined;
    super(
      async (id) => {
        runtime ??= ModelRuntime.create();
        const rt = await runtime;
        const model = rt.getModel(PROVIDER, id);
        if (!model) throw new Error(`Model ${PROVIDER}/${id} not found in the pi model catalog`);
        if (model.provider !== PROVIDER) throw new Error(`Refusing non-Bedrock model ${model.provider}/${model.id}`);
        return { runtime: rt, model };
      },
      (m) => m.provider === PROVIDER,
    );
  }
}

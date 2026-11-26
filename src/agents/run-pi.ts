import { homedir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import {
  GUARDED_TOOLS,
  type GuardedToolName,
  guardedToolDefinitions,
} from "./guard.ts";
import type {
  AgentRequest,
  AgentResult,
  AgentRunner,
  ThinkingLevel,
} from "./types.ts";

/** A loader that discovers nothing: no extensions, skills, prompts, or AGENTS.md. */
function minimalLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
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

interface Resolved {
  runtime: ModelRuntime;
  model: Model<Api>;
  thinking?: ThinkingLevel;
}

/** Headless, in-memory pi sessions through the SDK. `resolve` picks the runtime and model for a request. */
export class SdkPiRunner implements AgentRunner {
  private readonly resolve: (id: string | undefined) => Promise<Resolved>;

  constructor(resolve: (id: string | undefined) => Promise<Resolved>) {
    this.resolve = resolve;
  }

  async run<S extends TSchema>(
    req: AgentRequest<S>,
  ): Promise<AgentResult<Static<S>>> {
    const { runtime, model, thinking } = await this.resolve(req.model);
    const tools = req.tools ?? [];
    let fileTools: ToolDefinition[] = [];
    let cwd = req.cwd ?? process.cwd();
    if (req.fileGuard) {
      // Every file tool is the guarded version; anything else (bash, …) is refused.
      const bad = tools.filter(
        (t) => !(GUARDED_TOOLS as readonly string[]).includes(t),
      );
      if (bad.length)
        throw new Error(
          `Tools not allowed with a file guard: ${bad.join(", ")}`,
        );
      fileTools = await guardedToolDefinitions(
        req.fileGuard,
        tools as GuardedToolName[],
      );
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
        return {
          content: [{ type: "text", text: "Recorded. You are done." }],
          details: undefined,
          terminate: true,
        };
      },
    });

    const { session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel: req.thinking ?? thinking ?? "medium",
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
      const stats = session.getSessionStats();
      if (!captured) {
        const last = session.getLastAssistantText?.() ?? "";
        throw new Error(
          `Model never called ${req.resultTool.name}. Last reply: ${last.slice(0, 300)}`,
        );
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

/** pi's own defaults, from ~/.pi/agent/settings.json (global settings only). */
export function piDefaults(): {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
} {
  const sm = SettingsManager.create(homedir());
  const provider = sm.getDefaultProvider();
  const model = sm.getDefaultModel();
  const thinking = sm.getDefaultThinkingLevel() as ThinkingLevel | undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/**
 * Real runner: headless, in-memory pi sessions using pi's own model settings
 * (defaultProvider / defaultModel / defaultThinkingLevel), or a per-stage override
 * from lbg's config ("provider/id", or an id of pi's default provider).
 */
export class PiConfigRunner extends SdkPiRunner {
  constructor(defaults: () => ReturnType<typeof piDefaults> = piDefaults) {
    let runtime: Promise<ModelRuntime> | undefined;
    super(async (id) => {
      runtime ??= ModelRuntime.create();
      const rt = await runtime;
      const d = defaults();
      const spec = id ?? d.model;
      if (!spec)
        throw new Error(
          "No model: set a default model in pi (/model, or defaultModel in ~/.pi/agent/settings.json), or pi.model in lbg's config",
        );
      const slash = spec.indexOf("/");
      const [provider, modelId] =
        slash > 0 && id
          ? [spec.slice(0, slash), spec.slice(slash + 1)]
          : [d.provider, spec];
      if (!provider)
        throw new Error(
          `No provider for model ${spec}: set defaultProvider in pi, or use "provider/id"`,
        );
      const model = rt.getModel(provider, modelId);
      if (!model)
        throw new Error(
          `Model ${provider}/${modelId} not found in the pi model catalog${id ? "" : " (pi's default model)"}`,
        );
      return {
        runtime: rt,
        model,
        ...(!id && d.thinking ? { thinking: d.thinking } : {}),
      };
    });
  }
}

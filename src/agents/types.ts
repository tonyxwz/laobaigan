import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { FileGuard } from "./guard.ts";

/** What every model runner (pi SDK, Claude Code, scripted test runners) takes and returns. */

export type ThinkingLevel = NonNullable<
  CreateAgentSessionOptions["thinkingLevel"]
>;

export interface ResultTool<S extends TSchema> {
  name: string;
  description: string;
  parameters: S;
}

export interface PiRequest<S extends TSchema> {
  /** "provider/id", or an id of pi's default provider. Default: pi's default model. */
  model?: string | undefined;
  /** Default: pi's default thinking level (else "medium"). */
  thinking?: ThinkingLevel | undefined;
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

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

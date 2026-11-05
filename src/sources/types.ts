/** Agents whose session history we can read. */
export type AgentId = "claude" | "pi" | "opencode" | "codex" | "kiro";

export const ALL_AGENTS: readonly AgentId[] = ["claude", "pi", "opencode", "codex", "kiro"];

/** A lightweight pointer to a session, cheap to produce during listing. */
export interface SessionRef {
  agent: AgentId;
  /** Agent-native session id. Unique per agent. */
  sessionId: string;
  /** File path (JSONL agents) or db path (SQLite agents). */
  location: string;
  /** Working directory, if cheaply known at listing time. */
  cwd?: string;
  title?: string;
  updatedAt: Date;
  /** Opaque change token (e.g. "mtimeMs:size"); changes whenever content changes. */
  version: string;
}

export type Role = "user" | "assistant" | "tool";

export interface ToolCall {
  name: string;
  /** Compact, truncated rendering of the call input. */
  input: string;
}

export interface Turn {
  role: Role;
  /** Human-readable text. For tool turns: the (truncated) tool result. */
  text: string;
  ts?: Date;
  /** Assistant turns: tools invoked in this turn. */
  toolCalls?: ToolCall[];
  /** Tool turns: which tool produced this result. */
  toolName?: string;
  isError?: boolean;
  /**
   * User turns: where the text came from.
   *  - "prompt": typed by the human
   *  - "command": slash command / shell escape issued by the human
   *  - "interrupt": the human interrupted the agent
   */
  origin?: "prompt" | "command" | "interrupt";
  /**
   * True when the turn is not on the session's active branch (the user rewound /
   * edited a message / branched). Kept because rewinds are often corrections.
   */
  offBranch?: boolean;
}

export interface Transcript {
  agent: AgentId;
  sessionId: string;
  location: string;
  cwd: string;
  title?: string;
  startedAt: Date;
  updatedAt: Date;
  /** Set when this session was spawned by another one (sub-agent). */
  parentSessionId?: string;
  /** All branches in chronological order, oldest first. See `Turn.offBranch`. */
  turns: Turn[];
}

export interface ListOptions {
  /** Only sessions updated at or after this time. */
  since?: Date;
}

export interface SourceAdapter {
  readonly agent: AgentId;
  /** Whether this agent's storage exists on this host. */
  available(): Promise<boolean>;
  list(opts?: ListOptions): AsyncIterable<SessionRef>;
  load(ref: SessionRef): Promise<Transcript>;
}

/**
 * A source that exists but can't be read (e.g. an unsupported schema). `scan`
 * skips that agent with a warning instead of failing the whole pass.
 */
export class SourceUnavailable extends Error {}

import type { parseArgs } from "node:util";
import type { AgentId, SourceAdapter } from "../sources/types.ts";

/** Every option lbg takes. Commands read the ones that apply to them. */
export const OPTIONS = {
  since: { type: "string" },
  agent: { type: "string" },
  settle: { type: "string" },
  session: { type: "string" },
  json: { type: "boolean", default: false },
  "user-only": { type: "boolean", default: false },
  "no-pager": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  fresh: { type: "boolean", default: false },
  excerpt: { type: "boolean", default: false },
  "max-calls": { type: "string" },
  status: { type: "string" },
  only: { type: "string", multiple: true },
  stages: { type: "string" },
  path: { type: "string" },
  force: { type: "boolean", default: false },
  commit: { type: "boolean", default: false },
  reason: { type: "string" },
  kind: { type: "string" },
  skill: { type: "string" },
  before: { type: "string" },
  forget: { type: "boolean", default: false },
  rule: { type: "string" },
  to: { type: "string" },
  revise: { type: "boolean", default: false },
  title: { type: "string" },
  name: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

export type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

/** What a command gets: the parsed command line and where to print. */
export interface Context {
  /** The command as typed (some commands have aliases). */
  cmd: string;
  /** Positional arguments after the command. */
  rest: string[];
  values: Values;
  /** --agent, parsed. */
  agents: AgentId[] | undefined;
  adapters: SourceAdapter[];
  out: (s: string) => void;
  json: (v: unknown) => void;
}

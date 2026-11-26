import { isAbsolute } from "node:path";
import {
  type FileGuard,
  GuardError,
  type GuardedToolName,
  type ResolvedGuard,
  resolveGuard,
} from "./guard.ts";

/**
 * The FileGuard for Claude Code's built-in file tools. Claude Code runs the tools itself;
 * lbg decides every call before it runs (a PreToolUse hook, with canUseTool as a backstop),
 * using the same path checks as pi's guarded tools:
 *
 *   Read, Glob, Grep   anywhere inside the worktree, or the guard's read-only roots
 *   Write, Edit        only inside the writable paths, never .git
 *   StructuredOutput   the final answer
 *   anything else      denied (Claude Code is only given these tools anyway)
 */

/** pi tool names (what pipeline stages ask for) → Claude Code built-ins. */
const CLAUDE_TOOLS: Record<GuardedToolName, string> = {
  read: "Read",
  ls: "Glob",
  find: "Glob",
  grep: "Grep",
  write: "Write",
  edit: "Edit",
};

/** Claude Code built-ins for the requested pi tools. */
export function claudeToolsFor(tools: readonly string[]): string[] {
  const bad = tools.filter((t) => !(t in CLAUDE_TOOLS));
  if (bad.length)
    throw new Error(`Tools not allowed with a file guard: ${bad.join(", ")}`);
  return [...new Set(tools.map((t) => CLAUDE_TOOLS[t as GuardedToolName]))];
}

/** The tool Claude Code answers an outputFormat request with. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

export type Decision = { allow: true } | { allow: false; reason: string };

export interface ClaudeGuard {
  root: string;
  decide(toolName: string, input: unknown): Promise<Decision>;
}

/** A glob that stays relative to its search path (no absolute paths, no `..`). */
function relativeGlob(field: string, v: unknown): void {
  if (v === undefined) return;
  if (typeof v !== "string") throw new GuardError(`${field} must be a string`);
  if (isAbsolute(v) || v.startsWith("~") || v.split(/[\\/]/).includes("..")) {
    throw new GuardError(
      `${field} ${v}: use a pattern relative to the worktree (no absolute paths, ~ or ..)`,
    );
  }
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !v) throw new GuardError(`${key} is required`);
  return v;
}

export async function claudeGuard(
  fileGuard: FileGuard,
  allowed: readonly string[],
): Promise<ClaudeGuard> {
  const g: ResolvedGuard = await resolveGuard(fileGuard);
  const tools = new Set(allowed);
  const searchPath = (input: Record<string, unknown>) =>
    typeof input.path === "string" && input.path ? input.path : ".";
  return {
    root: g.root,
    async decide(toolName, raw) {
      if (toolName === STRUCTURED_OUTPUT_TOOL) return { allow: true };
      if (!tools.has(toolName))
        return {
          allow: false,
          reason: `${toolName} is not available in this session.`,
        };
      const input = (raw && typeof raw === "object" ? raw : {}) as Record<
        string,
        unknown
      >;
      try {
        switch (toolName) {
          case "Read":
            await g.check(str(input, "file_path"), "read");
            break;
          case "Write":
          case "Edit":
            await g.check(str(input, "file_path"), "write");
            break;
          case "Glob":
            relativeGlob("pattern", input.pattern);
            await g.check(searchPath(input), "read");
            break;
          case "Grep":
            relativeGlob("glob", input.glob);
            await g.check(searchPath(input), "read");
            break;
          default:
            return {
              allow: false,
              reason: `${toolName} is not available in this session.`,
            };
        }
        return { allow: true };
      } catch (err) {
        if (err instanceof GuardError)
          return { allow: false, reason: err.message };
        throw err;
      }
    },
  };
}

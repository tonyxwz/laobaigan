#!/usr/bin/env node
/**
 * PreToolUse hook command for interactive `lbg proposal revise <id>` in Claude Code. lbg
 * starts `claude` in the draft's scratch dir with this hook in --settings and LBG_GUARD set to
 * {"root": "...", "writable": ["..."]}; Claude Code runs it before every tool call, passing
 * the call as JSON on stdin. The decision is the same as in lbg's SDK sessions (claude-guard.ts).
 *
 * Fails closed: on any error it exits 2, which blocks the call.
 */
import { claudeGuard, claudeToolsFor } from "./claude-guard.ts";
import { GUARDED_TOOLS, type FileGuard } from "./guard.ts";

async function main(): Promise<void> {
  const raw = process.env.LBG_GUARD;
  if (!raw) throw new Error("LBG_GUARD is not set");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tool_name?: unknown; tool_input?: unknown };
  const guard = await claudeGuard(JSON.parse(raw) as FileGuard, claudeToolsFor(GUARDED_TOOLS));
  const d = await guard.decide(String(input.tool_name ?? ""), input.tool_input);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: d.allow ? "allow" : "deny",
        permissionDecisionReason: d.allow ? "lbg file guard: allowed" : d.reason,
      },
    }),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`lbg file guard: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});

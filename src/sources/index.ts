import { ClaudeAdapter } from "./claude.ts";
import { OpencodeAdapter } from "./opencode.ts";
import { PiAdapter } from "./pi.ts";
import type { AgentId, ListOptions, SessionRef, SourceAdapter } from "./types.ts";

export * from "./types.ts";

/** Adapters implemented so far. Codex and Kiro come later (README milestone M5). */
export function defaultAdapters(): SourceAdapter[] {
  return [new ClaudeAdapter(), new PiAdapter(), new OpencodeAdapter()];
}

export interface ScanOptions extends ListOptions {
  agents?: AgentId[];
  /** Skip sessions updated more recently than this (ms) — they may still be active. */
  settleMs?: number;
  now?: Date;
}

/** List sessions across all available adapters, newest last. */
export async function scan(
  adapters: SourceAdapter[],
  opts: ScanOptions = {},
): Promise<{ ref: SessionRef; adapter: SourceAdapter }[]> {
  const now = opts.now ?? new Date();
  const cutoff = opts.settleMs ? now.getTime() - opts.settleMs : Infinity;
  const out: { ref: SessionRef; adapter: SourceAdapter }[] = [];
  for (const adapter of adapters) {
    if (opts.agents && !opts.agents.includes(adapter.agent)) continue;
    if (!(await adapter.available())) continue;
    for await (const ref of adapter.list(opts)) {
      if (ref.updatedAt.getTime() > cutoff) continue;
      out.push({ ref, adapter });
    }
  }
  return out.sort((a, b) => a.ref.updatedAt.getTime() - b.ref.updatedAt.getTime());
}

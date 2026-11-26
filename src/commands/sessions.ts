import { scan } from "../sources/index.ts";
import { parseDuration, parseSince } from "../util/time.ts";
import type { Context } from "./context.ts";
import { summarize } from "./format.ts";

/** `lbg sessions`. */
export async function sessionsCommand(ctx: Context): Promise<number> {
  const { values, agents, adapters, out, json } = ctx;
  const found = await scan(adapters, {
    since: parseSince(values.since ?? "7d"),
    settleMs: parseDuration(values.settle ?? "0m"),
    ...(agents ? { agents } : {}),
  });
  const rows = [];
  for (const { ref, adapter } of found) {
    try {
      rows.push(summarize(await adapter.load(ref)));
    } catch (err) {
      process.stderr.write(
        `warn: failed to load ${ref.agent}:${ref.sessionId}: ${String(err)}\n`,
      );
    }
  }
  rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (values.json) return (json(rows), 0);
  for (const r of rows) {
    out(
      `${r.updatedAt.slice(0, 16).replace("T", " ")}  ${r.agent.padEnd(8)} ${r.sessionId.slice(0, 12).padEnd(12)}  ` +
        `user=${String(r.userTurns).padStart(3)} turns=${String(r.turns).padStart(4)}  ${r.cwd}\n` +
        `    ${r.title ?? r.firstPrompt}\n`,
    );
  }
  out(`\n${rows.length} session(s)\n`);
  return 0;
}

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { modelRunner } from "../pi/run-claude.ts";
import { type ProcessOptions, processSessions } from "../pipeline/process.ts";
import { StateDb } from "../state/db.ts";
import { parseDuration, parseSince } from "../util/time.ts";
import type { Context } from "./context.ts";
import { parseSessionTarget, renderOutcomes } from "./format.ts";

/** `lbg scan`. */
export async function scanCommand(ctx: Context): Promise<number> {
  const { values, agents, adapters, out, json } = ctx;
  const cfg = loadConfig();
  const db = new StateDb(join(cfg.stateDir, "state.db"));
  try {
    const opts: ProcessOptions = {
      plan: true,
      fresh: values.fresh,
      ...(values.since && values.since !== "all"
        ? { since: parseSince(values.since) }
        : {}),
      ...(agents ? { agents } : {}),
      ...(values.session ? { only: parseSessionTarget(values.session) } : {}),
      ...(values["max-calls"] ? { maxCalls: Number(values["max-calls"]) } : {}),
      ...(values.settle
        ? { settleMinutes: parseDuration(values.settle) / 60e3 }
        : {}),
      log: (m) => process.stderr.write(`${m}\n`),
    };
    const res = await processSessions(
      adapters,
      db,
      modelRunner(cfg),
      cfg,
      opts,
    );
    if (values.json) return (json(res), 0);
    renderOutcomes(res.outcomes, out);
    if (values.excerpt) {
      for (const o of res.outcomes) {
        o.excerptText?.forEach((c, i, chunks) => {
          out(`\n===== excerpt chunk ${i + 1}/${chunks.length} =====\n${c}`);
        });
      }
    }
    return res.outcomes.some((o) => o.status === "error") ? 2 : 0;
  } finally {
    db.close();
  }
}

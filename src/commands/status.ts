import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { StateDb } from "../state/db.ts";
import type { Context } from "./context.ts";

/** `lbg status`. */
export async function statusCommand(ctx: Context): Promise<number> {
  const { out } = ctx;
  const cfg = loadConfig();
  const db = new StateDb(join(cfg.stateDir, "state.db"));
  try {
    out(`state: ${join(cfg.stateDir, "state.db")}\n`);
    out(`${JSON.stringify(db.counts())}\n\nrecent runs:\n`);
    const runs = db.db
      .prepare("SELECT * FROM run ORDER BY id DESC LIMIT 5")
      .all() as Record<string, unknown>[];
    for (const r of runs)
      out(
        `  #${r.id} ${new Date(Number(r.started_at)).toISOString()} ${r.kind} ${r.stats ?? "(unfinished)"}\n`,
      );
    return 0;
  } finally {
    db.close();
  }
}

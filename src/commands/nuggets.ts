import { join } from "node:path";
import { loadConfig } from "../config.ts";
import * as curate from "../pipeline/curate.ts";
import { scoreTree } from "../pipeline/treescore.ts";
import { StateDb } from "../state/db.ts";
import { subtreeNuggets, Tree } from "../state/tree.ts";
import { indent } from "../util/text.ts";
import { parseSince } from "../util/time.ts";
import type { Context } from "./context.ts";
import { evidenceTime, renderScore } from "./format.ts";

/** `lbg nuggets`. */
export async function nuggetsCommand(ctx: Context): Promise<number> {
  const { rest, values, out, json } = ctx;
  const cfg = loadConfig();
  const db = new StateDb(join(cfg.stateDir, "state.db"));
  try {
    const tree = new Tree(db);
    if (rest[0] === "move") {
      const [n, node] = rest
        .slice(1, 3)
        .map((x) => Number((x ?? "").replace(/^#/, "")));
      if (!Number.isInteger(n) || !Number.isInteger(node))
        throw new Error("nuggets move expects <nugget> <node>");
      curate.moveNugget(tree, n!, node!);
      renderScore(scoreTree(tree, cfg.score), out);
      out(
        `nugget #${n} → ${tree
          .path(node!)
          .slice(1)
          .map((p) => `#${p.id} ${p.title}`)
          .join(" › ")}\n`,
      );
      return 0;
    }
    if (rest[0] === "forget" || rest[0] === "unforget") {
      const ids = rest.slice(1).map((x) => Number(x.replace(/^#/, "")));
      if (ids.some((x) => !Number.isInteger(x) || x <= 0))
        throw new Error(`nuggets ${rest[0]} expects nugget ids`);
      if (rest[0] === "unforget") {
        if (!ids.length) throw new Error("nuggets unforget expects nugget ids");
        const n = tree.unforgetNuggets({ ids });
        renderScore(scoreTree(tree, cfg.score), out);
        out(`${n} nugget(s) count again.\n`);
        return 0;
      }
      let targets = ids;
      if (values.skill !== undefined || values.before !== undefined) {
        if (ids.length)
          throw new Error(
            "give nugget ids, or --skill with --before, not both",
          );
        if (values.skill === undefined || values.before === undefined)
          throw new Error("--skill and --before go together");
        const skill = tree.subtree(Number(values.skill.replace(/^#/, "")));
        if (!skill || skill.depth !== 1)
          throw new Error(`--skill ${values.skill}: not a skill`);
        const before = parseSince(values.before);
        targets = subtreeNuggets(skill)
          .filter((g) => evidenceTime(g) < before.getTime())
          .map((g) => g.id);
      }
      if (!targets.length) throw new Error("nothing to forget");
      const n = tree.forgetNuggets(
        targets,
        values.reason?.trim() || "forgotten by hand",
      );
      renderScore(scoreTree(tree, cfg.score), out);
      out(
        `${n} nugget(s) forgotten: they no longer count or go into drafts (lbg nuggets unforget <id> to undo).\n`,
      );
      return 0;
    }
    if (rest[0])
      throw new Error(
        `Unknown nuggets subcommand: ${rest[0]} (move | forget | unforget)`,
      );
    const rows = db.nuggets();
    if (values.json) {
      json(rows);
      return 0;
    }
    for (const r of rows) {
      const where =
        r.nodeId !== undefined
          ? tree
              .path(r.nodeId)
              .slice(1)
              .map((p) => p.name ?? p.title)
              .join(" › ")
          : "(not placed)";
      out(
        `#${r.id} [${r.kind}/${r.scope}] ${r.title}  (${r.agent}:${r.sessionId.slice(0, 12)}, conf ${r.confidence})\n` +
          `    in: ${where}${r.coveredNodeId !== undefined ? "  (already covered by the live text)" : ""}` +
          `${r.forgottenAt ? `  (forgotten: ${r.forgottenReason ?? ""})` : ""}\n${indent(r.knowledge)}\n\n`,
      );
    }
    out(`${rows.length} nugget(s)\n`);
    return 0;
  } finally {
    db.close();
  }
}

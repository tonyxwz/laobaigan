import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import * as curate from "../pipeline/curate.ts";
import { type SyncReport, syncTree } from "../pipeline/sync.ts";
import { scoreTree } from "../pipeline/treescore.ts";
import { StateDb } from "../state/db.ts";
import { Tree } from "../state/tree.ts";
import type { Context } from "./context.ts";
import {
  renderNodeDetail,
  renderScore,
  renderSkill,
  renderTree,
  shortPath,
} from "./format.ts";

/** `lbg tree`. */
export async function treeCommand(ctx: Context): Promise<number> {
  const { rest, values, out, json } = ctx;
  const cfg = loadConfig();
  const real = new StateDb(join(cfg.stateDir, "state.db"));
  const tmp = values["dry-run"]
    ? mkdtempSync(join(tmpdir(), "lbg-dry-"))
    : undefined;
  const db = tmp ? real.snapshotTo(join(tmp, "state.db")) : real;
  try {
    const tree = new Tree(db);
    const num = (x: string | undefined, what: string) => {
      const n = Number((x ?? "").replace(/^#/, ""));
      if (!Number.isInteger(n) || n <= 0)
        throw new Error(`Expected ${what} id, got ${JSON.stringify(x)}`);
      return n;
    };
    /** After a hand edit: re-score (no model calls) and show the affected skill. */
    const after = (id: number | undefined, msg: string) => {
      const scored = scoreTree(tree, cfg.score);
      out(`${msg}${tmp ? "  (dry run: nothing persisted)" : ""}\n`);
      renderScore(scored, out);
      const skill =
        id !== undefined ? tree.path(id).find((p) => p.depth === 1) : undefined;
      const s = skill && tree.subtree(skill.id);
      if (s) renderSkill(s, out);
      return 0;
    };
    switch (rest[0]) {
      case "merge": {
        const into = num(rest[1], "skill");
        const from = rest.slice(2).map((x) => num(x, "skill"));
        if (!from.length)
          throw new Error("tree merge expects <into> <from>...");
        const r = curate.mergeSkills(tree, into, from);
        return after(
          into,
          `merged ${from.map((x) => `#${x}`).join(", ")} into #${into}: ${r.sections} section(s), ${r.nuggets} nugget(s) moved`,
        );
      }
      case "split": {
        const skill = num(rest[1], "skill");
        const sections = rest.slice(2).map((x) => num(x, "section"));
        if (!sections.length)
          throw new Error("tree split expects <skill> <section>...");
        const created = curate.splitSkill(tree, skill, sections, values.title);
        after(
          skill,
          `split ${sections.map((x) => `#${x}`).join(", ")} out of #${skill} into new skill #${created}`,
        );
        renderSkill(tree.subtree(created)!, out);
        return 0;
      }
      case "move": {
        const id = num(rest[1], "node");
        const parent = num(rest[2], "parent");
        curate.moveNode(tree, id, parent);
        return after(id, `moved #${id} under #${parent}`);
      }
      case "rename": {
        const id = num(rest[1], "node");
        if (!values.title && !values.name)
          throw new Error("tree rename expects --title and/or --name");
        curate.renameNode(tree, id, {
          ...(values.title ? { title: values.title } : {}),
          ...(values.name ? { name: values.name } : {}),
        });
        return after(id, `renamed #${id}`);
      }
      case "unlock": {
        const id = num(rest[1], "node");
        curate.unlockNode(tree, id);
        return after(id, `unlocked #${id}`);
      }
    }
    if (rest[0] === "score") {
      const scored = scoreTree(tree, cfg.score);
      if (values.json) return (json(scored), 0);
      renderScore(scored, out);
      out(
        `${scored.scored} skill(s) scored${tmp ? "  (dry run: nothing persisted)" : ""}\n`,
      );
      return 0;
    }
    if (rest[0] === "sync") {
      const r = await syncTree(tree, {
        skillsDir: cfg.skillsDir,
        declared: cfg.topics,
        repoDocs: cfg.repoDocs,
      });
      if (values.json) return (json(r), 0);
      const line = (label: string, x: SyncReport) => {
        const parts = [
          x.created.length &&
            `created ${x.created.length} (${x.created.join(", ")})`,
          x.updated.length && `updated ${x.updated.join(", ")}`,
          x.adopted.length && `adopted ${x.adopted.join(", ")}`,
          x.removed.length && `removed ${x.removed.join(", ")}`,
          x.unchanged && `${x.unchanged} unchanged`,
        ].filter(Boolean);
        out(`${label}: ${parts.join("; ") || "nothing"}\n`);
      };
      line("global skills", r.global);
      for (const [repo, x] of Object.entries(r.repos))
        line(`repo ${shortPath(repo)}`, x);
      line("declared topics", r.declared);
      if (tmp) out("(dry run: nothing persisted)\n");
      return 0;
    }
    if (rest[0] === "show") {
      const n = tree.subtree(Number(rest[1]));
      if (!n) throw new Error(`No node ${rest[1]}`);
      if (values.json) return (json(n), 0);
      out(
        renderNodeDetail(
          n,
          tree.path(n.id).map((p) => p.title),
        ),
      );
      return 0;
    }
    if (rest[0]) throw new Error(`Unknown tree subcommand: ${rest[0]} (show)`);
    const roots = tree.trees();
    if (values.json) return (json(roots), 0);
    const statuses = values.status?.split(",");
    for (const r of roots) {
      if (statuses && !r.children.some((c) => statuses.includes(c.status)))
        continue;
      renderTree(r, out, statuses ? { statuses } : {});
    }
    const unplaced = tree.unplacedNuggets().length;
    out(
      `\n${unplaced ? `${unplaced} nugget(s) not placed yet. ` : ""}s=sessions n=nuggets. Details: lbg tree show <id>\n`,
    );
    return 0;
  } finally {
    if (tmp) {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
    real.close();
  }
}

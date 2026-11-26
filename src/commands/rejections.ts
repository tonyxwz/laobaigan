import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { StateDb } from "../state/db.ts";
import {
  assertKind,
  MEMORY_STATUSES,
  type MemoryStatus,
  Rejections,
} from "../state/rejections.ts";
import { Tree } from "../state/tree.ts";
import type { Context } from "./context.ts";
import { renderMemory } from "./format.ts";

/** `lbg rejections`. */
export async function rejectionsCommand(ctx: Context): Promise<number> {
  const { rest, values, out, json } = ctx;
  const cfg = loadConfig();
  const db = new StateDb(join(cfg.stateDir, "state.db"));
  try {
    const tree = new Tree(db);
    const mem = new Rejections(db, {
      expireDays: cfg.rejections.expireDays,
    });
    const [sub, idArg] = rest;
    const num = (x: string | undefined, what: string) => {
      const n = Number((x ?? "").replace(/^#/, ""));
      if (!Number.isInteger(n) || n <= 0)
        throw new Error(`Expected ${what} id, got ${JSON.stringify(x)}`);
      return n;
    };
    if (!sub) {
      const statuses = (values.status?.split(",") ?? [
        "pending",
        "active",
      ]) as MemoryStatus[];
      for (const st of statuses)
        if (!MEMORY_STATUSES.includes(st)) throw new Error(`Bad status ${st}`);
      const list = mem.list(statuses);
      if (values.json) {
        json(list);
        return 0;
      }
      for (const m of list) out(renderMemory(m, tree));
      out(
        `\n${list.length} rejection memor${list.length === 1 ? "y" : "ies"}. Correct one: lbg rejections edit <id> --kind … --rule "…"\n`,
      );
      return 0;
    }
    if (sub === "edit") {
      const id = num(idArg, "rejection memory");
      if (
        values.kind === undefined &&
        values.rule === undefined &&
        values.to === undefined
      )
        throw new Error("rejections edit expects --kind, --rule and/or --to");
      const kind =
        values.kind !== undefined ? assertKind(values.kind) : undefined;
      let target: number | undefined;
      if (values.to !== undefined) {
        target = num(values.to, "skill");
        const m = mem.mustGet(id);
        const t = tree.getNode(target);
        if (
          !t ||
          t.depth !== 1 ||
          t.scope !== m.scope ||
          (t.repo ?? undefined) !== (m.repo ?? undefined)
        )
          throw new Error(`--to ${target}: not a skill in the same scope`);
        if ((kind ?? m.kind) !== "wrong-place")
          throw new Error("--to only goes with --kind wrong-place");
      }
      const m = mem.edit(id, {
        ...(kind ? { kind } : {}),
        ...(values.rule !== undefined ? { rule: values.rule } : {}),
        ...(target !== undefined ? { targetNodeId: target } : {}),
      });
      out(renderMemory(m, tree));
      return 0;
    }
    if (sub === "keep") {
      const m = mem.keep(num(idArg, "rejection memory"));
      out(renderMemory(m, tree));
      return 0;
    }
    if (sub === "forget") {
      const id = num(idArg, "rejection memory");
      mem.forget(id);
      out(`rejection memory #${id} forgotten: lbg no longer uses it.\n`);
      return 0;
    }
    throw new Error(
      `Unknown rejections subcommand: ${sub} (edit | keep | forget)`,
    );
  } finally {
    db.close();
  }
}

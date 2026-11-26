import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { modelRunner } from "../pi/run-claude.ts";
import { exitCode, runPipeline, STAGES, type Stage } from "../pipeline/run.ts";
import { StateDb } from "../state/db.ts";
import { acquireLock } from "../util/lock.ts";
import type { Context } from "./context.ts";
import { parseSessionTarget, renderOutcomes } from "./format.ts";

/** `lbg run`. */
export async function runCommand(ctx: Context): Promise<number> {
  const { values, adapters, out, json } = ctx;
  const cfg = loadConfig();
  const dry = values["dry-run"];
  if (values.fresh && !dry)
    throw new Error(
      "--fresh needs --dry-run (it would re-extract everything into the real db)",
    );
  const stages = values.stages?.split(",").map((x) => x.trim()) as
    | Stage[]
    | undefined;
  for (const st of stages ?? [])
    if (!STAGES.includes(st))
      throw new Error(`Unknown stage ${st} (expected ${STAGES.join(", ")})`);
  const only = values.only
    ?.flatMap((x) => x.split(","))
    .map((x) => Number(x.trim().replace(/^#/, "")));
  if (only?.some((x) => !Number.isInteger(x) || x <= 0))
    throw new Error("--only expects skill ids");
  const session = values.session
    ? parseSessionTarget(values.session)
    : undefined;

  // A dry run works on a copy (no lock needed: the real db isn't written).
  const release = dry ? () => {} : acquireLock(join(cfg.stateDir, "run.lock"));
  if (!release) {
    process.stderr.write("another run is in progress; skipping\n");
    return 75; // EX_TEMPFAIL
  }
  const real = new StateDb(join(cfg.stateDir, "state.db"));
  const tmp = dry ? mkdtempSync(join(tmpdir(), "lbg-dry-")) : undefined;
  const db = tmp ? real.snapshotTo(join(tmp, "state.db")) : real;
  try {
    const r = await runPipeline(
      {
        adapters,
        db,
        runner: modelRunner(cfg),
        cfg: tmp ? { ...cfg, stateDir: tmp } : cfg,
        log: (m) => out(`  ${m}\n`),
      },
      {
        ...(stages
          ? { stages }
          : only
            ? { stages: ["sync", "score", "draft"] as Stage[] }
            : {}),
        ...(values["max-calls"]
          ? { maxExtractCalls: Number(values["max-calls"]) }
          : {}),
        ...(only ? { only } : {}),
        ...(session ? { session } : {}),
        ...(values.fresh ? { fresh: true } : {}),
      },
    );
    if (values.json) return (json(r), exitCode(r));
    if (r.waiting && !dry)
      out(`${r.waiting} proposal(s) waiting for review — lbg proposals\n`);
    // One line per stage, then one per new proposal: journald-friendly.
    for (const st of r.stages) {
      out(
        `${st.stage.padEnd(7)} ${st.status === "ok" ? "" : `[${st.status}] `}${st.summary}${st.calls ? ` (${st.calls} call(s), $${st.usage.cost.toFixed(4)})` : ""}\n`,
      );
    }
    if ((session || dry) && r.extracted.length)
      renderOutcomes(r.extracted, out);
    if (only)
      for (const k of r.skipped)
        out(`skipped #${k.nodeId} ${k.skill}: ${k.reason}\n`);
    for (const c of r.rejections)
      out(
        `rejection #${c.id} classified: ${c.kind}${c.target ? ` (→ ${c.target})` : ""} → ${c.rule} — check: lbg rejections\n`,
      );
    for (const p of r.proposals)
      out(
        `new proposal #${p.id}: ${p.skill} (${p.files} file(s))${dry ? "" : ` — review with: lbg proposal show ${p.id}`}\n`,
      );
    out(
      `run #${r.runId} finished in ${Math.round(r.ms / 1000)}s: ${r.calls} model call(s), cost≈$${r.usage.cost.toFixed(4)}${dry ? "  (dry run: nothing kept)" : ""}\n`,
    );
    if (r.abortedReason)
      process.stderr.write(
        `run aborted: ${r.abortedReason}\n(if this is a credentials error, refresh your model provider's credentials)\n`,
      );
    return exitCode(r);
  } finally {
    if (tmp) {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
    real.close();
    release();
  }
}

import type { Config } from "../config.ts";
import type { PiRunner, Usage } from "../pi/run-pi.ts";
import { addUsage, ZERO_USAGE } from "../pi/run-pi.ts";
import type { SourceAdapter } from "../sources/index.ts";
import type { StateDb } from "../state/db.ts";
import { Tree } from "../state/tree.ts";
import { insertNuggets } from "./insert.ts";
import { processSessions } from "./process.ts";
import { draftCandidates } from "./render.ts";
import { syncTree } from "./sync.ts";
import { scoreTree } from "./treescore.ts";
import { writePromptStatus } from "../notify/prompt.ts";

/**
 * One unattended pass (what the hourly timer runs):
 *
 *   sync     skill files → tree                     (no model)
 *   extract  new/changed sessions → nuggets         (≤ extract.maxCallsPerRun calls)
 *   insert   unplaced nuggets → skills/sections     (≤ insert.maxCallsPerRun calls)
 *   score    promote / demote candidates            (no model)
 *   draft    top candidates → proposals             (≤ render.maxPerRun drafts)
 *
 * A failing stage doesn't stop the others, except that repeated model errors
 * (expired credentials) skip the remaining model stages. With nothing new,
 * a run makes no model calls.
 */

export const STAGES = ["sync", "extract", "insert", "score", "draft"] as const;
export type Stage = (typeof STAGES)[number];

export interface StageReport {
  stage: Stage;
  status: "ok" | "error" | "skipped";
  calls: number;
  usage: Usage;
  /** One line for the journal. */
  summary: string;
  error?: string;
}

export interface NewProposal {
  id: number;
  nodeId: number;
  skill: string;
  files: number;
  cost: number;
}

export interface RunReport {
  runId: number;
  stages: StageReport[];
  proposals: NewProposal[];
  calls: number;
  usage: Usage;
  /** Set when model stages were skipped after repeated model errors. */
  abortedReason?: string;
  /** Proposals waiting for review after this run (what the prompt shows). */
  waiting?: number;
  ms: number;
}

export interface RunDeps {
  adapters: SourceAdapter[];
  db: StateDb;
  runner: PiRunner;
  cfg: Config;
  log?: (m: string) => void;
  now?: () => Date;
}

export async function runPipeline(deps: RunDeps, opts: { stages?: Stage[]; maxExtractCalls?: number } = {}): Promise<RunReport> {
  const { adapters, db, runner, cfg } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();
  const enabled = new Set(opts.stages ?? STAGES);
  const tree = new Tree(db);
  const runId = db.startRun("run", false);
  const rep: RunReport = { runId, stages: [], proposals: [], calls: 0, usage: ZERO_USAGE, ms: 0 };

  const stage = async (name: Stage, model: boolean, fn: () => Promise<Omit<StageReport, "stage" | "status">>): Promise<void> => {
    if (!enabled.has(name)) return;
    if (model && rep.abortedReason) {
      rep.stages.push({ stage: name, status: "skipped", calls: 0, usage: ZERO_USAGE, summary: "skipped: model errors earlier in this run" });
      return;
    }
    try {
      const r = await fn();
      rep.stages.push({ stage: name, status: "ok", ...r });
      rep.calls += r.calls;
      rep.usage = addUsage(rep.usage, r.usage);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`${name}: failed: ${error}`);
      rep.stages.push({ stage: name, status: "error", calls: 0, usage: ZERO_USAGE, summary: `failed: ${error}`, error });
    }
  };

  await stage("sync", false, async () => {
    const r = await syncTree(tree, { skillsDir: cfg.skillsDir, declared: cfg.topics });
    const all = [r.global, ...Object.values(r.repos), r.declared];
    const changed = all.reduce((a, x) => a + x.created.length + x.updated.length + x.adopted.length + x.removed.length, 0);
    return { calls: 0, usage: ZERO_USAGE, summary: changed ? `${changed} skill change(s) picked up from files` : "skill files unchanged" };
  });

  await stage("extract", true, async () => {
    const r = await processSessions(adapters, db, runner, cfg, {
      ...(opts.maxExtractCalls !== undefined ? { maxCalls: opts.maxExtractCalls } : {}),
      log,
      recordRun: false,
    });
    if (r.abortedReason) rep.abortedReason = r.abortedReason;
    const count = (s: string) => r.outcomes.filter((o) => o.status === s).length;
    const nuggets = r.outcomes.reduce((a, o) => a + (o.nuggets?.length ?? 0), 0);
    const parts = [`${count("extracted")} session(s) extracted, ${nuggets} new nugget(s)`];
    if (count("deferred")) parts.push(`${count("deferred")} deferred (budget)`);
    if (count("error")) parts.push(`${count("error")} error(s)`);
    if (r.abortedReason) parts.push(`aborted: ${r.abortedReason}`);
    for (const w of r.warnings) parts.push(`skipped ${w.agent}: ${w.message}`);
    return { calls: r.calls, usage: r.usage, summary: parts.join(", ") };
  });

  await stage("insert", true, async () => {
    const pending = tree.unplacedNuggets().length;
    if (!pending) return { calls: 0, usage: ZERO_USAGE, summary: "no new nuggets to place" };
    const r = await insertNuggets(tree, runner, cfg, { maxCalls: cfg.insert.maxCallsPerRun, log });
    const parts = [`placed ${r.placed} nugget(s)`];
    if (r.skillsCreated.length) parts.push(`new latent skill(s): ${r.skillsCreated.join(", ")}`);
    if (r.deferred) parts.push(`${r.deferred} deferred (budget)`);
    return { calls: r.calls, usage: r.usage, summary: parts.join(", ") };
  });

  await stage("score", false, async () => {
    const r = scoreTree(tree, cfg.score);
    const parts = [`${r.scored} skill(s) scored`];
    if (r.promoted.length) parts.push(`new candidate(s): ${r.promoted.map((p) => `#${p.id} ${p.title} (${p.kind})`).join(", ")}`);
    if (r.demoted.length) parts.push(`no longer candidate(s): ${r.demoted.map((d) => `#${d.id}`).join(", ")}`);
    return { calls: 0, usage: ZERO_USAGE, summary: parts.join("; ") };
  });

  await stage("draft", true, async () => {
    const outcomes = await draftCandidates(tree, runner, cfg, { log, now: now() });
    let calls = 0;
    let usage = ZERO_USAGE;
    const failed: string[] = [];
    for (const o of outcomes) {
      if (o.status === "skipped") continue;
      calls++;
      if (o.usage) usage = addUsage(usage, o.usage);
      const node = tree.getNode(o.nodeId);
      const skill = node?.name ?? node?.title ?? `#${o.nodeId}`;
      if (o.status === "open") rep.proposals.push({ id: o.proposalId, nodeId: o.nodeId, skill, files: o.files.length, cost: o.usage.cost });
      else failed.push(`${skill}: ${o.reason}`);
    }
    if (!outcomes.length) return { calls, usage, summary: "no candidates to draft" };
    const parts = [`${rep.proposals.length} new proposal(s)`];
    if (failed.length) parts.push(`${failed.length} failed (${failed.join("; ")})`);
    const skipped = outcomes.filter((o) => o.status === "skipped");
    if (skipped.length) parts.push(`${skipped.length} skipped`);
    if (failed.length && !rep.proposals.length) throw new Error(parts.join(", "));
    return { calls, usage, summary: parts.join(", ") };
  });

  // The shell prompt segment (count of proposals waiting); never fails the run.
  try {
    rep.waiting = writePromptStatus(db, cfg.stateDir);
  } catch (e) {
    log(`prompt status: ${e instanceof Error ? e.message : String(e)}`);
  }

  rep.ms = now().getTime() - started;
  db.finishRun(runId, {
    stages: rep.stages.map(({ stage, status, calls, usage, summary }) => ({ stage, status, calls, cost: usage.cost, tokens: { input: usage.input, output: usage.output }, summary })),
    proposals: rep.proposals,
    calls: rep.calls,
    usage: rep.usage,
    ...(rep.abortedReason ? { abortedReason: rep.abortedReason } : {}),
    ...(rep.waiting !== undefined ? { waiting: rep.waiting } : {}),
    ms: rep.ms,
  });
  return rep;
}

/** Exit code for systemd: 0 ok, 2 a stage failed, 3 model errors aborted the run. */
export function exitCode(r: RunReport): number {
  if (r.abortedReason) return 3;
  return r.stages.some((s) => s.status === "error") ? 2 : 0;
}

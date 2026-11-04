import type { Config } from "../config.ts";
import type { PiRunner, Usage } from "../pi/run-pi.ts";
import { addUsage, ZERO_USAGE } from "../pi/run-pi.ts";
import { loadSkillsDir, renderSkillIndex, repoContext, type SkillInfo } from "../skills/index.ts";
import { scan, type AgentId, type SessionRef, type SourceAdapter, type Transcript } from "../sources/index.ts";
import type { StateDb } from "../state/db.ts";
import { extractNuggets, type ExtractedNugget } from "./extract.ts";
import { fingerprintTranscript } from "./fingerprint.ts";
import { buildExcerpt, type Excerpt } from "./prefilter.ts";
import { join } from "node:path";

export interface ProcessOptions {
  since?: Date;
  agents?: AgentId[];
  /** Only this session (agent:id prefix). */
  only?: { agent: AgentId; idPrefix: string };
  /** Don't call the model; just report what would be processed. */
  plan?: boolean;
  /** Call the model but persist nothing. */
  dryRun?: boolean;
  /** Override config.extract.maxCallsPerRun. */
  maxCalls?: number;
  /** Ignore dedup state (treat every human turn as new). Only sensible with dryRun/plan. */
  fresh?: boolean;
  /**
   * Abort the run after this many consecutive model errors (e.g. expired
   * credentials), instead of marking every remaining session as failed. Default 3.
   */
  maxConsecutiveErrors?: number;
  /** Override config.settleMinutes. */
  settleMinutes?: number;
  log?: (msg: string) => void;
}

export interface SessionOutcome {
  ref: SessionRef;
  status: "up-to-date" | "skipped" | "planned" | "extracted" | "deferred" | "error" | "aborted";
  detail?: string;
  excerpt?: Pick<Excerpt, "signals" | "redactions"> & { chunks: number; approxTokens: number };
  /** The exact chunks sent (or that would be sent) to the model; only with `only`. */
  excerptText?: string[];
  nuggets?: ExtractedNugget[];
  usage?: Usage;
}

export interface ProcessResult {
  outcomes: SessionOutcome[];
  /** Set when the run stopped early (too many consecutive errors). */
  abortedReason?: string;
  usage: Usage;
  calls: number;
}

/**
 * One pass over all sessions:
 *   list → skip unchanged (version token) → load → fingerprint → skip if no new human turns
 *   → excerpt → extract (pi) → store nuggets → mark fingerprints seen → record version.
 */
export async function processSessions(
  adapters: SourceAdapter[],
  db: StateDb,
  runner: PiRunner,
  cfg: Config,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const log = opts.log ?? (() => {});
  const maxCalls = opts.maxCalls ?? cfg.extract.maxCallsPerRun;
  const persist = !opts.plan && !opts.dryRun;
  const runId = persist ? db.startRun("extract", false) : 0;

  const globalSkills = await loadSkillsDir(cfg.skillsDir, "global");
  const found = await scan(adapters, {
    ...(opts.since ? { since: opts.since } : {}),
    ...(opts.agents ? { agents: opts.agents } : {}),
    settleMs: (opts.settleMinutes ?? cfg.settleMinutes) * 60e3,
  });

  const outcomes: SessionOutcome[] = [];
  let usage = ZERO_USAGE;
  let calls = 0;
  // Fingerprints seen during this run, so dry-runs/plans also dedup resumed copies.
  const runSeen = new Set<string>();
  const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? 3;
  let consecutiveErrors = 0;
  let abortedReason: string | undefined;

  for (const { ref, adapter } of found) {
    if (opts.only && (ref.agent !== opts.only.agent || !ref.sessionId.startsWith(opts.only.idPrefix))) continue;
    if (abortedReason) {
      outcomes.push({ ref, status: "aborted", detail: "run aborted" });
      continue;
    }
    if (!opts.only && !opts.fresh && db.isUpToDate(ref)) {
      outcomes.push({ ref, status: "up-to-date" });
      continue;
    }

    let t: Transcript;
    try {
      t = await adapter.load(ref);
    } catch (err) {
      if (persist) db.recordSession(ref, ref.cwd ?? "", "error", `load: ${String(err)}`);
      outcomes.push({ ref, status: "error", detail: `load: ${String(err)}` });
      continue;
    }

    const fps = fingerprintTranscript(t);
    const seen = opts.fresh ? new Set<string>() : db.seenFingerprints(fps.values());
    for (const fp of fps.values()) if (runSeen.has(fp)) seen.add(fp);
    const excerpt = buildExcerpt(t, fps, seen, {
      chunkTokens: cfg.extract.chunkTokens,
      contextTokens: 6_000,
    });
    const summary = {
      signals: excerpt.signals,
      redactions: excerpt.redactions,
      chunks: excerpt.chunks.length,
      approxTokens: Math.round(excerpt.chunks.reduce((a, c) => a + c.length, 0) / 4),
    };

    // Never learn from lbg's own drafting/revising sessions.
    if (/\/lbg-(draft|chat)-[^/]*(\/|$)/.test(t.cwd)) excerpt.skip = "lbg's own drafting session";
    if (excerpt.skip) {
      if (persist) {
        db.tx(() => {
          db.markSeen(t.agent, t.sessionId, fps.values());
          db.recordSession(ref, t.cwd, "skipped", excerpt.skip, excerpt.signals);
        });
      }
      for (const fp of fps.values()) runSeen.add(fp);
      outcomes.push({ ref, status: "skipped", detail: excerpt.skip, excerpt: summary });
      continue;
    }

    if (opts.plan) {
      for (const fp of fps.values()) runSeen.add(fp);
      outcomes.push({ ref, status: "planned", excerpt: summary, ...(opts.only ? { excerptText: excerpt.chunks } : {}) });
      continue;
    }
    if (calls + excerpt.chunks.length > maxCalls) {
      outcomes.push({ ref, status: "deferred", detail: `call budget (${maxCalls}) reached`, excerpt: summary });
      continue;
    }

    const repo = await repoContext(t.cwd);
    try {
      log(`extract ${t.agent}:${t.sessionId} (${summary.chunks} chunk(s), ~${summary.approxTokens} tok)`);
      const out = await extractNuggets(
        runner,
        { transcript: t, ...(repo ? { repoRoot: repo.root } : {}), skillIndex: renderSkillIndex(globalSkills, repo), excerpt },
        { id: cfg.models.extract, thinking: cfg.models.extractThinking },
      );
      calls += out.calls;
      usage = addUsage(usage, out.usage);
      const nuggets = out.nuggets.map((n) => normalizeScope(n, repo?.root, globalSkills));
      if (persist) {
        db.tx(() => {
          for (const n of nuggets) {
            db.insertNugget({
              runId,
              agent: t.agent,
              sessionId: t.sessionId,
              cwd: t.cwd,
              kind: n.kind,
              title: n.title,
              knowledge: n.knowledge,
              triggers: n.triggers,
              scope: n.scope,
              ...(n.repo ? { repo: n.repo } : {}),
              ...(n.coveredBySkill ? { coveredBy: n.coveredBySkill } : {}),
              confidence: n.confidence,
              evidence: n.evidence.map((e) => {
                const idx = excerpt.labels.get(e.label)!;
                const turn = t.turns[idx];
                return {
                  label: e.label,
                  quote: e.quote,
                  ...(fps.get(idx) ? { fingerprint: fps.get(idx)! } : {}),
                  ...(turn?.ts ? { ts: turn.ts.toISOString() } : {}),
                };
              }),
            });
          }
          db.markSeen(t.agent, t.sessionId, fps.values());
          db.recordSession(ref, t.cwd, "extracted", `${nuggets.length} nugget(s), ${out.dropped} dropped`, excerpt.signals);
        });
      }
      for (const fp of fps.values()) runSeen.add(fp);
      outcomes.push({ ref, status: "extracted", excerpt: summary, nuggets, usage: out.usage });
      consecutiveErrors = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (persist) db.recordSession(ref, t.cwd, "error", msg, excerpt.signals);
      outcomes.push({ ref, status: "error", detail: msg, excerpt: summary });
      if (++consecutiveErrors >= maxConsecutiveErrors) {
        abortedReason = `${consecutiveErrors} consecutive model errors; last: ${msg}`;
        log(`aborting: ${abortedReason}`);
      }
    }
  }

  if (persist) {
    const byStatus: Record<string, number> = {};
    for (const o of outcomes) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    db.finishRun(runId, {
      byStatus,
      calls,
      usage,
      models: { extract: cfg.models.extract ?? "pi default" },
      ...(abortedReason ? { abortedReason } : {}),
    });
  }
  return { outcomes, usage, calls, ...(abortedReason ? { abortedReason } : {}) };
}

/** Fill in the repo for repo-scoped nuggets; fix obviously-wrong coveredBy names. */
function normalizeScope(n: ExtractedNugget, repoRoot: string | undefined, global: SkillInfo[]): ExtractedNugget {
  const out = { ...n };
  if (out.scope === "repo" && !out.repo && repoRoot) out.repo = repoRoot;
  if (out.scope === "global") delete out.repo;
  if (out.coveredBySkill && !global.some((s) => s.name === out.coveredBySkill) && !/agents\.md|claude\.md|\.agents\//i.test(out.coveredBySkill)) {
    // Keep the model's hint but mark it as unverified.
    out.coveredBySkill = `?${out.coveredBySkill}`;
  }
  return out;
}

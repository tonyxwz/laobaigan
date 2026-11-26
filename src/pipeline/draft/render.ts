import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Static } from "typebox";
import { GUARDED_TOOLS } from "../../agents/guard.ts";
import type { AgentRunner, Usage } from "../../agents/types.ts";
import { addUsage, ZERO_USAGE } from "../../agents/types.ts";
import { agentModel, type Config } from "../../config.ts";
import { type DraftFile, Proposals } from "../../state/proposals.ts";
import { subtreeNuggets, type Tree } from "../../state/tree.ts";
import { skillStats } from "../tree/treescore.ts";
import {
  buildDraftPrompt,
  DRAFT_SYSTEM_PROMPT,
  ReportDraftSchema,
} from "./draft-prompt.ts";
import { applyExclusions, type Rehomed } from "./exclude.ts";
import {
  type PrivateHit,
  privateProblems,
  privateRetryPrompt,
} from "./privacy.ts";
import { reviewFeedbackPrompt } from "./review.ts";
import {
  checkScope,
  type ScopeCheck,
  scopeProblem,
  scopeRetryPrompt,
} from "./scope.ts";
import { diffSnapshot, makeScratch, snapshot } from "./scratch.ts";
import {
  guardFor,
  type RenderTarget,
  resolveTarget,
  SkipError,
} from "./target.ts";
import { draftPrivateHits, verifyDraft } from "./verify.ts";

/**
 * Draft one candidate skill as a proposal, stored in the db. lbg never runs git and never
 * touches the live files while drafting.
 *
 *   resolve the target (target.ts) → copy its writable paths into a scratch dir (scratch.ts) →
 *   the drafter, with guarded file tools confined to the scratch dir (draft-prompt.ts) →
 *   verify (verify.ts) → store the changed files (with hashes of the originals) → proposal `open`.
 *   Failure: proposal `failed`, node stays a candidate. The scratch dir is always removed.
 */

export type DraftOutcome =
  | {
      status: "open";
      nodeId: number;
      proposalId: number;
      files: DraftFile[];
      usage: Usage;
      excluded: Rehomed[];
    }
  | {
      status: "failed";
      nodeId: number;
      proposalId?: number;
      reason: string;
      usage?: Usage;
    }
  /** The drafter found nothing on-topic to add: everything new was re-filed elsewhere. */
  | {
      status: "nothing";
      nodeId: number;
      proposalId: number;
      usage: Usage;
      excluded: Rehomed[];
    }
  | { status: "skipped"; nodeId: number; reason: string };

/** What one drafter run left behind. */
interface Attempt {
  report: Static<typeof ReportDraftSchema>;
  files: DraftFile[];
  problems: string[];
  priv: PrivateHit[];
  /** Private terms are the draft's only problem. */
  onlyPrivate: boolean;
  scope: ScopeCheck | undefined;
}

/** A problem the drafter gets one chance to fix, instead of the draft failing. */
interface Fix {
  /** For the log. */
  what: string;
  /** What to tell the drafter. */
  prompt: string;
}

const RETRYABLE: ((a: Attempt) => Fix | undefined)[] = [
  // A live skill's description that took on a new subject.
  (a) =>
    a.scope?.widened
      ? {
          what: `description widens the scope (${a.scope.added.join(", ")})`,
          prompt: scopeRetryPrompt(a.scope),
        }
      : undefined,
  (a) =>
    a.onlyPrivate
      ? {
          what: "adds private terms to a public repository",
          prompt: privateRetryPrompt(a.priv),
        }
      : undefined,
];

/** Draft one candidate skill into an `open` proposal. Never throws for drafting problems. */
export async function draftSkill(
  tree: Tree,
  runner: AgentRunner,
  cfg: Config,
  nodeId: number,
  opts: { log?: (m: string) => void } = {},
): Promise<DraftOutcome> {
  const log = opts.log ?? (() => {});
  const props = new Proposals(tree.db);
  const skill = tree.subtree(nodeId);
  if (!skill || skill.depth !== 1)
    return { status: "skipped", nodeId, reason: "not a skill" };
  if (skill.status !== "candidate" || !skill.proposalKind)
    return {
      status: "skipped",
      nodeId,
      reason: `status is ${skill.status}, not a candidate`,
    };
  const kind = skill.proposalKind;

  let target: RenderTarget;
  try {
    target = await resolveTarget(skill, cfg);
  } catch (e) {
    if (e instanceof SkipError)
      return { status: "skipped", nodeId, reason: e.message };
    throw e;
  }
  if (
    kind === "new" &&
    target.skillDir &&
    existsSync(join(target.root, target.skillDir))
  ) {
    return {
      status: "skipped",
      nodeId,
      reason: `${join(target.root, target.skillDir)} already exists; run lbg tree sync so this becomes an update`,
    };
  }

  if (skill.name !== target.skillName && skill.origin !== "file")
    tree.updateNode(nodeId, { name: target.skillName });
  const st = skillStats(skill);
  const proposalId = props.create({
    nodeId,
    kind,
    scope: skill.scope,
    ...(skill.scope === "repo" ? { repo: target.root } : {}),
    skillName: target.skillName,
    targetRoot: target.root,
    writable: target.writable,
    primary: target.primary,
    nuggetIds: subtreeNuggets(skill).map((n) => n.id),
    sessions:
      kind === "new"
        ? st.sessions
        : (st.fresh?.sessions ?? 0) + (st.covered?.sessions ?? 0),
  });
  let usage: Usage | undefined;
  let scratch: string | undefined;
  const spent = (): Usage => usage ?? ZERO_USAGE;
  const fail = (reason: string): DraftOutcome => {
    log(`draft ${target.skillName}: failed: ${reason}`);
    props.markFailed(proposalId, reason, usage);
    return {
      status: "failed",
      nodeId,
      proposalId,
      reason,
      ...(usage ? { usage } : {}),
    };
  };
  try {
    const started = new Date(); // the evidence the draft sees is the subtree as of now
    const base = await snapshot(target.root, target.writable);
    const dir = await makeScratch(target);
    scratch = dir;
    log(`draft ${target.skillName} (${kind}): proposal #${proposalId}`);
    const siblings =
      skill.parentId !== undefined
        ? tree
            .children(skill.parentId)
            .map((c) => ({ ...c, children: [], nuggets: [], forgotten: [] }))
        : [];
    const review = reviewFeedbackPrompt(tree, skill);
    const live = skill.origin === "file";
    /** One drafter run in the scratch copy, and what its files look like afterwards. */
    const attempt = async (
      prompt: string,
      description: string,
    ): Promise<Attempt> => {
      const res = await runner.run({
        ...agentModel(cfg),
        systemPrompt: DRAFT_SYSTEM_PROMPT,
        prompt,
        tools: [...GUARDED_TOOLS],
        fileGuard: guardFor(dir, target),
        resultTool: {
          name: "report_draft",
          description,
          parameters: ReportDraftSchema,
        },
      });
      usage = usage ? addUsage(usage, res.usage) : res.usage;
      const files = await diffSnapshot(base, dir, target.writable);
      const problems = verifyDraft(files, base, target, cfg);
      const priv = draftPrivateHits(files, base, target, cfg);
      const onlyPrivate =
        priv.length > 0 && problems.length === privateProblems(priv).length;
      return {
        report: res.value,
        files,
        problems,
        priv,
        onlyPrivate,
        // The scope is only worth checking on a draft that is otherwise fine (or fixable).
        scope:
          problems.length && !onlyPrivate
            ? undefined
            : checkScope(files, base, target, kind, live),
      };
    };
    const first = await attempt(
      buildDraftPrompt(skill, kind, target, siblings, { review }),
      "Report the finished draft.",
    );
    let { report, files, problems, scope } = first;
    // Fixable problems get one retry, in the same scratch copy. Anything else fails right away.
    const fixes = RETRYABLE.map((r) => r(first)).filter((f) => f !== undefined);
    if (fixes.length) {
      log(
        `draft ${target.skillName}: ${fixes.map((f) => f.what).join("; ")}; asking the drafter to fix it`,
      );
      const retry = await attempt(
        `${buildDraftPrompt(skill, kind, target, siblings, { review, closing: false })}\n\nThe files in the current directory are your draft.\n\n${fixes.map((f) => f.prompt).join("\n\n")}`,
        "Report the fixed draft.",
      );
      report = {
        ...retry.report,
        excluded: [
          ...(report.excluded ?? []),
          ...(retry.report.excluded ?? []),
        ],
      };
      ({ files, problems } = retry);
      scope = problems.length ? undefined : retry.scope;
    }
    if (scope?.widened) problems.push(scopeProblem(scope));
    if (
      !files.length &&
      report.excluded?.length &&
      problems.every((p) => p === "no files were changed")
    ) {
      // Not a failure: the new evidence wasn't this skill's topic. Re-file it and close the proposal.
      const ex = await applyExclusions(
        tree,
        runner,
        cfg,
        proposalId,
        skill,
        report.excluded,
        "drafter",
        log,
      );
      if (ex.usage) usage = addUsage(spent(), ex.usage);
      props.markFailed(
        proposalId,
        `nothing on-topic to add: ${ex.items.length} off-topic item(s) re-filed elsewhere`,
        usage,
      );
      log(
        `draft ${target.skillName}: nothing on-topic to add; ${ex.items.length} item(s) re-filed`,
      );
      return {
        status: "nothing",
        nodeId,
        proposalId,
        usage: spent(),
        excluded: ex.items,
      };
    }
    if (problems.length) return fail(`verification: ${problems.join("; ")}`);
    props.markOpen(proposalId, files, report.summary, spent(), {
      draftedAt: started,
      nuggetIds: subtreeNuggets(skill).map((n) => n.id),
    });
    const ex = await applyExclusions(
      tree,
      runner,
      cfg,
      proposalId,
      skill,
      report.excluded ?? [],
      "drafter",
      log,
    );
    if (ex.usage) usage = addUsage(spent(), ex.usage);
    log(
      `draft ${target.skillName}: proposal #${proposalId} ready (${files.length} file(s)${ex.items.length ? `, ${ex.items.length} off-topic item(s) re-filed` : ""})`,
    );
    return {
      status: "open",
      nodeId,
      proposalId,
      files,
      usage: spent(),
      excluded: ex.items,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

/** Draft candidates (highest score first), up to cfg.render.maxPerRun. */
export async function draftCandidates(
  tree: Tree,
  runner: AgentRunner,
  cfg: Config,
  opts: {
    nodeIds?: number[];
    max?: number;
    log?: (m: string) => void;
    now?: Date;
  } = {},
): Promise<DraftOutcome[]> {
  const max = opts.max ?? cfg.render.maxPerRun;
  const props = new Proposals(tree.db);
  for (const id of props.recoverInterrupted())
    opts.log?.(
      `proposal #${id}: drafting was interrupted earlier; marked failed`,
    );
  const cutoff =
    (opts.now ?? new Date()).getTime() - cfg.render.retryAfterHours * 3600e3;
  /** A recent failure: don't spend another drafting session on it yet. */
  const backingOff = (id: number) => {
    const last = props.forNode(id).at(-1);
    return (
      last?.status === "failed" && (last.closedAt?.getTime() ?? 0) > cutoff
    );
  };
  const candidates = opts.nodeIds
    ? opts.nodeIds
    : tree
        .trees()
        .flatMap((r) => r.children)
        .filter((s) => s.status === "candidate" && !backingOff(s.id))
        .sort((a, b) => b.score - a.score || a.id - b.id)
        .map((s) => s.id);
  const out: DraftOutcome[] = [];
  let drafted = 0;
  for (const id of candidates) {
    if (drafted >= max) break;
    const o = await draftSkill(
      tree,
      runner,
      cfg,
      id,
      opts.log ? { log: opts.log } : {},
    );
    out.push(o);
    if (o.status !== "skipped") drafted++;
  }
  return out;
}

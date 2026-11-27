import { GUARDED_TOOLS } from "../../agents/guard.ts";
import { type AgentRunner, addUsage, type Usage } from "../../agents/types.ts";
import { agentModel, type Config } from "../../config.ts";
import { Feedback } from "../../state/feedback.ts";
import type { Tree } from "../../state/tree.ts";
import { guardFor } from "../common/target.ts";
import {
  DRAFT_SYSTEM_PROMPT,
  ReportDraftSchema,
} from "../draft/draft-prompt.ts";
import {
  type CloseResult,
  closeDraft,
  discardDraft,
  openDraft,
  reviseContext,
} from "../draft/workspace.ts";
import { applyExclusions, type Rehomed } from "../tree/exclude.ts";

/**
 * One-shot revise: the model reworks an open proposal's draft from my feedback, in the
 * draft workspace (draft/workspace.ts). The chat and the editor are in interactive.ts.
 */

export interface ReviseResult extends CloseResult {
  usage: Usage;
  summary: string;
  /** Evidence the reviser left out as off-topic, re-filed elsewhere. */
  excluded: Rehomed[];
}

/** One-shot revise: pi redrafts the stored draft with my feedback. Nothing is stored if verification fails. */
export async function reviseProposal(
  tree: Tree,
  runner: AgentRunner,
  cfg: Config,
  id: number,
  feedback: string,
): Promise<ReviseResult> {
  const ws = await openDraft(tree, id);
  const prompt = `${reviseContext(tree, ws)}\n\nFeedback from the engineer (apply it):\n${feedback}\n\nRevise the files now, then call report_draft.`;
  // What I asked for is review feedback for this skill, whatever the redraft's outcome.
  new Feedback(tree.db).add({ proposalId: id, kind: "revise", text: feedback });
  try {
    const res = await runner.run({
      ...agentModel(cfg),
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      prompt,
      tools: [...GUARDED_TOOLS],
      fileGuard: guardFor(ws.scratch, ws.target),
      resultTool: {
        name: "report_draft",
        description: "Report the revised draft.",
        parameters: ReportDraftSchema,
      },
    });
    const closed = await closeDraft(tree, cfg, ws, {
      summary: res.value.summary,
      usage: res.usage,
      refreshEvidence: true,
    });
    let usage = res.usage;
    let excluded: Rehomed[] = [];
    if (!closed.problems.length && res.value.excluded?.length) {
      const ex = await applyExclusions(
        tree,
        runner,
        cfg,
        ws.proposal.id,
        ws.skill,
        res.value.excluded,
        "drafter",
      );
      excluded = ex.items;
      if (ex.usage) usage = addUsage(usage, ex.usage);
    }
    return { ...closed, usage, summary: res.value.summary, excluded };
  } finally {
    await discardDraft(ws);
  }
}

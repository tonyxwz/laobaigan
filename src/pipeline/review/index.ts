/**
 * Review: what I do with a proposal. Only these change skill files, and only on my command.
 *
 *   proposalView / proposalDiff  the proposal's change against the files on disk
 *   acceptProposal               write the files (lbg never runs git; commit* runs my command)
 *   rejectProposal               keep the reason as a rejection memory
 *   reviseProposal               the model reworks the draft from my feedback
 *   chatRevise / editProposal    rework it in a chat with the agent, or in my editor
 *   dropEvidence                 take evidence off the proposal and re-file it
 */

export type { Rebased } from "../draft/workspace.ts";
export { acceptProposal, newSinceDraft, privateHitsFor } from "./accept.ts";
export {
  commitTargetFor,
  commitTemplate,
  renderCommit,
  runCommit,
} from "./commit.ts";
export { dropEvidence } from "./drop.ts";
export {
  chatRevise,
  editProposal,
  type InteractiveResult,
} from "./interactive.ts";
export { proposalDiff, proposalView } from "./proposal-view.ts";
export { rejectProposal } from "./reject.ts";
export { reviseProposal } from "./revise.ts";

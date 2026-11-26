/**
 * Draft: a candidate skill → a proposal, without touching the live files.
 *
 *   draftCandidates  the candidates of this run, highest score first
 *   draftSkill       one candidate: resolve where it goes (target, homes) → copy the writable
 *                    paths (scratch) → the drafter writes there (draft-prompt) → checks (verify,
 *                    scope, privacy) → proposal; evidence the drafter left out is re-filed (exclude)
 */
export { privateProblems } from "./privacy.ts";
export { type DraftOutcome, draftCandidates, draftSkill } from "./render.ts";

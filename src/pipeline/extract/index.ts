/**
 * Extract: what I said in agent sessions → nuggets.
 *
 *   processSessions     list sessions → skip unchanged → fingerprint the human turns → excerpt
 *                       (prefilter, redact) → one model call per session → nuggets
 *   classifyRejections  each pending rejection → its kind and a one-line rule, so that
 *                       extraction and routing can follow it
 */
export { type ClassifyResult, classifyRejections } from "./classify.ts";
export {
  type ProcessOptions,
  processSessions,
  type SessionOutcome,
} from "./process.ts";

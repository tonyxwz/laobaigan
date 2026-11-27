/**
 * Common: what more than one stage needs to know about a draft's destination. No model calls.
 *
 *   homes    the kinds of place a node's knowledge lives in (AGENTS.md section or intro,
 *            document, skill, latent) and what differs between them
 *   target   RenderTarget (where a draft goes), isAllowed, guardFor
 *   privacy  the private-terms gate for public repositories
 */
export { type PrivateHit, privateProblems } from "./privacy.ts";

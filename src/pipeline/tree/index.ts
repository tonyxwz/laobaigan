/**
 * Tree: where each nugget belongs, and which skills have earned a proposal.
 *
 *   syncTree         skill files, AGENTS.md and documents → live nodes (files are the truth)
 *   insertNuggets    each new nugget → a skill, then a section of it (one model call per level)
 *   scoreTree        recurrence per skill → candidates for a new / update / fix-description proposal
 *   applyExclusions  evidence left out of a skill (by the drafter or me) → off that skill, re-inserted
 *   curate           my hand edits to the tree (merge, split, move, rename); they lock what they touch
 */
export * as curate from "./curate.ts";
export { applyExclusions, type Rehomed } from "./exclude.ts";
export { insertNuggets } from "./insert.ts";
export { type SyncReport, syncTree } from "./sync.ts";
export { scoreTree, type TreeScoreResult } from "./treescore.ts";

import { parseFrontmatter } from "../skills/index.ts";
import type { DraftFile } from "../state/proposals.ts";
import type { ProposalKind } from "../state/tree.ts";
import type { RenderTarget } from "./render.ts";

/**
 * A live skill's scope. Its description is a contract: it tells agents (and lbg's router)
 * what belongs in the skill. An `update` may rephrase it with words the skill already uses,
 * but not add a subject the skill doesn't cover; that is a new skill or a split, proposed as
 * such. `fix-description` proposals are exempt (the description is their point), and so are
 * new skills and AGENTS.md sections (no description).
 */

const STOP = new Set(
  (
    "an on in of to or by at as is it be do if so up no id vs eg ie " +
    "the and for with from that this when what where which into onto use uses using used not but are was were has have had you your its " +
    "can will should must how why any all one two via per about over under than then them they their there here also only just more most " +
    "other such each every some new any etc e.g i.e like including include includes covers cover covering user user's users agent agents " +
    "skill skills work working works make makes get gets set sets run runs running file files dir directory directories config configs " +
    "configuration editing edit edits create creating add adding update updating write writing read reading show showing whether between"
  ).split(/\s+/),
);

/** Content words of a text, lightly stemmed so plural/verb forms match. */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    const t = stem(raw);
    if (t.length >= 2 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3); // rendering → render
  if (w.length > 4 && w.endsWith("ied")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2); // linked → link
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`; // directories → directory
  if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2); // boxes → box
  if (w.length >= 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1); // images → image, prs → pr
  return w;
}

/**
 * How many new words a rephrased description may add before it counts as a new subject.
 * A couple of generic words ("post", "tool") are normal rewording; a subject brings several.
 */
export const MAX_NEW_TERMS = 2;

export interface ScopeCheck {
  /** Words the new description adds that appear nowhere in the skill as it was. */
  added: string[];
  /** More than MAX_NEW_TERMS new words: the description took on a new subject. */
  widened: boolean;
  oldDescription?: string;
  newDescription?: string;
}

/**
 * Compare the skill's description before and after the draft. Only applies to an `update` of a
 * live skill folder; returns undefined when the check doesn't apply.
 */
export function checkScope(files: DraftFile[], base: Map<string, string>, target: RenderTarget, kind: ProposalKind, live: boolean): ScopeCheck | undefined {
  if (kind !== "update" || !live || !target.skillDir) return undefined;
  const path = `${target.skillDir}/SKILL.md`;
  const before = base.get(path);
  const after = files.find((f) => f.path === path)?.content;
  if (before === undefined || after === undefined || after === null) return undefined;
  const oldDesc = parseFrontmatter(before).description ?? "";
  const newDesc = parseFrontmatter(after).description ?? "";
  if (newDesc === oldDesc) return { added: [], widened: false, oldDescription: oldDesc, newDescription: newDesc };
  // Everything the skill said before: the old SKILL.md (incl. its description) and its references.
  const known = new Set<string>();
  for (const [p, text] of base) if (p.startsWith(`${target.skillDir}/`)) for (const t of terms(text)) known.add(t);
  const added = [...terms(newDesc)].filter((t) => !known.has(t)).sort();
  return { added, widened: added.length > MAX_NEW_TERMS, oldDescription: oldDesc, newDescription: newDesc };
}

/** One readable line for a scope violation. */
export function scopeProblem(c: ScopeCheck): string {
  return `the description widens the skill's scope (new: ${c.added.join(", ")}). An update keeps a live skill's subject; put knowledge on a new subject in a separate skill`;
}

/** Instructions for the drafter's one retry. */
export function scopeRetryPrompt(c: ScopeCheck): string {
  return [
    "Verification: your new description widens this live skill's scope. It adds words the skill never covered before:",
    `  ${c.added.join(", ")}`,
    `Old description: ${c.oldDescription}`,
    `Your description: ${c.newDescription}`,
    "",
    "An update must keep the skill's subject. Fix the draft now:",
    "- Restore the description's scope (you may rephrase it using what the skill already covers).",
    "- If those words come from knowledge that isn't this skill's subject, remove that content from the files and list the items in report_draft's `excluded` with a reason; they will be filed in another skill.",
    "- If the knowledge does belong here, keep it in the body or a reference, but describe the skill in its existing terms.",
    "Then call report_draft again.",
  ].join("\n");
}

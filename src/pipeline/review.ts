import { Rejections } from "../state/rejections.ts";
import { Feedback, type FeedbackWithProposal } from "../state/feedback.ts";
import type { NodeRow, Tree } from "../state/tree.ts";
import { truncate } from "../util/text.ts";

/**
 * What drafting sees of my earlier reviews: the feedback on this skill (all its
 * proposals, newest first) and the reasons I rejected nearby skills. Size-capped.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);

function renderOne(f: FeedbackWithProposal): string {
  const head = `- ${day(f.createdAt)}, proposal #${f.proposalId} (${f.proposalKind}, ${f.proposalStatus})`;
  switch (f.kind) {
    case "reject":
      return `${head}: REJECTED${f.text ? `: "${truncate(f.text, 600)}"` : " (no reason given)"}`;
    case "revise":
      return `${head}: asked for a revision: "${truncate(f.text, 800)}"`;
    case "chat": {
      const mine = (f.turns ?? []).filter((t) => t.role === "user").slice(-8);
      return [`${head}: said in a revise chat:`, ...mine.map((t) => `    > ${truncate(t.text.replace(/\s+/g, " "), 500)}`)].join("\n");
    }
    case "edit":
      return [`${head}: ${f.text}. Their change to the AI draft:`, ...truncate(f.diff ?? "", 1500).split("\n").map((l) => `    ${l}`)].join("\n");
  }
}

export function reviewFeedbackPrompt(tree: Tree, skill: Pick<NodeRow, "id" | "parentId">, opts: { maxChars?: number } = {}): string {
  const max = opts.maxChars ?? 5000;
  const fb = new Feedback(tree.db);
  const own = fb.forNode(skill.id).reverse();
  // Classified rejection memories (kind + rule) of this skill and its siblings, newest per skill.
  const memories = new Rejections(tree.db).byNode();
  const ownRule = memories.get(skill.id);
  const nearby: string[] = [];
  if (skill.parentId !== undefined) {
    for (const s of tree.children(skill.parentId)) {
      if (s.id === skill.id) continue;
      const m = memories.get(s.id);
      const rejections = fb.forNode(s.id).filter((f) => f.kind === "reject");
      const last = rejections.at(-1);
      if (m?.rule) nearby.push(`- ${s.name ?? s.title}: rejected ${day(m.createdAt)} as ${m.kind}: ${m.rule}`);
      else if (last) nearby.push(`- ${s.name ?? s.title}: rejected ${day(last.createdAt)}${last.text ? `: "${truncate(last.text, 300)}"` : " (no reason given)"}`);
    }
  }
  if (!own.length && !nearby.length && !ownRule?.rule) return "";

  const lines: string[] = [];
  let used = 0;
  // Items stop early enough that the closing tags always fit.
  const push = (s: string, closing = false) => {
    if (!closing && used + s.length > max - 60) return false;
    lines.push(s);
    used += s.length;
    return true;
  };
  if (ownRule?.rule) {
    push(`<rejection_rule> This skill was rejected before (${ownRule.kind}): ${ownRule.rule}. Follow this rule. </rejection_rule>`);
  }
  if (own.length) {
    push(
      "<review_feedback> The engineer reviewed earlier drafts of this skill (newest first). These are their decisions: follow them, and don't bring back what they removed or rejected. If newer evidence clearly contradicts one, follow the evidence and say so in your summary.",
    );
    for (const f of own) if (!push(renderOne(f))) break;
    push("</review_feedback>", true);
  }
  if (nearby.length) {
    push("<rejected_nearby> Proposals the engineer rejected for other skills in this scope. Don't propose the same thing here:");
    for (const n of nearby.slice(-6)) if (!push(n)) break;
    push("</rejected_nearby>", true);
  }
  return lines.join("\n");
}

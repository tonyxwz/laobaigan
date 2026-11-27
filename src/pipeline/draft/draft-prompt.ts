import { Type } from "typebox";
import type { NuggetRow } from "../../state/db.ts";
import {
  type ProposalKind,
  subtreeNuggets,
  type TreeNode,
} from "../../state/tree.ts";
import { truncate } from "../../util/text.ts";
import { homeOfTarget } from "../common/homes.ts";
import type { RenderTarget } from "../common/target.ts";

export const DRAFT_SYSTEM_PROMPT = `You write and maintain agent skills from knowledge an engineer taught their AI coding agents (pi, Claude Code, opencode).

A skill is a folder: SKILL.md plus optional references/*.md. Agents always see only the frontmatter name and description; they read SKILL.md when the description matches the task, and a reference file only when SKILL.md tells them to.

SKILL.md format:
---
name: <exactly the folder name>
description: <one or two sentences, max 1024 chars: what it covers AND when to use it, naming the concrete triggers (tools, files, commands, situations)>
---
# <Title>
<the shared workflow and the rules that apply everywhere>
## <Section>  ... or "See references/<x>.md for <when>."

House rules:
- Write for an agent that has never seen these sessions. Exact commands, paths, names, flags and the reason behind each rule. No "as discussed", no anecdotes, no session-specific trivia (today's branch, one-off task details).
- Keep SKILL.md short. Put a subtopic that only matters in some tasks into references/<subtopic>.md and say in SKILL.md when to read it.
- Corrections become rules: "Do X, not Y (because ...)".
- Knowledge items are dated. When two of them conflict, the newer one wins; drop the older claim instead of keeping both.
- Never include secrets, tokens, account credentials, or anything shown as [REDACTED].
- Only write the paths you were given. The working directory holds copies of them; change those, with relative paths.
- For a repository target you may read anything in the repository itself (its absolute path is given; it is read-only): the source, the README, the docs, other skills. Do read what the knowledge is about before writing, check claims against the code, match the project's conventions, and leave out what its files already say.
- For a repository target the task names a primary target, and you may also change the repository's other agent files and documents listed as writable. Put the knowledge in the primary target. Change another file only when a piece of the knowledge clearly belongs there instead, or when it should point to what you wrote; change as little as needed, and say in the summary what you touched and why.
- A repository document (docs/<x>.md) or README is read by people too: keep its structure and voice, and put each piece of knowledge in the section it belongs to.
- Never change text between <!-- BEGIN ... --> and <!-- END ... --> markers: another tool generates it.
- Stay on the skill's topic (its title and, for an existing skill, its current description). Some knowledge items may only be adjacent: they mention a related tool or word but are about something else. Don't write those in; list them in report_draft's \`excluded\` with a one-line reason, and they will be filed in a better skill. Don't widen the description to cover them.
- When done, call report_draft once.`;

function renderNuggets(
  ns: NuggetRow[],
  flags: (n: NuggetRow) => string,
): string[] {
  return ns.map((n) =>
    [
      `- #${n.id} [${n.kind}]${flags(n)} ${n.title}`,
      ...n.knowledge.split("\n").map((l) => `    ${l}`),
      ...n.evidence
        .slice(0, 2)
        .map(
          (e) =>
            `    evidence (${n.agent}${e.ts ? ` ${e.ts.slice(0, 10)}` : ""}): "${truncate(e.quote, 200)}"`,
        ),
    ].join("\n"),
  );
}

export function buildDraftPrompt(
  skill: TreeNode,
  kind: ProposalKind,
  target: RenderTarget,
  siblings: TreeNode[],
  opts: {
    /** Revising: when the current draft was made. */
    draftedAt?: Date | undefined;
    /** What reviews of earlier drafts said (see reviewFeedbackPrompt). */
    review?: string | undefined;
    /** False leaves out the closing "write the files" instruction, for prompts that continue. */
    closing?: boolean;
  } = {},
): string {
  const { draftedAt, review } = opts;
  const since = skill.renderedAt?.getTime() ?? 0;
  const base = (n: NuggetRow) =>
    kind === "new"
      ? ""
      : n.coveredNodeId !== undefined
        ? " (ALREADY IN THE FILE)"
        : (n.attachedAt?.getTime() ?? Infinity) > since
          ? " (NEW)"
          : " (already absorbed)";
  // Revising: evidence that arrived after the current draft was made isn't in it yet.
  const flag = (n: NuggetRow) =>
    `${base(n)}${draftedAt && (n.attachedAt?.getTime() ?? 0) > draftedAt.getTime() ? " (NEW SINCE THE DRAFT)" : ""}`;
  const lines: string[] = [];

  lines.push(homeOfTarget(target, kind).task(target, kind));
  if (kind === "update")
    lines.push(
      "Integrate the knowledge marked (NEW). Items marked (already absorbed) are background.",
    );
  if (
    draftedAt &&
    subtreeNuggets(skill).some(
      (n) => (n.attachedAt?.getTime() ?? 0) > draftedAt.getTime(),
    )
  ) {
    lines.push(
      "Items marked (NEW SINCE THE DRAFT) came in after the current draft was written: add them unless the engineer says otherwise.",
    );
  }
  const anyCovered = subtreeNuggets(skill).some(
    (n) => n.coveredNodeId !== undefined,
  );
  if (!target.skillDir) {
    // No description to fix: AGENTS.md is always loaded, and a document gets a pointer instead.
    if (anyCovered && !target.pointer)
      lines.push(
        "Items marked (ALREADY IN THE FILE) are stated there already: don't repeat them.",
      );
  } else if (kind === "fix-description" || anyCovered) {
    lines.push(
      "Items marked (ALREADY IN THE FILE) were explained again even though the skill says them: agents did not load the skill. Rewrite the description so it triggers in those situations (name the tools, files and tasks involved).",
    );
  }
  const also = target.writable.filter((w) => !target.primary.includes(w));
  lines.push(
    "",
    ...(target.readRoot
      ? [
          `Repository (read-only, read anything in it): ${target.readRoot}`,
          `Primary target (in the working directory): ${target.primary.join(", ")}`,
          ...(also.length
            ? [
                `You may also change (in the working directory): ${also.join(", ")}`,
              ]
            : []),
        ]
      : [
          `Writable paths (everything else is read-only): ${target.writable.join(", ")}`,
        ]),
    "",
  );

  lines.push(
    "<knowledge>",
    `skill: ${skill.title}${skill.description ? ` — ${skill.description}` : ""}`,
  );
  if (skill.nuggets.length)
    lines.push("general:", ...renderNuggets(skill.nuggets, flag));
  for (const c of skill.children) {
    const ns = subtreeNuggets(c);
    if (!ns.length) continue;
    lines.push(
      `section "${c.title}"${c.description ? ` — ${c.description}` : ""}:`,
      ...renderNuggets(ns, flag),
    );
  }
  lines.push("</knowledge>", "");

  const others = siblings.filter(
    (s) => s.id !== skill.id && s.origin === "file",
  );
  if (others.length) {
    lines.push(
      "<other_skills> (do not duplicate; reference them by name if relevant)",
    );
    for (const s of others)
      lines.push(
        `- ${s.name ?? s.title}: ${truncate(s.description ?? "", 200)}`,
      );
    lines.push("</other_skills>", "");
  }
  if (review) lines.push(review, "");
  if (opts.closing !== false)
    lines.push("Write the files now, then call report_draft.");
  return lines.join("\n");
}

export const ReportDraftSchema = Type.Object({
  summary: Type.String({
    description:
      "2-4 sentences for the reviewer: what you wrote or changed and why.",
  }),
  excluded: Type.Optional(
    Type.Array(
      Type.Object({
        nuggetId: Type.Integer({
          description: "The #id of a knowledge item you left out.",
        }),
        reason: Type.String({
          description:
            "One line: why it isn't this skill's topic (and where it belongs, if obvious).",
        }),
      }),
      {
        description:
          "Knowledge items that are off this skill's topic and were NOT written in. Leave empty when everything fits.",
      },
    ),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "The skill's final frontmatter description, if it is a skill.",
    }),
  ),
});

import { Type, type Static } from "typebox";
import type { PiRunner, ThinkingLevel, Usage } from "../pi/run-pi.ts";
import { addUsage, ZERO_USAGE } from "../pi/run-pi.ts";
import type { Transcript } from "../sources/types.ts";
import type { Excerpt } from "./prefilter.ts";

export const NuggetSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("procedure"),
    Type.Literal("fact"),
    Type.Literal("preference"),
    Type.Literal("correction"),
    Type.Literal("location"),
  ]),
  title: Type.String({ description: "One line, canonical phrasing of the knowledge." }),
  knowledge: Type.String({
    description:
      "The knowledge itself, self-contained, in markdown: exact commands, paths, names, rules, and the why. Written so an agent with no access to this session can act on it.",
  }),
  triggers: Type.Array(Type.String(), {
    description: "Situations in which an agent would need this, e.g. 'building a Gradle project'.",
  }),
  scope: Type.Union([Type.Literal("global"), Type.Literal("repo")], {
    description: "'repo' if it only matters inside one repository/package; 'global' if it helps across repos.",
  }),
  repo: Type.Optional(
    Type.String({ description: "Absolute path of the repository when scope is 'repo'. Omit if unknown." }),
  ),
  evidence: Type.Array(
    Type.Object({
      label: Type.String({ description: "A USER turn label from the transcript, e.g. 'U3'. Never 'C'." }),
      quote: Type.String({ description: "Short verbatim quote (≤ 200 chars) from that turn." }),
    }),
    { minItems: 1 },
  ),
  coveredBySkill: Type.Optional(
    Type.String({ description: "Name of an existing skill (or AGENTS.md) that already contains this knowledge." }),
  ),
  confidence: Type.Number({ minimum: 0, maximum: 1, description: "How sure you are this is reusable knowledge." }),
});

export const ReportSchema = Type.Object({
  nuggets: Type.Array(NuggetSchema),
});

export type ExtractedNugget = Static<typeof NuggetSchema>;

export const EXTRACT_SYSTEM_PROMPT = `You analyze transcripts of a software engineer ("the user") working with AI coding agents.

Your job: find knowledge that THE USER supplied to the agent, which the agent did not know or got wrong, and which would help a future agent in a new session. These are things the user would otherwise have to explain again.

Report ONLY by calling the \`report_knowledge\` tool exactly once. Report an empty list if there is nothing worth keeping; that is a common and fine outcome.

What counts:
- procedures: how to build/test/deploy/run something, the right command or tool, required flags, order of steps
- facts: where things live (paths, accounts, hosts, log locations, URLs), what systems are called, how they relate
- preferences/conventions: naming, style, directory layout, tooling choices the user insists on
- corrections: the agent did X, the user said "no, do Y" — the rule is "do Y (not X)", with the reason if given

What does NOT count:
- the task request itself ("add a button", "fix this bug") or one-off decisions about this specific change
- knowledge the agent discovered on its own from files or tool output without the user's input
- generic programming knowledge any competent agent already has
- transient state (what's currently broken, today's branch name), secrets, or anything marked [REDACTED]
- questions the user asked (unless the user's question itself states a fact)

Rules:
- Only cite USER turns labelled U<n>. Turns labelled [C ...] are earlier context: use them for understanding, never cite them, and do not report knowledge that appears only in them.
- "rewound" marks a prompt the user retracted and rephrased; the rephrased version is usually the correction.
- Merge related points from the same session into one nugget about one coherent topic, rather than many tiny ones.
- Write \`knowledge\` so it stands alone: include the exact commands/paths/names from the transcript, not "as discussed".
- scope: ask "would this help in a different repository?" If no, use "repo" and set \`repo\` to the repository root path when you can tell it (from the session working directory or paths in the transcript).
- If the knowledge is already covered by a listed existing skill or AGENTS.md section, still report it but set \`coveredBySkill\` — the user having to repeat it means that skill isn't being triggered.
- confidence: 0.9+ the user explicitly taught/corrected; ~0.6 implied by the user's instructions; below 0.5 don't report.`;

export interface ExtractInput {
  transcript: Transcript;
  repoRoot?: string;
  skillIndex: string;
  excerpt: Excerpt;
}

export interface ExtractOutput {
  nuggets: ExtractedNugget[];
  /** Nuggets dropped because their evidence didn't reference a valid U-label. */
  dropped: number;
  usage: Usage;
  calls: number;
}

export function buildExtractPrompt(input: ExtractInput, chunk: string, part: { index: number; total: number }): string {
  const t = input.transcript;
  return [
    `Session: ${t.agent}:${t.sessionId}${t.title ? ` — "${t.title}"` : ""}`,
    `Working directory: ${t.cwd || "(unknown)"}`,
    `Repository root: ${input.repoRoot ?? "(not a git repo / unknown)"}`,
    `Dates: ${t.startedAt.toISOString().slice(0, 10)} → ${t.updatedAt.toISOString().slice(0, 10)}`,
    part.total > 1 ? `This is part ${part.index + 1} of ${part.total} of the session.` : "",
    "",
    "<existing_knowledge>",
    input.skillIndex,
    "</existing_knowledge>",
    "",
    "<transcript>",
    chunk,
    "</transcript>",
    "",
    "Call report_knowledge now.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export async function extractNuggets(
  runner: PiRunner,
  input: ExtractInput,
  model: { id: string; thinking: ThinkingLevel },
): Promise<ExtractOutput> {
  let usage = ZERO_USAGE;
  const nuggets: ExtractedNugget[] = [];
  let dropped = 0;
  const { chunks, labels } = input.excerpt;
  for (let i = 0; i < chunks.length; i++) {
    const res = await runner.run({
      model: model.id,
      thinking: model.thinking,
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      prompt: buildExtractPrompt(input, chunks[i]!, { index: i, total: chunks.length }),
      resultTool: {
        name: "report_knowledge",
        description: "Report the reusable knowledge the user taught the agent in this transcript (possibly none).",
        parameters: ReportSchema,
      },
    });
    usage = addUsage(usage, res.usage);
    for (const n of res.value.nuggets) {
      const byLabel = new Map<string, string>();
      for (const e of n.evidence) {
        const label = e.label.trim();
        if (labels.has(label) && !byLabel.has(label)) byLabel.set(label, e.quote.slice(0, 300));
      }
      if (byLabel.size === 0 || n.confidence < 0.5) {
        dropped++;
        continue;
      }
      nuggets.push({ ...n, evidence: [...byLabel].map(([label, quote]) => ({ label, quote })) });
    }
  }
  return { nuggets, dropped, usage, calls: chunks.length };
}

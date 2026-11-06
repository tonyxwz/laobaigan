import { Type, type Static } from "typebox";
import type { Config } from "../config.ts";
import type { PiRunner, Usage } from "../pi/run-pi.ts";
import { addUsage, ZERO_USAGE } from "../pi/run-pi.ts";
import { REJECTION_KINDS, Rejections, type MemoryRow, type RejectionKind } from "../state/rejections.ts";
import type { Tree } from "../state/tree.ts";
import { truncate } from "../util/text.ts";

/**
 * The `rejections` stage of lbg run: classify each pending rejection memory
 * (one call each, extract model) into a kind and a one-line rule, so later
 * stages can act on it. Memories I locked are never touched.
 */

export const ClassifySchema = Type.Object({
  kind: Type.Union(REJECTION_KINDS.map((k) => Type.Literal(k))),
  rule: Type.String({ description: "One line, imperative: what lbg should do differently next time." }),
  targetSkillId: Type.Optional(Type.Integer({ description: "wrong-place only: the id of the listed skill this knowledge belongs in." })),
});
export type Classification = Static<typeof ClassifySchema>;

export const CLASSIFY_SYSTEM_PROMPT = `An engineer rejected a proposed skill update that was generated from things they had explained to their AI coding agents. Classify the rejection so the generator stops making the same kind of proposal.

Kinds:
- outdated: the knowledge is no longer true (tool changed, old workflow). New, corrected knowledge about the same topic is welcome.
- not-useful: the topic isn't worth a skill at all (trivial, one-off, obvious to any agent).
- wrong-place: the knowledge is fine but belongs in another skill (pick it from the list), or must stay separate.
- later: not now, or no reason that says anything about the content.

The rule is one line, written as an instruction to the generator, specific to this topic, e.g. "Don't propose a skill about tmux key bindings; they're personal and trivial." or "File vault login steps under cloud-credentials, not under dotfiles."
Report ONLY by calling classify_rejection once.`;

export function buildClassifyPrompt(m: MemoryRow, skills: { id: number; name?: string; title: string; description?: string }[]): string {
  const t = m.topic;
  const lines = [
    `Rejected proposal: ${t.proposalKind === "new" ? "a new skill" : t.proposalKind === "update" ? "an update to an existing skill" : "a description fix"}`,
    `Skill: ${t.name ? `${t.name} — ` : ""}${t.title}${t.description ? `\nDescription: ${truncate(t.description, 300)}` : ""}`,
    `Scope: ${m.scope === "global" ? "global (all repositories)" : `repository ${m.repo ?? "?"}`}`,
    "",
    "Reason given by the engineer:",
    m.reason || "(none)",
    "",
    "Evidence it was built from:",
    ...(t.evidence.length ? t.evidence.map((e) => `- ${e.title}`) : ["- (none recorded)"]),
    "",
    "Other skills in this scope (for wrong-place):",
    ...(skills.length ? skills.map((s) => `- id ${s.id}: ${s.name ?? s.title}${s.description ? ` — ${truncate(s.description, 160)}` : ""}`) : ["- (none)"]),
    "",
    "Call classify_rejection now.",
  ];
  return lines.join("\n");
}

export interface ClassifyResult {
  classified: { id: number; kind: RejectionKind; rule: string; targetNodeId?: number; target?: string }[];
  failed: { id: number; error: string }[];
  /** Pending memories left for a later run (budget or repeated errors). */
  deferred: number;
  calls: number;
  usage: Usage;
}

export async function classifyRejections(
  tree: Tree,
  runner: PiRunner,
  cfg: Config,
  opts: { maxCalls?: number; log?: (m: string) => void } = {},
): Promise<ClassifyResult> {
  const log = opts.log ?? (() => {});
  const max = opts.maxCalls ?? cfg.rejections.maxCallsPerRun;
  const mem = new Rejections(tree.db);
  const res: ClassifyResult = { classified: [], failed: [], deferred: 0, calls: 0, usage: ZERO_USAGE };
  const pending = mem.pending().filter((m) => !m.locked);
  let consecutive = 0;
  for (const [i, m] of pending.entries()) {
    if (res.calls >= max || consecutive >= 2) {
      res.deferred = pending.length - i;
      log(`rejections: ${res.deferred} left for the next run (${consecutive >= 2 ? "model errors" : "budget"})`);
      break;
    }
    const root = tree.trees({ scope: m.scope, ...(m.repo ? { repo: m.repo } : {}) })[0];
    const skills = (root?.children ?? [])
      .filter((s) => s.id !== m.nodeId)
      .map((s) => ({ id: s.id, ...(s.name ? { name: s.name } : {}), title: s.title, ...(s.description ? { description: s.description } : {}) }));
    try {
      res.calls++;
      const r = await runner.run({
        model: cfg.models.extract,
        thinking: cfg.models.extractThinking,
        systemPrompt: CLASSIFY_SYSTEM_PROMPT,
        prompt: buildClassifyPrompt(m, skills),
        resultTool: { name: "classify_rejection", description: "Classify this rejection.", parameters: ClassifySchema },
      });
      res.usage = addUsage(res.usage, r.usage);
      consecutive = 0;
      const c = r.value;
      const target = c.kind === "wrong-place" && c.targetSkillId !== undefined ? skills.find((s) => s.id === c.targetSkillId) : undefined;
      if (c.kind === "wrong-place" && c.targetSkillId !== undefined && !target) log(`rejections: #${m.id}: skill ${c.targetSkillId} isn't in this scope; no target`);
      if (mem.classify(m.id, { kind: c.kind, rule: c.rule, ...(target ? { targetNodeId: target.id } : {}) })) {
        const row = mem.mustGet(m.id);
        res.classified.push({ id: m.id, kind: c.kind, rule: row.rule ?? c.rule, ...(target ? { targetNodeId: target.id, target: target.name ?? target.title } : {}) });
        log(`rejections: #${m.id} → ${c.kind}: ${row.rule}`);
      }
    } catch (e) {
      consecutive++;
      const error = e instanceof Error ? e.message : String(e);
      mem.failed(m.id, error);
      res.failed.push({ id: m.id, error });
      log(`rejections: #${m.id}: ${error}`);
    }
  }
  return res;
}

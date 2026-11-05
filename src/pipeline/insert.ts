import { Type, type Static, type TSchema } from "typebox";
import type { Config } from "../config.ts";
import type { PiRequest, PiRunner, Usage } from "../pi/run-pi.ts";
import { addUsage, ZERO_USAGE } from "../pi/run-pi.ts";
import type { NuggetRow } from "../state/db.ts";
import { subtreeNuggets, Tree, type Scope, type TreeNode } from "../state/tree.ts";
import { truncate } from "../util/text.ts";
import { skillName } from "./stats.ts";

/**
 * Insert: route new nuggets top-down through the knowledge tree, one batched
 * model call per level.
 *
 *   level 1 (per scope root):  nugget → existing skill | new skill
 *   level 2 (per touched skill, when it has sections or is growing them):
 *                              nugget → section | new section | skill body
 *
 * Calls are skipped when there is nothing to decide. Summaries are only marked
 * stale (lazy); the stable part of each prompt comes first so the provider can cache it.
 */

// ---- level 1 ------------------------------------------------------------------

export const SkillRouteSchema = Type.Object({
  newSkills: Type.Array(
    Type.Object({
      key: Type.String({ description: "Short local id you invent, e.g. 's1'." }),
      title: Type.String({ description: "Skill title, e.g. 'Dotfiles management'." }),
      name: Type.Optional(Type.String({ description: "Skill name: lowercase letters, digits, single hyphens." })),
      description: Type.String({ description: "One sentence: what it covers and WHEN an agent should use it." }),
    }),
  ),
  placements: Type.Array(
    Type.Object({
      nuggetId: Type.Integer(),
      skillId: Type.Optional(Type.Integer({ description: "An EXISTING skill id." })),
      newSkillKey: Type.Optional(Type.String({ description: "A key from newSkills." })),
    }),
    { description: "Exactly one entry per new nugget, with exactly one of skillId / newSkillKey." },
  ),
});
export type SkillRoute = Static<typeof SkillRouteSchema>;

const SKILL_SYSTEM_PROMPT = `You file knowledge an engineer taught their AI coding agents into SKILLS.

A skill is one coherent topic with one description that tells agents when to use it. Details live in its sections, so a skill can be an umbrella (e.g. "Dotfiles management" covering zsh, tmux, and agent configs). The engineer wants FEW skills.

Skills are marked:
- live: an existing skill file the agents already use. Prefer these when the nugget is about the same tool, system, or workflow.
- declared: a skill the engineer asked for; its description says what belongs there. Prefer it whenever a nugget falls within that description.
- latent: a skill being grown from earlier evidence, not published yet.

Rules:
- Put each new nugget into the existing skill whose subject it is ABOUT (not one that merely mentions a related word).
- Create a new skill only when no existing skill is a natural home. One new skill may take several of the new nuggets.
- Place every nugget exactly once. Report ONLY by calling \`route_to_skills\` once.`;

// ---- level 2 ------------------------------------------------------------------

export const SectionRouteSchema = Type.Object({
  newSections: Type.Array(
    Type.Object({
      key: Type.String({ description: "Short local id you invent, e.g. 'n1'." }),
      title: Type.String({ description: "Section title, e.g. 'tmux'." }),
      description: Type.String({ description: "One sentence: what this section covers." }),
    }),
  ),
  placements: Type.Array(
    Type.Object({
      nuggetId: Type.Integer(),
      sectionId: Type.Optional(Type.Integer({ description: "An EXISTING section id." })),
      newSectionKey: Type.Optional(Type.String({ description: "A key from newSections." })),
      body: Type.Optional(Type.Boolean({ description: "True: belongs in the skill's main text, not a section." })),
      alreadyCovered: Type.Optional(
        Type.Boolean({ description: "True if the target section/skill text ALREADY states this knowledge." }),
      ),
    }),
    { description: "Exactly one entry per nugget, with exactly one of sectionId / newSectionKey / body." },
  ),
});
export type SectionRoute = Static<typeof SectionRouteSchema>;

const SECTION_SYSTEM_PROMPT = `You file knowledge an engineer taught their AI coding agents into the SECTIONS of one skill.

Each section becomes a part of the skill (or a reference file that agents read only when needed), so a section should be one subtopic: one tool, file, or workflow step.

Rules:
- Put a nugget in the existing section it is about. Create a new section when it is a distinct subtopic no section covers; one new section may take several nuggets.
- Use "body" only for knowledge that applies to the whole skill (the shared workflow).
- Set alreadyCovered when the existing text shown for the target section (or the skill body) already says the same thing. The engineer still had to explain it, which means the skill was not used; that matters.
- Place every nugget exactly once. Report ONLY by calling \`route_to_sections\` once.`;

// ---- rendering ----------------------------------------------------------------

function renderNugget(n: NuggetRow): string {
  return [
    `<nugget id="${n.id}" kind="${n.kind}">`,
    `title: ${n.title}`,
    ...(n.triggers.length ? [`triggers: ${n.triggers.join("; ")}`] : []),
    truncate(n.knowledge, 800),
    "</nugget>",
  ].join("\n");
}

const originLabel = (s: TreeNode) => (s.origin === "file" ? "live" : s.origin);

/** Stable first (skill list), new nuggets last, so the prefix can be cached. */
export function buildSkillPrompt(root: TreeNode, nuggets: NuggetRow[]): string {
  const lines = [`Scope: ${root.scope === "global" ? "global (applies across repositories)" : `repository ${root.repo}`}`, "", "<skills>"];
  for (const s of root.children) {
    lines.push(
      `<skill id="${s.id}" kind="${originLabel(s)}"${s.name ? ` name="${s.name}"` : ""}>`,
      `title: ${s.title}`,
      ...(s.description ? [`description: ${truncate(s.description, 300)}`] : []),
      ...(s.children.length ? [`sections: ${s.children.map((c) => c.title).join(" | ")}`] : []),
      "</skill>",
    );
  }
  if (!root.children.length) lines.push("(none yet)");
  lines.push("</skills>", "", "<new_nuggets>", ...nuggets.map(renderNugget), "</new_nuggets>", "", "Call route_to_skills now.");
  return lines.join("\n");
}

export function buildSectionPrompt(skill: TreeNode, nuggets: NuggetRow[]): string {
  const lines = [
    `<skill id="${skill.id}" kind="${originLabel(skill)}"${skill.name ? ` name="${skill.name}"` : ""}>`,
    `title: ${skill.title}`,
    ...(skill.description ? [`description: ${truncate(skill.description, 300)}`] : []),
    ...(skill.summary ? [`body: ${truncate(skill.summary, 1500)}`] : []),
    "</skill>",
    "",
    "<sections>",
  ];
  for (const c of skill.children) {
    lines.push(`<section id="${c.id}">`, `title: ${c.title}`, ...(c.summary ? [truncate(c.summary, 1200)] : c.description ? [c.description] : []), "</section>");
  }
  if (!skill.children.length) lines.push("(none yet)");
  lines.push("</sections>", "", "<new_nuggets>", ...nuggets.map(renderNugget), "</new_nuggets>", "", "Call route_to_sections now.");
  return lines.join("\n");
}

// ---- validation -----------------------------------------------------------------

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface SkillPlan {
  newSkills: { key: string; title: string; name: string; description: string; nuggetIds: number[] }[];
  placements: { nuggetId: number; skillId: number }[];
  repairs: string[];
}

export function validateSkillRoute(res: SkillRoute, root: TreeNode, nuggets: NuggetRow[]): SkillPlan {
  const repairs: string[] = [];
  const ids = new Set(nuggets.map((n) => n.id));
  const skills = new Set(root.children.map((c) => c.id));
  const taken = new Set(root.children.map((c) => c.name).filter(Boolean));
  const byKey = new Map<string, SkillPlan["newSkills"][number]>();
  for (const s of res.newSkills) {
    if (byKey.has(s.key)) {
      repairs.push(`duplicate new skill key ${s.key}`);
      continue;
    }
    let name = s.name && SKILL_NAME.test(s.name) && s.name.length <= 64 ? s.name : skillName(s.title);
    if (taken.has(name)) name = `${name}-${byKey.size + 2}`;
    taken.add(name);
    byKey.set(s.key, { key: s.key, title: s.title, name, description: s.description, nuggetIds: [] });
  }
  const placed = new Set<number>();
  const placements: SkillPlan["placements"] = [];
  for (const p of res.placements) {
    if (!ids.has(p.nuggetId)) {
      repairs.push(`unknown nugget ${p.nuggetId}`);
      continue;
    }
    if (placed.has(p.nuggetId)) {
      repairs.push(`nugget ${p.nuggetId} placed twice; kept first`);
      continue;
    }
    if (p.skillId !== undefined && skills.has(p.skillId)) placements.push({ nuggetId: p.nuggetId, skillId: p.skillId });
    else if (p.newSkillKey !== undefined && byKey.has(p.newSkillKey)) byKey.get(p.newSkillKey)!.nuggetIds.push(p.nuggetId);
    else {
      repairs.push(`nugget ${p.nuggetId}: invalid target ${p.skillId ?? p.newSkillKey}`);
      continue;
    }
    placed.add(p.nuggetId);
  }
  for (const n of nuggets) {
    if (placed.has(n.id)) continue;
    repairs.push(`nugget ${n.id} unplaced; new skill`);
    let name = skillName(n.title);
    if (taken.has(name)) name = `${name}-${n.id}`;
    taken.add(name);
    byKey.set(`auto-${n.id}`, { key: `auto-${n.id}`, title: n.title, name, description: n.triggers[0] ?? n.title, nuggetIds: [n.id] });
  }
  return { newSkills: [...byKey.values()].filter((s) => s.nuggetIds.length), placements, repairs };
}

export interface SectionPlan {
  newSections: { key: string; title: string; description: string; nuggetIds: number[] }[];
  /** sectionId undefined = skill body. */
  placements: { nuggetId: number; sectionId?: number; covered: boolean }[];
  repairs: string[];
}

export function validateSectionRoute(res: SectionRoute, skill: TreeNode, nuggets: NuggetRow[]): SectionPlan {
  const repairs: string[] = [];
  const ids = new Set(nuggets.map((n) => n.id));
  const sections = new Set(skill.children.map((c) => c.id));
  const byKey = new Map<string, SectionPlan["newSections"][number]>();
  for (const s of res.newSections) {
    if (byKey.has(s.key)) repairs.push(`duplicate new section key ${s.key}`);
    else byKey.set(s.key, { key: s.key, title: s.title, description: s.description, nuggetIds: [] });
  }
  const placed = new Set<number>();
  const placements: SectionPlan["placements"] = [];
  for (const p of res.placements) {
    if (!ids.has(p.nuggetId) || placed.has(p.nuggetId)) {
      repairs.push(`nugget ${p.nuggetId}: unknown or placed twice`);
      continue;
    }
    if (p.sectionId !== undefined && sections.has(p.sectionId)) {
      placements.push({ nuggetId: p.nuggetId, sectionId: p.sectionId, covered: p.alreadyCovered === true });
    } else if (p.newSectionKey !== undefined && byKey.has(p.newSectionKey)) {
      byKey.get(p.newSectionKey)!.nuggetIds.push(p.nuggetId);
    } else {
      // body (explicit, or as the safe fallback for an invalid target)
      if (!p.body) repairs.push(`nugget ${p.nuggetId}: invalid section ${p.sectionId ?? p.newSectionKey}; skill body`);
      placements.push({ nuggetId: p.nuggetId, covered: p.body === true && p.alreadyCovered === true });
    }
    placed.add(p.nuggetId);
  }
  for (const n of nuggets) {
    if (placed.has(n.id)) continue;
    repairs.push(`nugget ${n.id} unplaced; skill body`);
    placements.push({ nuggetId: n.id, covered: false });
  }
  return { newSections: [...byKey.values()].filter((s) => s.nuggetIds.length), placements, repairs };
}

// ---- driver ---------------------------------------------------------------------

export interface InsertResult {
  placed: number;
  skillsCreated: string[];
  sectionsCreated: string[];
  covered: number;
  repairs: string[];
  calls: number;
  usage: Usage;
  /** Nuggets left for the next run (call budget). */
  deferred: number;
}

/** Level 2 is worth a call when the skill has sections, or is a non-file skill growing several new nuggets. */
function wantsSections(skill: TreeNode, incoming: number): boolean {
  return skill.children.length > 0 || (skill.origin !== "file" && incoming >= 2);
}

/** A repo nugget without a repo (older extractions) belongs to its session's working directory. */
function scopeOf(n: NuggetRow): Scope | undefined {
  if (n.scope !== "repo") return { scope: "global" };
  const repo = n.repo ?? (n.cwd || undefined);
  return repo ? { scope: "repo", repo } : undefined;
}

const scopeKey = (s: Scope) => (s.scope === "global" ? "global" : `repo:${s.repo}`);

/**
 * Place nuggets in the tree (default: all unplaced ones). Call `syncTree` first so
 * live skills and declared topics are in the tree to be routed into.
 */
export async function insertNuggets(
  tree: Tree,
  runner: PiRunner,
  cfg: Config,
  opts: { nuggets?: NuggetRow[]; maxCalls?: number; batchSize?: number; log?: (m: string) => void } = {},
): Promise<InsertResult> {
  const log = opts.log ?? (() => {});
  const maxCalls = opts.maxCalls ?? Infinity;
  const batchSize = opts.batchSize ?? 40;
  const res: InsertResult = { placed: 0, skillsCreated: [], sectionsCreated: [], covered: 0, repairs: [], calls: 0, usage: ZERO_USAGE, deferred: 0 };
  const call = async <S extends TSchema>(req: PiRequest<S>): Promise<Static<S>> => {
    const r = await runner.run(req);
    res.calls++;
    res.usage = addUsage(res.usage, r.usage);
    return r.value;
  };

  const pending = opts.nuggets ?? tree.unplacedNuggets();
  const byScope = new Map<string, { scope: Scope; nuggets: NuggetRow[] }>();
  for (const n of pending) {
    const s = scopeOf(n);
    if (!s) {
      res.repairs.push(`nugget ${n.id}: repo-specific but no repository or working directory; left unplaced`);
      continue;
    }
    if (s.scope === "repo" && !n.repo) {
      tree.db.db.prepare("UPDATE nugget SET repo = ? WHERE id = ?").run(s.repo!, n.id);
      n.repo = s.repo!;
    }
    const e = byScope.get(scopeKey(s)) ?? { scope: s, nuggets: [] };
    e.nuggets.push(n);
    byScope.set(scopeKey(s), e);
  }

  for (const { scope, nuggets: all } of byScope.values()) {
    for (let i = 0; i < all.length; i += batchSize) {
      const batch = all.slice(i, i + batchSize);
      const rootId = tree.ensureRoot(scope);
      const root = tree.subtree(rootId)!;

      // ---- level 1: which skill?
      let plan: SkillPlan;
      if (root.children.length === 0 && batch.length === 1) {
        const n = batch[0]!;
        plan = { newSkills: [{ key: "solo", title: n.title, name: skillName(n.title), description: n.triggers[0] ?? n.title, nuggetIds: [n.id] }], placements: [], repairs: [] };
      } else {
        if (res.calls >= maxCalls) {
          res.deferred += all.length - i;
          log(`insert ${scopeKey(scope)}: call budget (${maxCalls}) reached; ${all.length - i} nugget(s) wait for the next run`);
          break;
        }
        log(`insert ${scopeKey(scope)}: ${batch.length} nugget(s) vs ${root.children.length} skill(s)`);
        plan = validateSkillRoute(
          await call({
            model: cfg.models.extract,
            thinking: cfg.models.extractThinking,
            systemPrompt: withGuidance(SKILL_SYSTEM_PROMPT, cfg),
            prompt: buildSkillPrompt(root, batch),
            resultTool: { name: "route_to_skills", description: "Place each new nugget in a skill.", parameters: SkillRouteSchema },
          }),
          root,
          batch,
        );
      }
      res.repairs.push(...plan.repairs);

      // Group by target skill, creating new skills.
      const toSkill = new Map<number, NuggetRow[]>();
      const byId = new Map(batch.map((n) => [n.id, n]));
      tree.db.tx(() => {
        for (const s of plan.newSkills) {
          const id = tree.createNode(rootId, { title: s.title, name: s.name, description: s.description });
          res.skillsCreated.push(s.name);
          toSkill.set(id, s.nuggetIds.map((x) => byId.get(x)!));
        }
      });
      for (const p of plan.placements) toSkill.set(p.skillId, [...(toSkill.get(p.skillId) ?? []), byId.get(p.nuggetId)!]);

      // ---- level 2: which section?
      for (const [skillId, ns] of toSkill) {
        const skill = tree.subtree(skillId)!;
        let sp: SectionPlan;
        if (!wantsSections(skill, ns.length) || res.calls >= maxCalls) {
          if (wantsSections(skill, ns.length)) log(`insert: call budget reached; ${ns.length} nugget(s) go to the body of ${skill.name ?? skill.title}`);
          sp = { newSections: [], placements: ns.map((n) => ({ nuggetId: n.id, covered: false })), repairs: [] };
        } else {
          log(`insert ${skill.name ?? skill.title}: ${ns.length} nugget(s) vs ${skill.children.length} section(s)`);
          sp = validateSectionRoute(
            await call({
              model: cfg.models.extract,
              thinking: cfg.models.extractThinking,
              systemPrompt: withGuidance(SECTION_SYSTEM_PROMPT, cfg),
              prompt: buildSectionPrompt(skill, ns),
              resultTool: { name: "route_to_sections", description: "Place each nugget in a section of this skill.", parameters: SectionRouteSchema },
            }),
            skill,
            ns,
          );
        }
        res.repairs.push(...sp.repairs);
        tree.db.tx(() => {
          for (const s of sp.newSections) {
            const id = tree.createNode(skillId, { title: s.title, description: s.description });
            res.sectionsCreated.push(`${skill.name ?? skill.title} › ${s.title}`);
            for (const n of s.nuggetIds) tree.attachNugget(n, id);
            res.placed += s.nuggetIds.length;
          }
          for (const p of sp.placements) {
            const target = p.sectionId ?? skillId;
            tree.attachNugget(p.nuggetId, target);
            // Only live text can already "cover" something; latent text is our own summary.
            const live = (p.sectionId ? skill.children.find((c) => c.id === p.sectionId)?.origin : skill.origin) === "file";
            if (p.covered && live) {
              tree.setCovered(p.nuggetId, target);
              res.covered++;
            }
            res.placed++;
          }
        });
      }
    }
  }
  tree.pruneEmpty();
  for (const r of res.repairs) log(`  repair: ${r}`);
  return res;
}

function withGuidance(prompt: string, cfg: Config): string {
  const g = cfg.clustering.guidance?.trim();
  return g ? `${prompt}\n\nGuidance from the engineer (follow it):\n${g}` : prompt;
}

/**
 * Take unlocked nuggets out of latent nodes so they can be inserted again
 * (e.g. after live skills were added to the tree). Returns them.
 */
export function detachLatent(tree: Tree): NuggetRow[] {
  const out: NuggetRow[] = [];
  tree.db.tx(() => {
    for (const root of tree.trees()) {
      for (const skill of root.children) {
        if (skill.origin !== "latent" || skill.locked || (skill.status !== "open" && skill.status !== "candidate")) continue;
        for (const n of subtreeNuggets(skill)) {
          if (n.assignmentLocked) continue;
          tree.detachNugget(n.id);
          out.push(n);
        }
      }
    }
    tree.pruneEmpty();
  });
  return out;
}

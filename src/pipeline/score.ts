import type { ScoreConfig } from "../config.ts";
import type { SkillInfo } from "../skills/index.ts";
import type { NuggetRow, StateDb, TopicWithClusters } from "../state/db.ts";

/** What scoring needs to know about a topic. */
export interface Scorable {
  title: string;
  summary: string;
  scope: "global" | "repo";
  repo?: string;
  /** User-declared skill name, if any. */
  name?: string;
  members: NuggetRow[];
}
import { resolveRepo, type RepoResolution } from "../skills/repo.ts";

export interface TopicStats {
  nuggets: number;
  /** Distinct (agent, session) pairs. Resumed copies are already deduped upstream by fingerprint. */
  sessions: number;
  agents: string[];
  /** Distinct calendar days (UTC) of the evidence turns. */
  days: number;
  corrections: number;
  /** Existing skills / AGENTS.md the extractor said already cover members. `?x` = unverified name. */
  coveredBy: string[];
  firstSeen?: string;
  lastSeen?: string;
}

/**
 * Where a cluster's knowledge should land:
 *  - global:new:<name>              new global skill
 *  - global:update:<skill>          extend an existing global skill
 *  - global:fix-description:<skill> content exists, but the skill didn't trigger
 *  - repo:agents-md:<repo>          short repo facts/rules → <repo>/AGENTS.md
 *  - repo:skill:<repo>:<name>       repo procedure → <repo>/.agents/skills/<name>/SKILL.md
 */
export type Target =
  | { kind: "global:new"; name: string }
  | { kind: "global:update"; skill: string }
  | { kind: "global:fix-description"; skill: string }
  | { kind: "repo:agents-md"; repo: string }
  | { kind: "repo:skill"; repo: string; name: string }
  /** Repo-scoped, but the repository couldn't be determined (e.g. ambiguous multi-package workspace). Not drafted. */
  | { kind: "repo:unresolved"; repo: string };

export function formatTarget(t: Target): string {
  switch (t.kind) {
    case "global:new":
      return `global:new:${t.name}`;
    case "global:update":
      return `global:update:${t.skill}`;
    case "global:fix-description":
      return `global:fix-description:${t.skill}`;
    case "repo:agents-md":
      return `repo:agents-md:${t.repo}`;
    case "repo:skill":
      return `repo:skill:${t.repo}:${t.name}`;
    case "repo:unresolved":
      return `repo:unresolved:${t.repo}`;
  }
}

export function parseTarget(s: string): Target {
  const [scope, kind, ...rest] = s.split(":");
  const tail = rest.join(":");
  const k = `${scope}:${kind}`;
  if (k === "global:new") return { kind: k, name: tail };
  if (k === "global:update" || k === "global:fix-description") return { kind: k, skill: tail };
  if (k === "repo:agents-md" || k === "repo:unresolved") return { kind: k, repo: tail };
  if (k === "repo:skill") {
    const i = tail.lastIndexOf(":");
    return { kind: k, repo: tail.slice(0, i), name: tail.slice(i + 1) };
  }
  throw new Error(`Bad target: ${s}`);
}

export function topicStats(c: Scorable): TopicStats {
  const sessions = new Set<string>();
  const agents = new Set<string>();
  const days = new Set<string>();
  const covered = new Set<string>();
  const stamps: string[] = [];
  let corrections = 0;
  for (const n of c.members) {
    sessions.add(`${n.agent}:${n.sessionId}`);
    agents.add(n.agent);
    if (n.kind === "correction") corrections++;
    if (n.coveredBy) covered.add(n.coveredBy);
    const ts = n.evidence.map((e) => e.ts).filter((x): x is string => !!x);
    if (ts.length === 0) ts.push(n.createdAt.toISOString());
    for (const t of ts) {
      days.add(t.slice(0, 10));
      stamps.push(t);
    }
  }
  stamps.sort();
  return {
    nuggets: c.members.length,
    sessions: sessions.size,
    agents: [...agents].sort(),
    days: days.size,
    corrections,
    coveredBy: [...covered].sort(),
    ...(stamps.length ? { firstSeen: stamps[0]!, lastSeen: stamps[stamps.length - 1]! } : {}),
  };
}

export function scoreOf(s: TopicStats, w: ScoreConfig["weights"]): number {
  return (
    s.sessions * w.session +
    Math.max(0, s.agents.length - 1) * w.extraAgent +
    Math.max(0, s.days - 1) * w.extraDay +
    s.corrections * w.correction -
    (s.coveredBy.length ? w.covered : 0)
  );
}

export function meetsPromotion(s: TopicStats, p: ScoreConfig["promote"]): boolean {
  return s.sessions >= p.minSessions || (s.sessions >= p.minSessionsCrossAgent && s.agents.length >= 2);
}

/** Valid pi/Agent Skills name: lowercase letters, digits, single hyphens, ≤ 64 chars. */
export function skillName(title: string): string {
  const stop = new Set(["the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "by", "is", "are"]);
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !stop.has(w));
  let name = "";
  for (const w of words) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > 40) break;
    name = next;
  }
  return name || "skill";
}

const STOPWORDS = new Set(
  "the and for with from that this when what where which into onto use uses using used not but are was were has have had you your its it's can will should must how why any all one two via per about over under than then them they their there here also only just more most other such".split(
    " ",
  ),
);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/**
 * Overlap coefficient |A∩B| / min(|A|,|B|) between content-word sets.
 * Fewer than 2 shared words counts as unrelated (a single shared word is noise).
 */
export function similarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter < 2 ? 0 : inter / Math.min(A.size, B.size);
}

export function pickTarget(
  c: Scorable,
  skills: SkillInfo[],
  cfg: Pick<ScoreConfig, "updateSimilarity" | "agentsMdMaxChars">,
): Target {
  if (c.scope === "repo") {
    const repo = c.repo ?? "";
    const procedural = c.members.filter((m) => m.kind === "procedure").length;
    const longForm = c.summary.length > cfg.agentsMdMaxChars;
    return longForm && procedural >= Math.ceil(c.members.length / 2)
      ? { kind: "repo:skill", repo, name: c.name ?? skillName(c.title) }
      : { kind: "repo:agents-md", repo };
  }

  // A verified "already covered by <skill>" on most members → the skill didn't trigger.
  const names = new Set(skills.map((s) => s.name));
  const coveredVotes = new Map<string, number>();
  for (const m of c.members) if (m.coveredBy && names.has(m.coveredBy)) coveredVotes.set(m.coveredBy, (coveredVotes.get(m.coveredBy) ?? 0) + 1);
  const [topCovered, votes] = [...coveredVotes].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (topCovered && votes! * 2 >= c.members.length) return { kind: "global:fix-description", skill: topCovered };
  if (topCovered) return { kind: "global:update", skill: topCovered };

  // Otherwise extend the most similar existing skill, if similar enough.
  const text = `${c.title} ${c.summary}`;
  const best = skills
    .map((s) => ({ s, sim: similarity(`${s.name.replace(/-/g, " ")} ${s.description}`, text) }))
    .sort((a, b) => b.sim - a.sim)[0];
  if (best && best.sim >= cfg.updateSimilarity) return { kind: "global:update", skill: best.s.name };

  return { kind: "global:new", name: c.name ?? skillName(c.title) };
}

export interface ScoreResult {
  scored: number;
  promoted: { id: number; title: string; target: string; score: number }[];
}

/**
 * Recompute stats/score for every topic on the union of its clusters; promote
 * `open` (or re-promote grown `rejected`) topics that meet the thresholds, and set
 * their target. `proposed` / `merged` topics keep their status and target.
 */
export function scoreTopics(db: StateDb, skills: SkillInfo[], cfg: ScoreConfig): ScoreResult {
  const res: ScoreResult = { scored: 0, promoted: [] };
  db.tx(() => {
    for (const t of db.topics()) {
      const stats = topicStats(t);
      const score = scoreOf(stats, cfg.weights);
      res.scored++;
      const eligible =
        t.members.length > 0 &&
        meetsPromotion(stats, cfg.promote) &&
        (t.status === "open" ||
          t.status === "candidate" ||
          (t.status === "rejected" && stats.sessions >= (t.rejectedSessions ?? 0) + cfg.promote.reproposeAfterSessions));
      if (eligible) {
        const target = t.targetLocked && t.target ? t.target : formatTarget(pickTarget(t, skills, cfg));
        db.updateTopic(t.id, { stats, score, status: "candidate", target });
        if (t.status !== "candidate") res.promoted.push({ id: t.id, title: t.title, target, score });
      } else {
        db.updateTopic(t.id, { stats, score });
      }
    }
  });
  return res;
}

/** Everything known about a topic, for resolving which package it refers to. */
export function topicText(c: Scorable): string {
  return [c.title, c.summary, ...c.members.flatMap((m) => [m.title, m.knowledge, m.cwd, ...m.evidence.map((e) => e.quote)])].join("\n");
}

/**
 * For candidate topics with repo targets, pin the target to a real git repository
 * (multi-package workspace roots → a package). Unresolvable ones get `repo:unresolved`
 * and are not drafted until retargeted by hand.
 */
export async function resolveRepoTargets(
  db: StateDb,
  resolve: (path: string, text: string) => Promise<RepoResolution> = resolveRepo,
): Promise<{ id: number; from: string; to: string; reason?: string; candidates?: string[] }[]> {
  const changes: { id: number; from: string; to: string; reason?: string; candidates?: string[] }[] = [];
  for (const c of db.topics(["candidate"])) {
    if (!c.target?.startsWith("repo:") || c.targetLocked) continue;
    const t = parseTarget(c.target);
    if (t.kind !== "repo:agents-md" && t.kind !== "repo:skill" && t.kind !== "repo:unresolved") continue;
    const r = await resolve(t.repo, topicText(c));
    let next: Target;
    if (r.ok) {
      next = t.kind === "repo:skill" ? { ...t, repo: r.root } : t.kind === "repo:agents-md" ? { ...t, repo: r.root } : { kind: "repo:agents-md", repo: r.root };
    } else {
      next = { kind: "repo:unresolved", repo: t.repo };
    }
    const to = formatTarget(next);
    if (to !== c.target) {
      db.updateTopic(c.id, { target: to });
      changes.push({ id: c.id, from: c.target, to, ...(r.ok ? {} : { reason: r.reason, candidates: r.candidates }) });
    }
  }
  return changes;
}

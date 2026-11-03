import type { ScoreConfig } from "../config.ts";
import type { NuggetRow } from "../state/db.ts";

/** Recurrence over a set of nuggets (a skill's subtree, or a section). */
export interface EvidenceStats {
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

export function evidenceStats(c: { members: NuggetRow[] }): EvidenceStats {
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

export function scoreOf(s: EvidenceStats, w: ScoreConfig["weights"]): number {
  return (
    s.sessions * w.session +
    Math.max(0, s.agents.length - 1) * w.extraAgent +
    Math.max(0, s.days - 1) * w.extraDay +
    s.corrections * w.correction -
    (s.coveredBy.length ? w.covered : 0)
  );
}

export function meetsPromotion(s: EvidenceStats, p: ScoreConfig["promote"]): boolean {
  return s.sessions >= p.minSessions || (s.sessions >= p.minSessionsCrossAgent && s.agents.length >= 2);
}

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

export function evidenceText(c: { title: string; summary: string; members: NuggetRow[] }): string {
  return [c.title, c.summary, ...c.members.flatMap((m) => [m.title, m.knowledge, m.cwd, ...m.evidence.map((e) => e.quote)])].join("\n");
}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setExtraPatterns, type ExtraPattern } from "./pipeline/redact.ts";

/** Truncation limits applied when normalizing transcripts. */
export interface NormalizeLimits {
  /** Max chars kept from a single tool result. */
  toolResultChars: number;
  /** Max chars kept from a rendered tool-call input. */
  toolInputChars: number;
}

export const DEFAULT_LIMITS: NormalizeLimits = {
  toolResultChars: 1500,
  toolInputChars: 300,
};

const home = homedir();

/** Expand a leading `~` and make the path absolute. */
export function expandPath(p: string): string {
  const expanded = p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Default on-disk locations of each agent's session storage. */
export const DEFAULT_PATHS = {
  claudeProjects: process.env.LBG_CLAUDE_PROJECTS ?? join(home, ".claude", "projects"),
  piSessions: process.env.LBG_PI_SESSIONS ?? join(home, ".pi", "agent", "sessions"),
  opencodeDb: process.env.LBG_OPENCODE_DB ?? join(home, ".local", "share", "opencode", "opencode.db"),
  skillsDir: process.env.LBG_SKILLS_DIR ?? join(home, ".config", "opencode", "skills"),
  stateDir: process.env.LBG_STATE_DIR ?? join(home, ".local", "state", "laobaigan"),
};

/**
 * Optional per-stage overrides. Unset = pi's own default (defaultModel / defaultThinkingLevel
 * in ~/.pi/agent/settings.json), so the model is chosen in one place. A value is
 * "provider/id", or an id of pi's default provider.
 */
export interface ModelConfig {
  extract?: string;
  distill?: string;
  extractThinking?: "off" | "minimal" | "low" | "medium" | "high";
  distillThinking?: "off" | "minimal" | "low" | "medium" | "high";
}

export interface Config {
  /** The global skills directory every agent loads (here: ~/.config/opencode/skills, symlinked from pi and Claude). */
  skillsDir: string;
  stateDir: string;
  models: ModelConfig;
  /** Skip sessions modified more recently than this (minutes). */
  settleMinutes: number;
  extract: {
    /** Approximate max tokens of excerpt per extract call. */
    chunkTokens: number;
    /** Max extract calls per run (the rest waits for the next run). */
    maxCallsPerRun: number;
  };
  score: ScoreConfig;
  redact: {
    /** Site-specific secrets to redact in addition to the built-in rules (e.g. an SSO cookie name). */
    extraPatterns: ExtraPattern[];
  };
  insert: {
    /** Max routing calls per run (the rest waits for the next run). */
    maxCallsPerRun: number;
  };
  render: {
    /** Max proposals drafted per run (each is one opus session). */
    maxPerRun: number;
    /** After a failed draft, wait this long before lbg run tries that skill again (lbg draft <id> ignores it). */
    retryAfterHours: number;
    /** SKILL.md longer than this fails verification (move detail into references/). */
    maxSkillLines: number;
  };
  /** Topics I want to exist (future skills / AGENTS.md sections); always offered as homes. */
  topics: DeclaredTopic[];
  clustering: {
    /** Free-text policy appended to the clustering (and consolidation) prompt. */
    guidance: string;
  };
}

export interface DeclaredTopic {
  /** Skill name: lowercase letters, digits, single hyphens, ≤ 64 chars. */
  name: string;
  /** Display title. Default: derived from the name. */
  title?: string;
  /** What the topic covers; the clustering model uses it to decide what belongs. */
  description: string;
  /** Default "global". */
  scope?: "global" | "repo";
  /** Required when scope is "repo": the repository root. */
  repo?: string;
}

export interface ScoreConfig {
  weights: {
    /** Per distinct session the topic came up in. */
    session: number;
    /** Per additional agent (explained to Claude AND pi is a strong signal). */
    extraAgent: number;
    /** Per additional distinct day. */
    extraDay: number;
    /** Per correction-kind nugget ("no, do X"). */
    correction: number;
    /** Subtracted when an existing skill already covers it (it then needs a description fix, not content). */
    covered: number;
  };
  promote: {
    /** Promote when the topic came up in at least this many sessions… */
    minSessions: number;
    /** …or in at least this many sessions across ≥ 2 different agents. */
    minSessionsCrossAgent: number;
    /** A rejected cluster is re-proposed only after this many *new* sessions. */
    reproposeAfterSessions: number;
    /** A live skill gets an update proposal when evidence since its last render spans this many sessions. */
    updateMinSessions: number;
    /** …and a description fix when "already covered" evidence spans this many sessions. */
    fixDescriptionMinSessions: number;
  };
  /** Min token-overlap (0..1) with an existing skill's name+description to target it for an update. */
  updateSimilarity: number;
  /** Repo topics with summaries up to this many chars go into AGENTS.md; longer ones become repo skills. */
  agentsMdMaxChars: number;
}

export const DEFAULT_CONFIG: Config = {
  skillsDir: DEFAULT_PATHS.skillsDir,
  stateDir: DEFAULT_PATHS.stateDir,
  models: {},
  settleMinutes: 30,
  extract: {
    chunkTokens: 40_000,
    maxCallsPerRun: 50,
  },
  redact: { extraPatterns: [] },
  insert: { maxCallsPerRun: 20 },
  render: { maxPerRun: 2, retryAfterHours: 24, maxSkillLines: 300 },
  score: {
    weights: { session: 3, extraAgent: 3, extraDay: 1, correction: 1, covered: 2 },
    promote: { minSessions: 3, minSessionsCrossAgent: 2, reproposeAfterSessions: 2, updateMinSessions: 2, fixDescriptionMinSessions: 2 },
    updateSimilarity: 0.25,
    agentsMdMaxChars: 1200,
  },
  topics: [],
  clustering: { guidance: "" },
};

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateTopics(topics: DeclaredTopic[]): DeclaredTopic[] {
  const seen = new Set<string>();
  return topics.map((t, i) => {
    if (!t || typeof t.name !== "string" || !SKILL_NAME.test(t.name) || t.name.length > 64) {
      throw new Error(`config.topics[${i}].name must be lowercase letters, digits and single hyphens (got ${JSON.stringify(t?.name)})`);
    }
    if (typeof t.description !== "string" || !t.description.trim()) throw new Error(`config.topics[${i}] (${t.name}) needs a description`);
    const scope = t.scope ?? "global";
    if (scope === "repo" && !t.repo) throw new Error(`config.topics[${i}] (${t.name}) has scope "repo" but no repo`);
    const key = `${scope}:${t.repo ?? ""}:${t.name}`;
    if (seen.has(key)) throw new Error(`config.topics: duplicate ${t.name}`);
    seen.add(key);
    return { ...t, scope, ...(t.repo ? { repo: expandPath(t.repo) } : {}) };
  });
}

export const CONFIG_PATH =
  process.env.LBG_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "laobaigan", "config.json");

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object"
        ? merge(b, v as DeepPartial<typeof b>)
        : v;
  }
  return out as T;
}

/** Load config: defaults ← config file (JSON, `//` comments allowed). Paths are expanded. */
export function loadConfig(path = CONFIG_PATH): Config {
  let fileCfg: DeepPartial<Config> | undefined;
  try {
    const raw = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
    fileCfg = JSON.parse(raw) as DeepPartial<Config>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Bad config ${path}: ${String(err)}`);
  }
  const c = merge(DEFAULT_CONFIG, fileCfg);
  // Redaction runs deep inside extraction and verification; install the patterns once, here.
  setExtraPatterns(Array.isArray(c.redact?.extraPatterns) ? c.redact.extraPatterns : []);
  return {
    ...c,
    skillsDir: expandPath(c.skillsDir),
    topics: validateTopics(Array.isArray(c.topics) ? c.topics : []),
    stateDir: expandPath(c.stateDir),
  };
}

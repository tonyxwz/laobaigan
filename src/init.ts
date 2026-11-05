import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CONFIG_PATH, detectSkillsDir, skillsDirCandidates } from "./config.ts";
import type { SourceAdapter } from "./sources/types.ts";

/**
 * `lbg init`: see what this machine has (agents' session stores, skills dirs, pi's
 * model settings, the pi CLI) and write a starter config with the detected skills dir.
 * An existing config is never overwritten.
 */

export interface InitReport {
  configPath: string;
  /** "created", or "kept" when a config already existed. */
  config: "created" | "kept";
  skillsDir: string;
  skillsDirs: { path: string; exists: boolean }[];
  agents: { agent: string; available: boolean }[];
  pi: { provider?: string; model?: string; cli?: string };
}

const tilde = (p: string, h: string) => (p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p);

/** First `name` on PATH. */
export function onPath(name: string, path: string = process.env.PATH ?? ""): string | undefined {
  for (const d of path.split(delimiter)) if (d && existsSync(join(d, name))) return join(d, name);
  return undefined;
}

export async function init(opts: {
  adapters: SourceAdapter[];
  piDefaults: () => { provider?: string; model?: string };
  configPath?: string;
  home?: string;
  skillsDir?: string;
}): Promise<InitReport> {
  const configPath = opts.configPath ?? CONFIG_PATH;
  const h = opts.home ?? homedir();
  const skillsDir = opts.skillsDir ?? detectSkillsDir(h);
  const agents = [];
  for (const a of opts.adapters) agents.push({ agent: a.agent, available: await a.available().catch(() => false) });
  let config: InitReport["config"] = "kept";
  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify({ skillsDir: tilde(skillsDir, h) }, null, 2)}\n`,
    );
    config = "created";
  }
  let pi: InitReport["pi"] = {};
  try {
    pi = opts.piDefaults();
  } catch {
    // pi not configured yet
  }
  const cli = onPath("pi");
  return {
    configPath,
    config,
    skillsDir,
    skillsDirs: skillsDirCandidates(h).map((p) => ({ path: p, exists: existsSync(p) })),
    agents,
    pi: { ...pi, ...(cli ? { cli } : {}) },
  };
}

export function renderInit(r: InitReport, h: string = homedir()): string {
  const t = (p: string) => tilde(p, h);
  const lines = [
    `config: ${t(r.configPath)} (${r.config === "created" ? "created" : "already exists, left as is"})`,
    `skills dir: ${t(r.skillsDir)}`,
    ...r.skillsDirs.map((d) => `  ${d.exists ? "✓" : "·"} ${t(d.path)}`),
    "agents' sessions:",
    ...r.agents.map((a) => `  ${a.available ? "✓" : "·"} ${a.agent}`),
    `model: ${r.pi.provider && r.pi.model ? `${r.pi.provider}/${r.pi.model} (pi's default; override with models.* in the config)` : "pi has no default model yet: run pi and pick one (/model), or set models.* in the config"}`,
    `pi CLI: ${r.pi.cli ? t(r.pi.cli) : "not on PATH (needed only for lbg proposal revise)"}`,
    "",
    "Next:",
    "  lbg run                 first pass: reads all your history (this takes a while and uses the model)",
    "  lbg service install     run it hourly in the background (systemd user timer)",
    "  lbg prompt              show waiting proposals in your shell prompt",
  ];
  if (!r.agents.some((a) => a.available)) lines.splice(lines.indexOf("Next:"), 0, "No agent sessions found; lbg learns from Claude Code, pi, and opencode sessions.", "");
  return `${lines.join("\n")}\n`;
}

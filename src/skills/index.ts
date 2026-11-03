import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exists, subdirs } from "../util/fs.ts";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: "global" | "repo";
}

export interface RepoContext {
  /** Absolute repo root (git top-level). */
  root: string;
  skills: SkillInfo[];
  /** `AGENTS.md` / `CLAUDE.md` section headings, for overlap checks. */
  agentsMdHeadings: string[];
  agentsMdPath?: string;
}

/** Parse `name` / `description` from SKILL.md YAML frontmatter (single-line or folded values). */
export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-" || value === "") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(" ");
    }
    out[kv[1]!] = value.replace(/^["']|["']$/g, "");
  }
  return { ...(out.name ? { name: out.name } : {}), ...(out.description ? { description: out.description } : {}) };
}

export async function loadSkillsDir(dir: string, scope: SkillInfo["scope"]): Promise<SkillInfo[]> {
  const out: SkillInfo[] = [];
  for (const d of await subdirs(dir)) {
    const path = join(d, "SKILL.md");
    let md: string;
    try {
      md = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(md);
    out.push({ name: fm.name ?? d.split("/").pop()!, description: fm.description ?? "", path, scope });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The project (repository) root containing `dir`: the nearest ancestor with a `.git`
 * entry (directory, or file for worktrees/submodules). Plain filesystem walk; lbg never
 * runs git. Undefined if there is none (or `dir` doesn't exist).
 */
export async function projectRoot(dir: string): Promise<string | undefined> {
  if (!dir || !(await exists(dir))) return undefined;
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (await exists(join(d, ".git"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

const repoCache = new Map<string, Promise<RepoContext | undefined>>();

/** Repo-local skills (`.agents/skills`) and AGENTS.md headings for the repo containing `dir`. */
export function repoContext(dir: string): Promise<RepoContext | undefined> {
  let p = repoCache.get(dir);
  if (!p) {
    p = (async () => {
      const root = await projectRoot(dir);
      if (!root) return undefined;
      const skills = await loadSkillsDir(join(root, ".agents", "skills"), "repo");
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const path = join(root, name);
        try {
          const md = await readFile(path, "utf8");
          const headings = [...md.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1]!.trim());
          return { root, skills, agentsMdHeadings: headings, agentsMdPath: path };
        } catch {
          // try next
        }
      }
      return { root, skills, agentsMdHeadings: [] };
    })();
    repoCache.set(dir, p);
  }
  return p;
}

/** Compact text listing for prompts. */
export function renderSkillIndex(global: SkillInfo[], repo: RepoContext | undefined): string {
  const lines = ["Global skills (shared by all agents):"];
  for (const s of global) lines.push(`- ${s.name}: ${s.description}`);
  if (global.length === 0) lines.push("- (none)");
  if (repo) {
    lines.push("", `Repo-local knowledge in ${repo.root}:`);
    for (const s of repo.skills) lines.push(`- .agents/skills/${s.name}: ${s.description}`);
    if (repo.agentsMdPath) {
      lines.push(`- ${repo.agentsMdPath.split("/").pop()} sections: ${repo.agentsMdHeadings.join(" | ") || "(no headings)"}`);
    }
    if (!repo.skills.length && !repo.agentsMdPath) lines.push("- (none)");
  }
  return lines.join("\n");
}

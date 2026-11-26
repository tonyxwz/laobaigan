import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isDir, readIfExists } from "../util/fs.ts";
import { shortHash } from "../util/hash.ts";
import { parseFrontmatter } from "./index.ts";

/**
 * Parse skill files into the shapes the knowledge tree mirrors:
 *
 *   <skills>/<name>/SKILL.md          → skill (depth 1): frontmatter name/description, body before the first "##"
 *     "## Heading" sections           → sections (depth 2), source "<SKILL.md>#<slug>"
 *     references/*.md                 → sections (depth 2), source = the file
 *   <repo>/AGENTS.md                  → root text = body before the first "##"
 *     "## Heading" sections           → depth-1 nodes, source "<AGENTS.md>#<slug>"
 *       "### Heading" subsections     → depth-2 nodes
 *     text before the first "##"      → a depth-1 node too (the intro), source "<AGENTS.md>#^intro"
 *   <repo>/.agents/skills/<name>/     → repo skills, parsed like global ones (also .claude/skills,
 *                                       .pi/skills, …: see AGENT_SKILL_DIRS)
 *   <repo>/docs/*.md                  → documents: depth-1 nodes, source = the file
 *     "## Heading" sections           → depth-2 nodes, source "<file>#<slug>"
 *
 * Headings inside fenced code blocks are ignored.
 */

export interface ParsedSection {
  title: string;
  slug: string;
  /** One line for routing: the first sentence of the body. */
  description: string;
  body: string;
  sourcePath: string;
  hash: string;
}

export interface ParsedSkill {
  /** Skill name (frontmatter), or the section slug for AGENTS.md sections. */
  name: string;
  title: string;
  description: string;
  /** Body text that isn't in a section. */
  intro: string;
  sections: ParsedSection[];
  sourcePath: string;
  /** Hash over everything the node mirrors (incl. sections), to detect edits. */
  hash: string;
  /** Non-markdown files bundled with the skill (scripts, templates). */
  resources: string[];
}

export interface ParsedAgentsMd {
  path: string;
  /** Text before the first "##": what every agent in the repo always reads. */
  preamble: string;
  /** The preamble as a node of its own, so knowledge can be filed there (absent when it is empty). */
  intro?: ParsedSkill;
  sections: ParsedSkill[];
  hash: string;
}

/**
 * Where agents keep a repository's skills, in order of preference. Many repos have several
 * (often symlinked to one another); lbg mirrors them all and writes new skills to the first
 * one the repo already uses.
 */
export const AGENT_SKILL_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".pi/skills",
  ".codex/skills",
  ".gemini/skills",
  ".opencode/skills",
  ".cursor/skills",
  ".kiro/skills",
  ".github/skills",
];

/** Instruction files agents load from a repository's root, plus the README. */
export const AGENT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  ".github/copilot-instructions.md",
];

/** Directories of per-agent instruction files (rules), other than skills. */
export const AGENT_RULE_DIRS = [
  ".claude/rules",
  ".cursor/rules",
  ".kiro/steering",
  ".github/instructions",
];

/**
 * Of `candidates` (paths relative to `repo`), those that exist, stay inside the repo once
 * symlinks are resolved, and aren't another name for (or inside) an earlier one.
 */
export async function distinctExisting(
  repo: string,
  candidates: string[],
): Promise<string[]> {
  let root: string;
  try {
    root = await realpath(repo);
  } catch {
    return [];
  }
  const within = (child: string, parent: string) =>
    child === parent || child.startsWith(`${parent}/`);
  const kept: { rel: string; real: string }[] = [];
  for (const rel of candidates) {
    let real: string;
    try {
      real = await realpath(join(repo, rel));
    } catch {
      continue;
    }
    if (!within(real, root) || kept.some((k) => within(real, k.real))) continue;
    kept.push({ rel, real });
  }
  return kept.map((k) => k.rel);
}

/** The skills directories a repo has, one entry per real directory. */
export function repoSkillDirs(repo: string): Promise<string[]> {
  return distinctExisting(repo, AGENT_SKILL_DIRS);
}

/** Source path suffix of the AGENTS.md intro node ("^" never comes out of slugify). */
export const INTRO_ANCHOR = "#^intro";

/** Max documents mirrored per docs directory. */
export const MAX_DOCS = 30;

export type FileNodeKind =
  /** The text before the first "##" of AGENTS.md / CLAUDE.md. */
  | "agents-intro"
  /** A "##" section of AGENTS.md / CLAUDE.md. */
  | "agents-section"
  /** A skill folder (global, or a repo's .agents/skills/<name>). */
  | "skill"
  /** A repository document (docs/<x>.md). */
  | "doc";

/** What kind of file a depth-1 file node mirrors, from its source path. */
export function fileNodeKind(
  sourcePath: string | undefined,
): FileNodeKind | undefined {
  if (!sourcePath) return undefined;
  if (/\/(AGENTS|CLAUDE)\.md#/i.test(sourcePath))
    return sourcePath.endsWith(INTRO_ANCHOR)
      ? "agents-intro"
      : "agents-section";
  if (sourcePath.endsWith("/SKILL.md")) return "skill";
  if (/\.md$/i.test(sourcePath)) return "doc";
  return undefined;
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[`*_~[\]()]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/** First sentence (or line) of a markdown body, for routing. */
export function firstSentence(body: string, max = 200): string {
  const text = body
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "") // fenced code
    .split("\n")
    .filter((l) => l.trim() && !/^\s*(#|```|\||>|[-*] \[)/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  const s = (m ? m[1]! : text).trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface HeadingPart {
  title: string;
  body: string;
}

/** Split markdown on headings of exactly `level`, ignoring fenced code. */
export function splitByHeading(
  md: string,
  level: number,
): { preamble: string; parts: HeadingPart[] } {
  const marker = `${"#".repeat(level)} `;
  const lines = md.split("\n");
  let fence: string | undefined;
  const preamble: string[] = [];
  const parts: { title: string; lines: string[] }[] = [];
  for (const line of lines) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1]!.slice(0, 3);
      else if (line.trim().startsWith(fence)) fence = undefined;
    }
    if (!fence && !f && line.startsWith(marker)) {
      parts.push({ title: line.slice(marker.length).trim(), lines: [] });
      continue;
    }
    if (parts.length) parts[parts.length - 1]!.lines.push(line);
    else preamble.push(line);
  }
  return {
    preamble: preamble.join("\n").trim(),
    parts: parts.map((p) => ({
      title: p.title,
      body: p.lines.join("\n").trim(),
    })),
  };
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** Remove a leading "# Title" line, returning it. */
function takeH1(body: string): { h1?: string; rest: string } {
  const m = /^\s*# (.+)\n?/.exec(body);
  return m
    ? { h1: m[1]!.trim(), rest: body.slice(m[0].length).trim() }
    : { rest: body.trim() };
}

function uniqueSlugs<T extends { title: string }>(
  parts: T[],
): (T & { slug: string })[] {
  const seen = new Map<string, number>();
  return parts.map((p) => {
    const base = slugify(p.title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...p, slug: n === 1 ? base : `${base}-${n}` };
  });
}

/** Parse one SKILL.md plus its references (given as name → content). */
export function parseSkill(
  skillMdPath: string,
  md: string,
  references: { path: string; content: string }[] = [],
  resources: string[] = [],
): ParsedSkill {
  const fm = parseFrontmatter(md);
  const dirName = basename(skillMdPath.replace(/\/SKILL\.md$/, ""));
  const { h1, rest } = takeH1(stripFrontmatter(md));
  const { preamble, parts } = splitByHeading(rest, 2);
  const sections: ParsedSection[] = uniqueSlugs(parts).map((p) => ({
    title: p.title,
    slug: p.slug,
    description: firstSentence(p.body),
    body: p.body,
    sourcePath: `${skillMdPath}#${p.slug}`,
    hash: shortHash(`${p.title}\n${p.body}`),
  }));
  for (const r of references) {
    const { h1: refTitle, rest: refBody } = takeH1(stripFrontmatter(r.content));
    const slug = slugify(basename(r.path, extname(r.path)));
    sections.push({
      title: refTitle ?? basename(r.path),
      slug,
      description: firstSentence(refBody),
      body: refBody,
      sourcePath: r.path,
      hash: shortHash(r.content),
    });
  }
  return {
    name: fm.name ?? dirName,
    title: h1 ?? fm.name ?? dirName,
    description: fm.description ?? "",
    intro: preamble,
    sections,
    sourcePath: skillMdPath,
    // Relative names only: moving the skills dir isn't an edit.
    hash: shortHash(
      [md, ...references.map((r) => `${basename(r.path)}\n${r.content}`)].join(
        "\n\0",
      ),
    ),
    resources,
  };
}

/** Parse an AGENTS.md: "##" sections become depth-1 nodes, "###" their sections. */
export function parseAgentsMd(path: string, md: string): ParsedAgentsMd {
  const { rest } = takeH1(stripFrontmatter(md));
  const { preamble, parts } = splitByHeading(rest, 2);
  const sections = uniqueSlugs(parts).map((p): ParsedSkill => {
    const inner = splitByHeading(p.body, 3);
    const source = `${path}#${p.slug}`;
    return {
      name: p.slug,
      title: p.title,
      description: firstSentence(p.body),
      intro: inner.preamble,
      sections: uniqueSlugs(inner.parts).map((s) => ({
        title: s.title,
        slug: s.slug,
        description: firstSentence(s.body),
        body: s.body,
        sourcePath: `${source}/${s.slug}`,
        hash: shortHash(`${s.title}\n${s.body}`),
      })),
      sourcePath: source,
      hash: shortHash(`${p.title}\n${p.body}`),
      resources: [],
    };
  });
  const intro: ParsedSkill | undefined = preamble
    ? {
        name: `${slugify(basename(path))}-intro`,
        title: `${basename(path)} intro`,
        description: firstSentence(preamble),
        intro: preamble,
        sections: [],
        sourcePath: `${path}${INTRO_ANCHOR}`,
        hash: shortHash(preamble),
        resources: [],
      }
    : undefined;
  return {
    path,
    preamble,
    ...(intro ? { intro } : {}),
    sections,
    hash: shortHash(md),
  };
}

/**
 * Parse a repository document (docs/<x>.md): the file is a depth-1 node, its "##" sections
 * depth 2. `rel` is its path relative to the repo root; it leads the description so that
 * routing and drafting can tell a document from a skill.
 */
export function parseDoc(path: string, rel: string, md: string): ParsedSkill {
  const { h1, rest } = takeH1(stripFrontmatter(md));
  const { preamble, parts } = splitByHeading(rest, 2);
  const first = firstSentence(preamble);
  return {
    name: slugify(rel.replace(/\.md$/i, "")),
    title: h1 ?? basename(path),
    description: `${rel}${first ? `: ${first}` : ""}`,
    intro: preamble,
    sections: uniqueSlugs(parts).map((p) => ({
      title: p.title,
      slug: p.slug,
      description: firstSentence(p.body),
      body: p.body,
      sourcePath: `${path}#${p.slug}`,
      hash: shortHash(`${p.title}\n${p.body}`),
    })),
    sourcePath: path,
    hash: shortHash(md),
    resources: [],
  };
}

/** The markdown files directly inside each docs directory of a repo, as paths relative to it. */
export async function repoDocFiles(
  repo: string,
  docDirs: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const dir of docDirs) {
    let names: string[];
    try {
      names = (await readdir(join(repo, dir))).sort();
    } catch {
      continue;
    }
    out.push(
      ...names
        .filter((f) => /\.md$/i.test(f))
        .slice(0, MAX_DOCS)
        .map((f) => join(dir, f)),
    );
  }
  return out;
}

/** Parse every `<dir>/<name>/SKILL.md` (symlinked skill dirs included). */
export async function parseSkillsDir(dir: string): Promise<ParsedSkill[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  const out: ParsedSkill[] = [];
  for (const name of names) {
    const skillDir = join(dir, name);
    if (!(await isDir(skillDir))) continue;
    const skillMd = join(skillDir, "SKILL.md");
    const md = await readIfExists(skillMd);
    if (md === undefined) continue;
    const refs: { path: string; content: string }[] = [];
    const resources: string[] = [];
    const refDir = join(skillDir, "references");
    if (await isDir(refDir)) {
      for (const f of (await readdir(refDir)).sort()) {
        const p = join(refDir, f);
        if (f.endsWith(".md"))
          refs.push({ path: p, content: (await readIfExists(p)) ?? "" });
        else resources.push(p);
      }
    }
    out.push(parseSkill(skillMd, md, refs, resources));
  }
  return out;
}

/** A repo's AGENTS.md (or CLAUDE.md when there is no AGENTS.md), the skills of every agent's skills directory, and its documents. */
export async function parseRepo(
  repo: string,
  docDirs: string[] = [],
): Promise<{
  agentsMd?: ParsedAgentsMd;
  skills: ParsedSkill[];
  docs: ParsedSkill[];
}> {
  let agentsMd: ParsedAgentsMd | undefined;
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const p = join(repo, name);
    const md = await readIfExists(p);
    // A CLAUDE.md that only points at AGENTS.md ("@AGENTS.md") adds nothing.
    if (md !== undefined && !/^\s*@AGENTS\.md\s*$/.test(md)) {
      agentsMd = parseAgentsMd(p, md);
      break;
    }
  }
  const docs: ParsedSkill[] = [];
  for (const rel of await repoDocFiles(repo, docDirs)) {
    const md = await readIfExists(join(repo, rel));
    if (md?.trim()) docs.push(parseDoc(join(repo, rel), rel, md));
  }
  const skills: ParsedSkill[] = [];
  for (const dir of await repoSkillDirs(repo))
    skills.push(...(await parseSkillsDir(join(repo, dir))));
  return { ...(agentsMd ? { agentsMd } : {}), skills, docs };
}

import { basename } from "node:path";
import type { Config } from "../config.ts";
import { parseFrontmatter } from "../skills/index.ts";
import { AGENT_SKILL_DIRS } from "../skills/parse.ts";
import type { DraftFile } from "../state/proposals.ts";
import { privateHits, privateProblems } from "./privacy.ts";
import { containsSecrets } from "./redact.ts";
import { isAllowed, type RenderTarget } from "./target.ts";

/** Checks a finished draft must pass before it becomes a proposal. */

const GENERATED_BLOCK =
  /<!--\s*(BEGIN\b[^>]*?)-->[\s\S]*?<!--\s*END\b[^>]*?-->/g;

/** Problems with a draft; empty = OK. `files` are the changes, `base` the originals. */
export function verifyDraft(
  files: DraftFile[],
  base: Map<string, string>,
  target: RenderTarget,
  cfg: Config,
): string[] {
  const problems: string[] = [];
  if (!files.length) problems.push("no files were changed");
  for (const f of files)
    if (!isAllowed(f.path, target.writable))
      problems.push(`changed a path outside the proposal: ${f.path}`);
  const after = new Map(base);
  for (const f of files)
    f.content === null ? after.delete(f.path) : after.set(f.path, f.content);

  // Every skill the draft touched must stay a valid skill: the target, and any other one.
  const skillDirs = new Set<string>();
  for (const f of files) {
    if (target.skillDir && f.path.startsWith(`${target.skillDir}/`))
      skillDirs.add(target.skillDir);
    for (const d of target.readRoot ? AGENT_SKILL_DIRS : []) {
      const m = f.path.startsWith(`${d}/`)
        ? /^[^/]+/.exec(f.path.slice(d.length + 1))
        : null;
      if (m && f.path !== `${d}/${m[0]}`) skillDirs.add(`${d}/${m[0]}`);
    }
  }
  for (const skillDir of skillDirs) {
    const own = skillDir === target.skillDir;
    const at = own ? "" : `${skillDir}: `;
    const md = after.get(`${skillDir}/SKILL.md`);
    if (md === undefined) {
      // Deleting another skill outright is caught below; a half-deleted one here.
      if (own || [...after.keys()].some((p) => p.startsWith(`${skillDir}/`)))
        problems.push(`${skillDir}/SKILL.md is missing`);
      continue;
    }
    const fm = parseFrontmatter(md);
    const dir = basename(skillDir);
    if (fm.name !== dir)
      problems.push(
        `${at}frontmatter name must be "${dir}" (got ${JSON.stringify(fm.name)})`,
      );
    if (!fm.description)
      problems.push(`${at}frontmatter description is missing`);
    else if (fm.description.length > 1024)
      problems.push(
        `${at}description is ${fm.description.length} chars (max 1024)`,
      );
    const lines = md.split("\n").length;
    if (lines > cfg.render.maxSkillLines)
      problems.push(
        `${at}SKILL.md has ${lines} lines (max ${cfg.render.maxSkillLines}); move detail into references/`,
      );
  }
  // Existing files are only deleted inside the skill the proposal is about.
  for (const f of files)
    if (
      f.content === null &&
      !(target.skillDir && f.path.startsWith(`${target.skillDir}/`))
    )
      problems.push(`${f.path} must not be deleted`);
  // Blocks another tool generates and owns (<!-- BEGIN x --> … <!-- END x -->) stay as they are.
  for (const f of files) {
    const old = base.get(f.path);
    if (old === undefined || f.content === null) continue;
    for (const m of old.matchAll(GENERATED_BLOCK))
      if (!f.content.includes(m[0]))
        problems.push(
          `${f.path}: the generated block "${m[1]!.trim()}" changed; leave marked blocks alone`,
        );
  }
  if (
    target.pointer &&
    target.doc &&
    target.agentsMd &&
    !(after.get(target.agentsMd) ?? "").includes(target.doc)
  )
    problems.push(
      `${target.agentsMd} doesn't mention ${target.doc}; the change must point to it`,
    );
  // What the draft adds, not what the file already had: a document may legitimately show a
  // placeholder or an example key, and that must not block every later change to it.
  for (const f of files) {
    if (f.content === null) continue;
    const had = new Set((base.get(f.path) ?? "").split("\n"));
    const added = f.content
      .split("\n")
      .filter((l) => !had.has(l))
      .join("\n");
    if (containsSecrets(added))
      problems.push(`${f.path} looks like it contains a secret`);
    if (added.includes("[REDACTED"))
      problems.push(`${f.path} contains a [REDACTED] placeholder`);
  }
  problems.push(...privateProblems(draftPrivateHits(files, base, target, cfg)));
  return problems;
}

/** Private terms the draft would add, when its target is a public repo (see privacy.ts). */
export function draftPrivateHits(
  files: DraftFile[],
  base: Map<string, string>,
  target: RenderTarget,
  cfg: Config,
) {
  return privateHits(files, target.root, cfg, (p) => base.get(p));
}

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { Config } from "../config.ts";
import type { DraftFile } from "../state/proposals.ts";

/**
 * The private-terms gate. Some repositories are published (config.privacy.publicRepos), and
 * some words must never end up in them (config.privacy.privateTerms): names of internal
 * tools, hosts, a work e-mail. Knowledge about such a repo often mentions them, and a rule
 * like "never mention X here" can't be written down in that repo without breaking itself.
 *
 * The gate is keyword-based and has no model in it: a draft, revise, edit or accept that
 * would ADD a listed term to a file of a public repo is refused. Lines the file already
 * had are not checked, so existing text never blocks an unrelated change.
 */

type PrivacyConfig = Pick<Config, "privacy">;

export interface PrivateHit {
  path: string;
  /** 1-based line in the drafted file; 0 = the path itself. */
  line: number;
  term: string;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Is `root` one of the public repos, or inside one? */
export function isPublicRepo(root: string, cfg: PrivacyConfig): boolean {
  const r = real(root);
  return cfg.privacy.publicRepos.some((p) => {
    const q = real(p);
    return r === q || r.startsWith(q.endsWith(sep) ? q : q + sep);
  });
}

function matcher(term: string): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/.exec(term);
  if (m) return new RegExp(m[1]!, m[2]!.replace(/[gy]/g, ""));
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** The private terms `text` contains. */
export function privateTermsIn(text: string, cfg: PrivacyConfig): string[] {
  return cfg.privacy.privateTerms.filter((t) => matcher(t).test(text));
}

/**
 * Private terms the files would add to `root`, when it is a public repo. `before(path)` is
 * the file the change lands on (undefined: a new file); only lines it doesn't have count.
 */
export function privateHits(
  files: Pick<DraftFile, "path" | "content">[],
  root: string,
  cfg: PrivacyConfig,
  before: (path: string) => string | null | undefined,
): PrivateHit[] {
  if (!cfg.privacy.privateTerms.length || !isPublicRepo(root, cfg)) return [];
  const terms = cfg.privacy.privateTerms.map((t) => ({ t, re: matcher(t) }));
  const out: PrivateHit[] = [];
  for (const f of files) {
    if (f.content === null) continue;
    const old = before(f.path);
    if (old == null)
      for (const { t, re } of terms)
        if (re.test(f.path)) out.push({ path: f.path, line: 0, term: t });
    const had = new Set((old ?? "").split("\n"));
    f.content.split("\n").forEach((text, i) => {
      if (had.has(text)) return;
      for (const { t, re } of terms)
        if (re.test(text)) out.push({ path: f.path, line: i + 1, term: t });
    });
  }
  return out;
}

/** One readable line per file. */
export function privateProblems(hits: PrivateHit[]): string[] {
  const byPath = new Map<string, PrivateHit[]>();
  for (const h of hits) byPath.set(h.path, [...(byPath.get(h.path) ?? []), h]);
  return [...byPath].map(([path, hs]) => {
    const terms = [...new Set(hs.map((h) => h.term))];
    const lines = [...new Set(hs.map((h) => h.line))].filter((l) => l > 0);
    return `${path} adds private term(s) ${terms.map((t) => JSON.stringify(t)).join(", ")} to a public repository${lines.length ? ` (line ${lines.slice(0, 12).join(", ")}${lines.length > 12 ? ", …" : ""})` : " (in its path)"}`;
  });
}

/** Instructions for the drafter's one retry. */
export function privateRetryPrompt(hits: PrivateHit[]): string {
  return [
    "Verification: this repository is public, and your draft adds terms that must never appear in it:",
    ...privateProblems(hits).map((p) => `  - ${p}`),
    "",
    "Fix the draft now:",
    "- Remove every one of those terms from the files you wrote, in any spelling. Don't paraphrase them into something that still identifies the same private thing.",
    "- A rule that can't be stated without them is left out of the files entirely. Say in report_draft's summary, in general words, what you left out.",
    "- Knowledge that stands without them stays, in generic wording.",
    "Then call report_draft again.",
  ].join("\n");
}

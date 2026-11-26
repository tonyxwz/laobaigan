import { existsSync, type Stats } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type DraftFile, hashContent } from "../state/proposals.ts";
import type { RenderTarget } from "./target.ts";

/** The scratch copy a draft is written in, and what changed in it. */

/** Never part of a draft: a documentation site's dependencies, a nested repository. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** All files under `rel` (a file or a directory) inside `root`, relative to `root`. */
async function filesUnder(root: string, rel: string): Promise<string[]> {
  const abs = join(root, rel);
  let st: Stats;
  try {
    st = await stat(abs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [rel];
  const out: string[] = [];
  for (const e of await readdir(abs))
    if (!SKIP_DIRS.has(e)) out.push(...(await filesUnder(root, join(rel, e))));
  return out.sort();
}

/** Current content of every text file under the writable paths (binary files are left alone). */
export async function snapshot(
  root: string,
  writable: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const w of writable)
    for (const f of await filesUnder(root, w.replace(/\/$/, ""))) {
      const text = await readFile(join(root, f), "utf8");
      if (!text.includes("\0")) out.set(f, text);
    }
  return out;
}

/** A scratch dir holding a copy of the writable paths (symlinks resolved; dependencies skipped). */
export async function makeScratch(target: RenderTarget): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lbg-draft-"));
  for (const w of target.writable) {
    const rel = w.replace(/\/$/, "");
    const from = join(target.root, rel);
    if (!existsSync(from)) continue;
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await cp(from, join(dir, rel), {
      recursive: true,
      dereference: true,
      filter: (src) => !SKIP_DIRS.has(basename(src)),
    });
  }
  return dir;
}

/** Files that differ between the original snapshot and the scratch dir. */
export async function diffSnapshot(
  base: Map<string, string>,
  scratch: string,
  writable: string[],
): Promise<DraftFile[]> {
  const after = await snapshot(scratch, writable);
  const out: DraftFile[] = [];
  for (const [path, content] of after) {
    const old = base.get(path);
    if (old !== content)
      out.push({
        path,
        baseHash: old === undefined ? null : hashContent(old),
        content,
        baseContent: old ?? null,
      });
  }
  for (const [path, old] of base)
    if (!after.has(path))
      out.push({
        path,
        baseHash: hashContent(old),
        content: null,
        baseContent: old,
      });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

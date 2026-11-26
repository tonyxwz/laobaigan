import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  type DraftFile,
  hashContent,
  type ProposalRow,
} from "../../state/proposals.ts";

/** How a proposal looks: its diff against the files on disk, and the diff of a hand edit. */

/** The file as it is on disk now; null when it is absent. */
export async function currentFile(
  root: string,
  path: string,
): Promise<string | null> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return null;
  }
}

/** Diff of the AI's draft (`before`) against my version (`after`); empty when nothing changed. */
export function editDiff(before: DraftFile[], after: DraftFile[]): string {
  const old = new Map(before.map((f) => [f.path, f.content]));
  const now = new Map(after.map((f) => [f.path, f.content]));
  const paths = [...new Set([...old.keys(), ...now.keys()])].sort();
  return paths
    .map((p) =>
      fileDiff(
        p,
        old.has(p)
          ? (old.get(p) ?? null)
          : (after.find((f) => f.path === p)?.baseContent ?? null),
        now.has(p)
          ? (now.get(p) ?? null)
          : (before.find((f) => f.path === p)?.baseContent ?? null),
      ),
    )
    .filter(Boolean)
    .join("\n");
}

/** One file as a git-style diff (null = absent). Empty when there's no change. */
function fileDiff(
  path: string,
  oldText: string | null,
  newText: string | null,
): string {
  if (oldText === null && newText === null) return "";
  if (
    (oldText ?? "") === (newText ?? "") &&
    (oldText === null) === (newText === null)
  )
    return "";
  const header = [`diff --git a/${path} b/${path}`];
  if (oldText === null)
    header.push("new file mode 100644", "--- /dev/null", `+++ b/${path}`);
  else if (newText === null)
    header.push("deleted file mode 100644", `--- a/${path}`, "+++ /dev/null");
  else header.push(`--- a/${path}`, `+++ b/${path}`);
  const body = createTwoFilesPatch(
    "a",
    "b",
    oldText ?? "",
    newText ?? "",
    "",
    "",
    { context: 3 },
  );
  const at = body.indexOf("\n@@");
  return at < 0 ? "" : `${header.join("\n")}\n${body.slice(at + 1)}`;
}

export interface FileView {
  path: string;
  /** The file on disk differs from what the draft was based on. */
  stale: boolean;
  /** What the diff is against: the draft's base (stale with a stored base), or the file on disk now. */
  against: "draft-base" | "current";
  /** Stale files: the changes made on disk since the draft (empty if unknown). */
  onDisk: string;
}

/**
 * The proposal's change, one git-style diff. For a file that changed on disk since the draft
 * (stale), it's the draft's own change against the version it was drafted from, so it doesn't
 * look like the draft reverts newer edits; `revise` rebases it onto the current file. Drafts
 * stored before lbg kept originals fall back to the current file.
 */
export async function proposalView(
  p: ProposalRow,
): Promise<{ diff: string; files: FileView[] }> {
  const parts: string[] = [];
  const files: FileView[] = [];
  for (const f of p.files) {
    const now = await currentFile(p.targetRoot, f.path);
    const stale = (now === null ? null : hashContent(now)) !== f.baseHash;
    const haveBase = f.baseContent !== undefined;
    const from = stale && haveBase ? f.baseContent! : now;
    parts.push(fileDiff(f.path, from, f.content));
    files.push({
      path: f.path,
      stale,
      against: stale && haveBase ? "draft-base" : "current",
      onDisk: stale && haveBase ? fileDiff(f.path, f.baseContent!, now) : "",
    });
  }
  return { diff: parts.join(""), files };
}

export async function proposalDiff(p: ProposalRow): Promise<string> {
  return (await proposalView(p)).diff;
}

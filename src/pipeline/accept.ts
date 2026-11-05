import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Config } from "../config.ts";
import { hashContent, Proposals, type DraftFile, type ProposalRow } from "../state/proposals.ts";
import type { NuggetRow } from "../state/db.ts";
import { subtreeNuggets, type Tree } from "../state/tree.ts";
import { isAllowed } from "./render.ts";
import { syncTree } from "./sync.ts";

/**
 * Accept / reject a proposal. Accepting writes the drafted files into the target
 * (the global skills dir, or the repo) and nothing else: no git. Commit it yourself.
 */

async function current(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return null;
  }
}

export interface Conflict {
  path: string;
  reason: string;
}

/** Files that changed on disk since the draft was made. */
export async function conflicts(p: ProposalRow): Promise<Conflict[]> {
  const out: Conflict[] = [];
  for (const f of p.files) {
    const now = await current(p.targetRoot, f.path);
    const nowHash = now === null ? null : hashContent(now);
    if (nowHash !== f.baseHash) {
      out.push({ path: f.path, reason: f.baseHash === null ? "now exists (it didn't when drafted)" : now === null ? "was deleted since the draft" : "changed since the draft" });
    }
  }
  return out;
}

function checkPath(p: ProposalRow, f: DraftFile): void {
  if (isAbsolute(f.path) || f.path.split(/[\\/]/).includes("..") || !isAllowed(f.path, p.writable)) {
    throw new Error(`Proposal #${p.id}: refusing to write ${f.path} (outside ${p.writable.join(", ")})`);
  }
}

export interface AcceptResult {
  written: string[];
  deleted: string[];
  /** Absolute paths, for a `git add` / commit. */
  paths: string[];
  commitMessage: string;
}

/**
 * Write the proposal's files into the target, mark it accepted, and sync the tree so
 * the skill is live right away (its evidence counts as absorbed).
 */
export async function acceptProposal(tree: Tree, cfg: Config, id: number, opts: { force?: boolean } = {}): Promise<AcceptResult> {
  const props = new Proposals(tree.db);
  const p = props.assertFree(id); // before writing anything
  if (p.status !== "open") throw new Error(`Proposal #${id} is ${p.status}; only open proposals can be accepted`);
  for (const f of p.files) checkPath(p, f);
  const c = await conflicts(p);
  if (c.length && !opts.force) {
    throw new Error(
      `Proposal #${id} is stale: ${c.map((x) => `${x.path} ${x.reason}`).join("; ")}. Redraft it with lbg proposal revise ${id}, or use --force to overwrite.`,
    );
  }
  const res: AcceptResult = { written: [], deleted: [], paths: [], commitMessage: commitMessageFor(tree, p) };
  for (const f of p.files) {
    const abs = join(p.targetRoot, f.path);
    if (f.content === null) {
      await rm(abs, { force: true });
      res.deleted.push(f.path);
    } else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content);
      res.written.push(f.path);
    }
    res.paths.push(abs);
  }
  props.markAccepted(id);
  try {
    await syncTree(tree, { skillsDir: cfg.skillsDir, declared: cfg.topics });
  } catch (e) {
    // The files are written and the proposal is accepted; only the tree is behind.
    throw new Error(
      `Proposal #${id} is accepted and its files are written (${res.paths.join(", ")}), but updating lbg's tree failed: ` +
        `${e instanceof Error ? e.message : String(e)}. Run lbg tree sync to retry.`,
    );
  }
  // The files contain the evidence up to when the draft was made, not up to now: date the
  // live skill to the draft, so evidence that arrived while the proposal waited still counts
  // as new (and can earn an update). If sync couldn't match the node to a file (e.g. a new
  // AGENTS.md section under its own heading), it's published either way.
  const node = tree.getNode(p.nodeId);
  if (node) tree.updateNode(p.nodeId, { renderedAt: p.draftedAt, summaryDirty: false, ...(node.origin !== "file" ? { origin: "file" as const } : {}) });
  return res;
}

/** Evidence attached to the proposal's skill after its draft was made: not in the files yet. */
export function newSinceDraft(tree: Tree, p: ProposalRow): NuggetRow[] {
  const skill = tree.subtree(p.nodeId);
  if (!skill) return [];
  const t = p.draftedAt.getTime();
  const used = new Set(p.nuggetIds);
  return subtreeNuggets(skill).filter((n) => !used.has(n.id) && (n.attachedAt?.getTime() ?? 0) > t);
}

export interface CommitTarget {
  paths: string[];
  commitMessage: string;
  /** Files that no longer contain what the proposal wrote (edited or committed differently since). */
  changedSince: string[];
}

/**
 * What to commit for an already-accepted proposal (e.g. accepted without --commit): its
 * files as absolute paths, the suggested message, and which files changed since.
 */
export async function commitTargetFor(tree: Tree, p: ProposalRow): Promise<CommitTarget> {
  if (p.status !== "accepted") throw new Error(`Proposal #${p.id} is ${p.status}; only accepted proposals have files to commit`);
  const changedSince: string[] = [];
  for (const f of p.files) {
    const now = await current(p.targetRoot, f.path);
    if (now !== f.content) changedSince.push(f.path);
  }
  return { paths: p.files.map((f) => join(p.targetRoot, f.path)), commitMessage: commitMessageFor(tree, p), changedSince };
}

export function rejectProposal(tree: Tree, id: number, reason?: string): void {
  new Proposals(tree.db).markRejected(id, reason);
}

/** One file as a git-style diff (null = absent). Empty when there's no change. */
function fileDiff(path: string, oldText: string | null, newText: string | null): string {
  if (oldText === null && newText === null) return "";
  if ((oldText ?? "") === (newText ?? "") && (oldText === null) === (newText === null)) return "";
  const header = [`diff --git a/${path} b/${path}`];
  if (oldText === null) header.push("new file mode 100644", "--- /dev/null", `+++ b/${path}`);
  else if (newText === null) header.push("deleted file mode 100644", `--- a/${path}`, "+++ /dev/null");
  else header.push(`--- a/${path}`, `+++ b/${path}`);
  const body = createTwoFilesPatch("a", "b", oldText ?? "", newText ?? "", "", "", { context: 3 });
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
export async function proposalView(p: ProposalRow): Promise<{ diff: string; files: FileView[] }> {
  const parts: string[] = [];
  const files: FileView[] = [];
  for (const f of p.files) {
    const now = await current(p.targetRoot, f.path);
    const stale = (now === null ? null : hashContent(now)) !== f.baseHash;
    const haveBase = f.baseContent !== undefined;
    const from = stale && haveBase ? f.baseContent! : now;
    parts.push(fileDiff(f.path, from, f.content));
    files.push({ path: f.path, stale, against: stale && haveBase ? "draft-base" : "current", onDisk: stale && haveBase ? fileDiff(f.path, f.baseContent!, now) : "" });
  }
  return { diff: parts.join(""), files };
}

export async function proposalDiff(p: ProposalRow): Promise<string> {
  return (await proposalView(p)).diff;
}

/** A commit message you can use; lbg itself never commits. */
export function commitMessageFor(tree: Tree, p: ProposalRow): string {
  const verb = p.kind === "new" ? "add" : p.kind === "update" ? "update" : "fix description of";
  const nuggets = tree.db.nuggets().filter((n) => p.nuggetIds.includes(n.id));
  const agents = [...new Set(nuggets.map((n) => n.agent))].sort();
  return [
    `skills: ${verb} ${p.skillName ?? `#${p.nodeId}`}`,
    "",
    ...(p.summary ? [p.summary.trim(), ""] : []),
    `From ${nuggets.length} explanation(s) in ${p.sessions} session(s) (${agents.join(", ")}), drafted by laobaigan.`,
  ].join("\n");
}

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Config } from "../config.ts";
import { hashContent, Proposals, type DraftFile, type ProposalRow } from "../state/proposals.ts";
import type { Tree } from "../state/tree.ts";
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
  const p = props.mustGet(id);
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
  await syncTree(tree, { skillsDir: cfg.skillsDir, declared: cfg.topics });
  // A target sync can't match (e.g. a new AGENTS.md section under its own heading): the
  // node's knowledge is published either way, so only evidence from now on counts.
  const node = tree.getNode(p.nodeId);
  if (node && node.origin !== "file") tree.updateNode(p.nodeId, { origin: "file", renderedAt: new Date(), summaryDirty: false });
  return res;
}

export function rejectProposal(tree: Tree, id: number, reason?: string): void {
  new Proposals(tree.db).markRejected(id, reason);
}

/** Unified diff of the proposal against what's on disk now. */
export async function proposalDiff(p: ProposalRow): Promise<string> {
  const parts: string[] = [];
  for (const f of p.files) {
    const now = (await current(p.targetRoot, f.path)) ?? "";
    parts.push(createTwoFilesPatch(`a/${f.path}`, f.content === null ? "/dev/null" : `b/${f.path}`, now, f.content ?? "", "", "", { context: 3 }).replace(/^=+\n/, ""));
  }
  return parts.join("\n");
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

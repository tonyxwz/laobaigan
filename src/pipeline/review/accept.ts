import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Config } from "../../config.ts";
import type { NuggetRow } from "../../state/db.ts";
import {
  type DraftFile,
  hashContent,
  type ProposalRow,
  Proposals,
} from "../../state/proposals.ts";
import { subtreeNuggets, type Tree } from "../../state/tree.ts";
import {
  type PrivateHit,
  privateHits,
  privateProblems,
} from "../common/privacy.ts";
import { isAllowed } from "../common/target.ts";
import { syncTree } from "../tree/sync.ts";
import { commitMessageFor } from "./commit.ts";
import { currentFile } from "./proposal-view.ts";

/**
 * Accept a proposal: write the drafted files into the target (the global skills dir, or
 * the repo) and nothing else: no git. Commit it yourself.
 */

export interface Conflict {
  path: string;
  reason: string;
}

/** Files that changed on disk since the draft was made. */
export async function conflicts(p: ProposalRow): Promise<Conflict[]> {
  const out: Conflict[] = [];
  for (const f of p.files) {
    const now = await currentFile(p.targetRoot, f.path);
    const nowHash = now === null ? null : hashContent(now);
    if (nowHash !== f.baseHash) {
      out.push({
        path: f.path,
        reason:
          f.baseHash === null
            ? "now exists (it didn't when drafted)"
            : now === null
              ? "was deleted since the draft"
              : "changed since the draft",
      });
    }
  }
  return out;
}

/** Private terms accepting the proposal would add to a public repo (against the files on disk now). */
export async function privateHitsFor(
  p: ProposalRow,
  cfg: Pick<Config, "privacy">,
): Promise<PrivateHit[]> {
  if (p.scope !== "repo") return [];
  const now = new Map<string, string | null>();
  for (const f of p.files)
    now.set(f.path, await currentFile(p.targetRoot, f.path));
  return privateHits(p.files, p.targetRoot, cfg, (path) => now.get(path));
}

function checkPath(p: ProposalRow, f: DraftFile): void {
  if (
    isAbsolute(f.path) ||
    f.path.split(/[\\/]/).includes("..") ||
    !isAllowed(f.path, p.writable)
  ) {
    throw new Error(
      `Proposal #${p.id}: refusing to write ${f.path} (outside ${p.writable.join(", ")})`,
    );
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
export async function acceptProposal(
  tree: Tree,
  cfg: Config,
  id: number,
  opts: { force?: boolean } = {},
): Promise<AcceptResult> {
  const props = new Proposals(tree.db);
  const p = props.assertFree(id); // before writing anything
  if (p.status !== "open")
    throw new Error(
      `Proposal #${id} is ${p.status}; only open proposals can be accepted`,
    );
  for (const f of p.files) checkPath(p, f);
  const c = await conflicts(p);
  if (c.length && !opts.force) {
    throw new Error(
      `Proposal #${id} is stale: ${c.map((x) => `${x.path} ${x.reason}`).join("; ")}. Redraft it with lbg proposal revise ${id}, or use --force to overwrite.`,
    );
  }
  // Not something --force overrides: revise or edit the draft, or change the config.
  const priv = await privateHitsFor(p, cfg);
  if (priv.length) {
    throw new Error(
      `Proposal #${id} is refused: ${privateProblems(priv).join("; ")}. ` +
        `Take them out with lbg proposal revise ${id} or lbg proposal edit ${id} (privacy.privateTerms in the config lists the terms).`,
    );
  }
  const res: AcceptResult = {
    written: [],
    deleted: [],
    paths: [],
    commitMessage: commitMessageFor(tree, p, cfg),
  };
  // A repo draft may also touch files that other live nodes mirror (a pointer in AGENTS.md,
  // a line in another document). Sync would then date those nodes to now and count their
  // waiting evidence as absorbed, though this draft never saw it. Remember their dates.
  const dated = new Map(
    tree
      .trees()
      .flatMap((r) => r.children)
      .filter((n) => n.id !== p.nodeId && n.origin === "file" && n.renderedAt)
      .map((n) => [n.id, n] as const),
  );
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
    await syncTree(tree, {
      skillsDir: cfg.skillsDir,
      declared: cfg.topics,
      repoDocs: cfg.repoDocs,
    });
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
  for (const [nodeId, before] of dated) {
    const now = tree.getNode(nodeId);
    const src = (before.sourcePath ?? "").replace(/#.*$/, "");
    const own = src.endsWith("/SKILL.md") ? `${dirname(src)}/` : src;
    const touched = res.paths.some((w) =>
      own.endsWith("/") ? w.startsWith(own) : w === own,
    );
    if (
      now &&
      touched &&
      now.renderedAt?.getTime() !== before.renderedAt?.getTime()
    )
      tree.updateNode(nodeId, { renderedAt: before.renderedAt });
  }
  const node = tree.getNode(p.nodeId);
  if (node)
    tree.updateNode(p.nodeId, {
      renderedAt: p.draftedAt,
      summaryDirty: false,
      ...(node.origin !== "file" ? { origin: "file" as const } : {}),
    });
  return res;
}

/** Evidence attached to the proposal's skill after its draft was made: not in the files yet. */
export function newSinceDraft(tree: Tree, p: ProposalRow): NuggetRow[] {
  const skill = tree.subtree(p.nodeId);
  if (!skill) return [];
  const t = p.draftedAt.getTime();
  const used = new Set(p.nuggetIds);
  return subtreeNuggets(skill).filter(
    (n) => !used.has(n.id) && (n.attachedAt?.getTime() ?? 0) > t,
  );
}

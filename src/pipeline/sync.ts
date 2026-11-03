import type { DeclaredTopic } from "../config.ts";
import type { ParsedAgentsMd, ParsedSection, ParsedSkill } from "../skills/parse.ts";
import { parseRepo, parseSkillsDir } from "../skills/parse.ts";
import { subtreeNuggets, Tree, type NodeRow, type Scope, type TreeNode } from "../state/tree.ts";

/**
 * Keep the tree in sync with files. Files are the source of truth for `file`
 * nodes: my hand edits and merged proposals show up here with no other sync logic.
 *
 * Matching, in order: same source path → a latent/declared node with the same name
 * (skills) or title (sections), which is how a merged proposal becomes live → new node.
 * Nuggets never get lost: when a file node disappears, its nuggets move up to the
 * parent (sections) or the node turns latent (skills that hold evidence).
 */

/** "dotfiles-management" → "Dotfiles management" */
export function titleFromName(name: string): string {
  const t = name.replace(/-/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export interface SyncReport {
  created: string[];
  updated: string[];
  adopted: string[];
  removed: string[];
  unchanged: number;
}

const emptyReport = (): SyncReport => ({ created: [], updated: [], adopted: [], removed: [], unchanged: 0 });

function merge(a: SyncReport, b: SyncReport): SyncReport {
  return {
    created: [...a.created, ...b.created],
    updated: [...a.updated, ...b.updated],
    adopted: [...a.adopted, ...b.adopted],
    removed: [...a.removed, ...b.removed],
    unchanged: a.unchanged + b.unchanged,
  };
}

/** Sync the parsed skills of one scope under its root (sections included). */
export function syncSkills(tree: Tree, scope: Scope, parsed: ParsedSkill[], opts: { owns?: (n: TreeNode) => boolean } = {}): SyncReport {
  const report = emptyReport();
  // Which file nodes this sync is responsible for (e.g. only .agents/skills, not AGENTS.md sections).
  const owns = opts.owns ?? (() => true);
  tree.db.tx(() => {
    const rootId = tree.ensureRoot(scope);
    const root = tree.subtree(rootId)!;
    const byPath = new Map(root.children.filter((c) => c.sourcePath).map((c) => [c.sourcePath!, c]));
    const parsedPaths = new Set(parsed.map((p) => p.sourcePath));
    // A node can be taken over by name if it isn't a file node, or its file is gone (moved skills dir).
    const adoptable = (c: TreeNode) => c.origin !== "file" || (owns(c) && !parsedPaths.has(c.sourcePath ?? ""));
    const seen = new Set<number>();

    for (const p of parsed) {
      let node = byPath.get(p.sourcePath);
      let adopted = false;
      if (!node) {
        node = root.children.find((c) => adoptable(c) && !seen.has(c.id) && (c.name ?? "") === p.name);
        adopted = !!node;
      }
      const fields = { name: p.name, title: p.title, description: p.description, summary: p.intro, origin: "file" as const, sourcePath: p.sourcePath };
      let id: number;
      if (!node) {
        id = tree.createNode(rootId, { ...fields, sourceHash: p.hash });
        tree.updateNode(id, { renderedAt: new Date(), summaryDirty: false });
        report.created.push(p.name);
      } else {
        id = node.id;
        if (adopted && node.origin === "file" && node.sourceHash === p.hash) {
          // Same file, new location (moved skills dir): not an edit, so evidence stays fresh.
          tree.updateNode(id, { sourcePath: p.sourcePath });
          report.adopted.push(p.name);
        } else if (adopted || node.sourceHash !== p.hash) {
          // Edited (by me, or a merged proposal): evidence so far counts as absorbed.
          // An adopted latent node (or a merged update) is now a live skill with no open proposal.
          tree.updateNode(id, { ...fields, sourceHash: p.hash, renderedAt: new Date(), summaryDirty: false, ...(adopted || node.status === "merged" ? { status: "open" as const } : {}) });
          (adopted ? report.adopted : report.updated).push(p.name);
        } else {
          report.unchanged++;
        }
      }
      seen.add(id);
      syncSections(tree, id, p.sections);
    }

    // File skills that are gone from disk.
    for (const c of root.children) {
      if (c.origin !== "file" || seen.has(c.id) || !owns(c)) continue;
      removeFileNode(tree, c);
      report.removed.push(c.name ?? c.title);
    }
    tree.pruneEmpty();
  });
  return report;
}

function syncSections(tree: Tree, skillId: number, sections: ParsedSection[]): void {
  const skill = tree.subtree(skillId)!;
  const byPath = new Map(skill.children.filter((c) => c.sourcePath).map((c) => [c.sourcePath!, c]));
  const parsedPaths = new Set(sections.map((s) => s.sourcePath));
  const seen = new Set<number>();
  for (const s of sections) {
    let node = byPath.get(s.sourcePath);
    if (!node) {
      node = skill.children.find(
        (c) => (c.origin !== "file" || !parsedPaths.has(c.sourcePath ?? "")) && !seen.has(c.id) && c.title.toLowerCase() === s.title.toLowerCase(),
      );
    }
    const fields = { title: s.title, description: s.description, summary: s.body, origin: "file" as const, sourcePath: s.sourcePath };
    if (!node) {
      const id = tree.createNode(skillId, { ...fields, sourceHash: s.hash });
      tree.updateNode(id, { summaryDirty: false });
      seen.add(id);
    } else {
      if (node.sourceHash !== s.hash || node.origin !== "file") tree.updateNode(node.id, { ...fields, sourceHash: s.hash, summaryDirty: false });
      seen.add(node.id);
    }
  }
  for (const c of skill.children) if (c.origin === "file" && !seen.has(c.id)) removeFileNode(tree, c);
  // Syncing children marks the skill dirty, but a file skill's summary is the file itself.
  tree.updateNode(skillId, { summaryDirty: false });
}

/** A file node vanished: keep its evidence. Sections hand nuggets to their parent; skills turn latent. */
function removeFileNode(tree: Tree, n: TreeNode): void {
  if (n.depth === 2) {
    for (const g of n.nuggets) tree.attachNugget(g.id, n.parentId!);
    tree.db.db.prepare("DELETE FROM node WHERE id = ?").run(n.id);
    return;
  }
  if (subtreeNuggets(n).length === 0) {
    for (const c of n.children) tree.db.db.prepare("DELETE FROM node WHERE id = ?").run(c.id);
    tree.db.db.prepare("DELETE FROM node WHERE id = ?").run(n.id);
    return;
  }
  for (const c of n.children) {
    if (c.origin !== "file") continue;
    if (c.nuggets.length) tree.db.db.prepare("UPDATE node SET origin = 'latent', source_path = NULL, source_hash = NULL WHERE id = ?").run(c.id);
    else tree.db.db.prepare("DELETE FROM node WHERE id = ?").run(c.id);
  }
  tree.db.db.prepare("UPDATE node SET origin = 'latent', source_path = NULL, source_hash = NULL, summary_dirty = 1 WHERE id = ?").run(n.id);
}

/** A repo's AGENTS.md: preamble on the root, "##" sections as depth-1 nodes. */
export function syncAgentsMd(tree: Tree, repo: string, md: ParsedAgentsMd | undefined): SyncReport {
  const scope: Scope = { scope: "repo", repo };
  const rootId = tree.ensureRoot(scope);
  if (md) tree.updateNode(rootId, { summary: md.preamble, sourcePath: md.path, sourceHash: md.hash });
  const isAgentsSection = (n: NodeRow) => !!n.sourcePath && /\/(AGENTS|CLAUDE)\.md#/.test(n.sourcePath);
  return syncSkills(tree, scope, md?.sections ?? [], { owns: isAgentsSection });
}

/**
 * Declared topics (config.topics) are pinned depth-1 nodes. A file skill with the
 * same name wins (it already exists); removed declarations turn latent.
 */
export function syncDeclared(tree: Tree, declared: DeclaredTopic[]): SyncReport {
  const report = emptyReport();
  tree.db.tx(() => {
    const wanted = new Set<number>();
    for (const d of declared) {
      const scope: Scope = { scope: d.scope ?? "global", ...(d.repo ? { repo: d.repo } : {}) };
      const rootId = tree.ensureRoot(scope);
      const existing = tree.children(rootId).find((c) => c.name === d.name);
      const title = d.title ?? titleFromName(d.name);
      if (!existing) {
        wanted.add(tree.createNode(rootId, { name: d.name, title, description: d.description, origin: "declared" }));
        report.created.push(d.name);
      } else {
        wanted.add(existing.id);
        if (existing.origin === "file") {
          report.unchanged++;
        } else if (existing.origin !== "declared" || existing.title !== title || existing.description !== d.description) {
          tree.updateNode(existing.id, { title, description: d.description, origin: "declared" });
          report.updated.push(d.name);
        } else {
          report.unchanged++;
        }
      }
    }
    for (const root of tree.trees()) {
      for (const c of root.children) {
        if (c.origin === "declared" && !wanted.has(c.id)) {
          tree.updateNode(c.id, { origin: "latent" });
          report.removed.push(c.name ?? c.title);
        }
      }
    }
    tree.pruneEmpty();
  });
  return report;
}

export interface SyncSources {
  /** The global skills directory (live, not a worktree). */
  skillsDir: string;
  declared: DeclaredTopic[];
}

/** Parse everything lbg mirrors and sync the tree: global skills, known repos, declared topics. */
export async function syncTree(tree: Tree, src: SyncSources): Promise<{ global: SyncReport; repos: Record<string, SyncReport>; declared: SyncReport }> {
  const global = syncSkills(tree, { scope: "global" }, await parseSkillsDir(src.skillsDir));
  const repos: Record<string, SyncReport> = {};
  const known = tree.trees().filter((r) => r.scope === "repo" && r.repo).map((r) => r.repo!);
  for (const repo of known) {
    const parsed = await parseRepo(repo);
    const isRepoSkill = (n: NodeRow) => !!n.sourcePath && n.sourcePath.includes("/.agents/skills/");
    repos[repo] = merge(
      syncAgentsMd(tree, repo, parsed.agentsMd),
      syncSkills(tree, { scope: "repo", repo }, parsed.skills, { owns: isRepoSkill }),
    );
  }
  const declared = syncDeclared(tree, src.declared);
  return { global, repos, declared };
}

import { subtreeNuggets, Tree, type NodeRow, type TreeNode } from "../state/tree.ts";

/**
 * Hand curation of the knowledge tree. Every edit locks what it touches, so
 * insert and rebalance never undo it: my edits win over automation.
 *
 * Live (file) nodes are the skill files themselves: their structure changes only
 * through proposals I merge, so these commands refuse to restructure them. They
 * can still *receive* latent sections and nuggets.
 */

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function node(tree: Tree, id: number): NodeRow {
  const n = tree.getNode(id);
  if (!n) throw new Error(`No node ${id}`);
  return n;
}

function sub(tree: Tree, id: number): TreeNode {
  const n = tree.subtree(id);
  if (!n) throw new Error(`No node ${id}`);
  return n;
}

/** Nodes in the proposal lifecycle can't be reshaped until it ends. */
function assertFree(n: NodeRow, what: string): void {
  if (n.status === "proposed") {
    throw new Error(`${what}: #${n.id} is ${n.status}; finish or reject its proposal first`);
  }
}

function assertNotFile(n: NodeRow, what: string): void {
  if (n.origin === "file") {
    throw new Error(`${what}: #${n.id} is a live skill file (${n.sourcePath ?? n.title}); change it through a proposal`);
  }
}

/** The skill (depth 1) a node belongs to. */
function skillOf(tree: Tree, n: NodeRow): NodeRow | undefined {
  return tree.path(n.id).find((p) => p.depth === 1);
}

/**
 * Merge skills: sections and body nuggets of each `from` skill move into `into`;
 * the emptied skills are removed. `from` skills must not be live files.
 */
export function mergeSkills(tree: Tree, into: number, from: number[]): { sections: number; nuggets: number } {
  const target = node(tree, into);
  if (target.depth !== 1) throw new Error(`#${into} is not a skill`);
  if (from.includes(into)) throw new Error("Can't merge a skill into itself");
  assertFree(target, "merge");
  const sources = from.map((id) => sub(tree, id));
  for (const s of sources) {
    if (s.depth !== 1) throw new Error(`#${s.id} is not a skill`);
    assertNotFile(s, "merge");
    assertFree(s, "merge");
  }
  let sections = 0;
  let nuggets = 0;
  tree.db.tx(() => {
    for (const s of sources) {
      for (const c of s.children) {
        tree.moveNode(c.id, into); // throws on scope mismatch → whole merge rolls back
        tree.updateNode(c.id, { locked: true });
        sections++;
      }
      for (const n of s.nuggets) {
        tree.attachNugget(n.id, into, { lock: true });
        nuggets++;
      }
      // Its evidence, covered marks and proposal history become the target's.
      tree.removeNode(s.id, into);
    }
    tree.updateNode(into, { locked: true });
  });
  return { sections, nuggets };
}

/** Split sections out of a skill into a new (latent, locked) skill. */
export function splitSkill(tree: Tree, skillId: number, sectionIds: number[], title?: string): number {
  const skill = sub(tree, skillId);
  if (skill.depth !== 1) throw new Error(`#${skillId} is not a skill`);
  assertFree(skill, "split");
  const picked = skill.children.filter((c) => sectionIds.includes(c.id));
  const missing = sectionIds.filter((id) => !picked.some((c) => c.id === id));
  if (missing.length) throw new Error(`Section(s) ${missing.join(", ")} are not in skill #${skillId}`);
  for (const c of picked) assertNotFile(c, "split");
  if (picked.length === skill.children.length && skill.nuggets.length === 0 && skill.origin !== "file") {
    throw new Error("A split must leave something behind; use rename instead");
  }
  let created = 0;
  tree.db.tx(() => {
    created = tree.createNode(skill.parentId!, { title: title ?? picked[0]!.title, locked: true });
    for (const c of picked) {
      tree.moveNode(c.id, created);
      tree.updateNode(c.id, { locked: true });
    }
    tree.updateNode(skillId, { locked: true });
  });
  return created;
}

/**
 * Move a node under another parent: a section to another skill, a section up to
 * the root (it becomes a skill), or a section-less skill into a skill (it becomes
 * a section). Same scope only; live nodes don't move.
 */
export function moveNode(tree: Tree, id: number, parentId: number): void {
  const n = node(tree, id);
  assertNotFile(n, "move");
  assertFree(n, "move");
  const owner = skillOf(tree, n);
  if (owner) assertFree(owner, "move");
  const dest = node(tree, parentId);
  const destSkill = dest.depth === 1 ? dest : undefined;
  if (destSkill) assertFree(destSkill, "move");
  tree.db.tx(() => {
    tree.moveNode(id, parentId);
    tree.updateNode(id, { locked: true });
    tree.pruneEmpty();
  });
}

/** Rename a node and/or set a skill's name. Live nodes take their names from their files. */
export function renameNode(tree: Tree, id: number, patch: { title?: string; name?: string }): void {
  const n = node(tree, id);
  assertNotFile(n, "rename");
  if (patch.name !== undefined) {
    if (n.depth !== 1) throw new Error("Only skills have names");
    if (!SKILL_NAME.test(patch.name) || patch.name.length > 64) {
      throw new Error(`Skill name must be lowercase letters, digits and single hyphens (≤ 64): ${patch.name}`);
    }
    const clash = tree.children(n.parentId!).find((c) => c.id !== id && c.name === patch.name);
    if (clash) throw new Error(`Skill #${clash.id} is already named ${patch.name}`);
  }
  tree.updateNode(id, { ...patch, locked: true });
}

/** Put one nugget somewhere else (any skill or section of the same scope). Emptied latent nodes are pruned. */
export function moveNugget(tree: Tree, nuggetId: number, nodeId: number): void {
  if (!tree.db.getNugget(nuggetId)) throw new Error(`No nugget ${nuggetId}`);
  tree.db.tx(() => {
    tree.attachNugget(nuggetId, nodeId, { lock: true });
    tree.setCovered(nuggetId, undefined);
    tree.pruneEmpty();
  });
}

/** Clear hand-curation locks on a node's subtree (and its nuggets' placements). */
export function unlockNode(tree: Tree, id: number): void {
  const n = sub(tree, id);
  tree.db.tx(() => {
    const walk = (x: TreeNode) => {
      tree.updateNode(x.id, { locked: false });
      x.children.forEach(walk);
    };
    walk(n);
    for (const m of subtreeNuggets(n)) tree.db.db.prepare("UPDATE nugget SET assignment_locked = 0 WHERE id = ?").run(m.id);
  });
}

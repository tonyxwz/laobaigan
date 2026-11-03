import type { DeclaredTopic } from "../config.ts";
import type { StateDb } from "../state/db.ts";

/** "dotfiles-management" → "Dotfiles management" */
export function titleFromName(name: string): string {
  const s = name.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface SyncResult {
  created: string[];
  updated: string[];
  undeclared: string[];
}

/**
 * Make the db's declared topics match config.topics (matched by name + scope/repo):
 * create missing ones, update title/description, and un-declare topics removed
 * from config (they stay as ordinary topics, or are deleted if empty).
 */
export function syncDeclaredTopics(db: StateDb, declared: DeclaredTopic[]): SyncResult {
  const res: SyncResult = { created: [], updated: [], undeclared: [] };
  db.tx(() => {
    const topics = db.topics();
    const keyOf = (x: { name?: string | undefined; scope: string; repo?: string | undefined }) =>
      `${x.scope}:${x.scope === "repo" ? (x.repo ?? "") : ""}:${x.name ?? ""}`;
    const wanted = new Map(declared.map((d) => [keyOf({ ...d, scope: d.scope ?? "global" }), d]));

    for (const [key, d] of wanted) {
      const title = d.title ?? titleFromName(d.name);
      const existing = topics.find((t) => t.name && keyOf(t) === key);
      if (!existing) {
        db.createTopic({
          name: d.name,
          title,
          description: d.description,
          scope: d.scope ?? "global",
          ...(d.repo ? { repo: d.repo } : {}),
          declared: true,
        });
        res.created.push(d.name);
      } else if (!existing.declared || existing.title !== title || existing.description !== d.description) {
        db.updateTopic(existing.id, { title, description: d.description, declared: true });
        res.updated.push(d.name);
      }
    }
    for (const t of topics) {
      if (t.declared && !wanted.has(keyOf(t))) {
        db.updateTopic(t.id, { declared: false });
        res.undeclared.push(t.name ?? t.title);
      }
    }
    db.deleteEmptyTopics();
  });
  return res;
}

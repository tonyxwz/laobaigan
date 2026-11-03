/**
 * Walk from `leafId` to the root via parent pointers and return the ids on
 * that path (the active branch). Guards against cycles and missing parents.
 */
export function activeBranch<T>(
  byId: Map<string, T>,
  leafId: string | undefined,
  parentOf: (e: T) => string | null | undefined,
): Set<string> {
  const out = new Set<string>();
  let id = leafId;
  while (id && !out.has(id)) {
    const e = byId.get(id);
    if (!e) break;
    out.add(id);
    id = parentOf(e) ?? undefined;
  }
  return out;
}

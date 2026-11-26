import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Expand a leading `~` and make the path absolute. */
export function expandHome(p: string, home: string = homedir()): string {
  const expanded =
    p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function realHome(home: string): string {
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

/**
 * Shorten a path under the home directory to `~/...`, for display. The home
 * directory may be a symlink, so its real path is matched as well.
 */
export function tildify(p: string, home: string = homedir()): string {
  for (const h of new Set([home, realHome(home)])) {
    if (!h) continue;
    if (p === h) return "~";
    if (p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`;
  }
  return p;
}

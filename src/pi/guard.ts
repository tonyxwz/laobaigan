import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * File tools for the drafting session, confined to one proposal worktree:
 *
 *   read, ls, find, grep  anywhere inside `root`
 *   write, edit           only inside `writable` (paths relative to `root`;
 *                         "dir/" = that directory and everything below it, otherwise one exact file)
 *
 * Every path is resolved through symlinks (nearest existing ancestor for new files),
 * so `../`, absolute paths, `~`, and symlinks pointing elsewhere are all caught.
 * `.git` is never writable. There is no bash.
 *
 * The tools keep pi's built-in names; a custom tool replaces the built-in of the
 * same name, so the model uses the tools it already knows.
 */
export interface FileGuard {
  /** The proposal worktree. */
  root: string;
  /** Writable paths relative to root: "dir/" for a subtree, or an exact file. */
  writable: string[];
}

export const GUARDED_TOOLS = ["read", "ls", "find", "grep", "write", "edit"] as const;
export type GuardedToolName = (typeof GUARDED_TOOLS)[number];

export class GuardError extends Error {}

/** Real path of `p`, or of its nearest existing ancestor joined with the rest (for files not yet created). */
async function realish(p: string): Promise<string> {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // A dangling symlink: refuse rather than follow it later.
      try {
        if ((await lstat(cur)).isSymbolicLink()) throw new GuardError(`${p}: dangling symlink`);
      } catch (e) {
        if (e instanceof GuardError) throw e;
      }
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cur = parent;
    }
  }
}

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

export interface ResolvedGuard {
  root: string;
  check(absPath: string, mode: "read" | "write"): Promise<string>;
  /** May `dir` be created? Yes if writable, or an ancestor (inside root) of a writable path. */
  checkMkdir(dir: string): Promise<string>;
}

export async function resolveGuard(g: FileGuard): Promise<ResolvedGuard> {
  const root = await realpath(g.root);
  const writable = await Promise.all(
    g.writable.map(async (w) => {
      if (isAbsolute(w) || w.split(/[\\/]/).includes("..")) throw new GuardError(`Writable path must be relative to the worktree: ${w}`);
      const dir = w.endsWith("/");
      const real = await realish(join(root, w));
      if (!inside(real, root)) throw new GuardError(`Writable path escapes the worktree: ${w}`);
      return { real, dir, label: w };
    }),
  );
  const show = (p: string) => (inside(p, root) ? relative(root, p) || "." : p);
  const guard: ResolvedGuard = {
    root,
    async check(absPath, mode) {
      const real = await realish(resolve(root, absPath));
      if (!inside(real, root)) throw new GuardError(`${absPath} is outside the worktree; only files in the worktree can be ${mode === "read" ? "read" : "changed"}.`);
      if (mode === "read") return real;
      const rel = relative(root, real);
      if (rel.split(sep).includes(".git")) throw new GuardError(`${show(real)}: .git is not writable.`);
      const ok = writable.some((w) => (w.dir ? inside(real, w.real) : real === w.real));
      if (!ok) {
        throw new GuardError(`${show(real)} is not writable in this proposal. Writable: ${writable.map((w) => w.label).join(", ") || "(nothing)"}.`);
      }
      return real;
    },
    async checkMkdir(dir) {
      try {
        return await guard.check(dir, "write");
      } catch (err) {
        if (!(err instanceof GuardError)) throw err;
        const real = await realish(resolve(root, dir));
        if (inside(real, root) && writable.some((w) => inside(w.real, real))) return real;
        throw err;
      }
    },
  };
  return guard;
}

/** Pi's file tools with guarded filesystem operations. */
export async function guardedToolDefinitions(guard: FileGuard, names: readonly GuardedToolName[] = GUARDED_TOOLS): Promise<ToolDefinition[]> {
  const g = await resolveGuard(guard);
  const cwd = g.root;
  const r = (p: string) => g.check(p, "read");
  const w = (p: string) => g.check(p, "write");
  const make: Record<GuardedToolName, () => ToolDefinition> = {
    read: () =>
      createReadToolDefinition(cwd, {
        operations: {
          readFile: async (p) => readFile(await r(p)),
          access: async (p) => access(await r(p), constants.R_OK),
        },
      }) as unknown as ToolDefinition,
    ls: () =>
      createLsToolDefinition(cwd, {
        operations: {
          exists: async (p) => {
            try {
              await stat(await r(p));
              return true;
            } catch (e) {
              if (e instanceof GuardError) throw e;
              return false;
            }
          },
          stat: async (p) => stat(await r(p)),
          readdir: async (p) => readdir(await r(p)),
        },
      }) as unknown as ToolDefinition,
    grep: () =>
      createGrepToolDefinition(cwd, {
        operations: {
          // Checked on the search path before ripgrep runs (ripgrep doesn't follow symlinks).
          isDirectory: async (p) => (await stat(await r(p))).isDirectory(),
          readFile: async (p) => readFile(await r(p), "utf8"),
        },
      }) as unknown as ToolDefinition,
    find: () => withPathCheck(createFindToolDefinition(cwd) as unknown as ToolDefinition, r),
    write: () =>
      createWriteToolDefinition(cwd, {
        operations: {
          writeFile: async (p, content) => writeFile(await w(p), content),
          mkdir: async (d) => void (await mkdir(await g.checkMkdir(d), { recursive: true })),
        },
      }) as unknown as ToolDefinition,
    edit: () =>
      createEditToolDefinition(cwd, {
        operations: {
          // Refuse up front, before the model spends effort on edits that can't be saved.
          access: async (p) => access(await w(p), constants.R_OK | constants.W_OK),
          readFile: async (p) => readFile(await w(p)),
          writeFile: async (p, content) => writeFile(await w(p), content),
        },
      }) as unknown as ToolDefinition,
  };
  return names.map((n) => make[n]());
}

/** Check a tool's `path` argument before it runs (for tools without pluggable path operations). */
function withPathCheck(def: ToolDefinition, check: (p: string) => Promise<string>): ToolDefinition {
  const execute = def.execute.bind(def);
  return {
    ...def,
    async execute(id, params, signal, onUpdate, ctx) {
      const p = (params as { path?: unknown }).path;
      await check(typeof p === "string" && p ? p : ".");
      return execute(id, params, signal, onUpdate, ctx);
    },
  };
}

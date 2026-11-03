import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Exclusive, pid-based lock file. A lock held by a dead process is taken over.
 * Returns a release function, or undefined if another live process holds it.
 */
export function acquireLock(path: string): (() => void) | undefined {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
      process.once("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (pid && isAlive(pid)) return undefined;
      unlinkSync(path); // stale: previous run crashed
    }
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

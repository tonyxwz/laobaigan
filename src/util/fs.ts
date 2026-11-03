import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

/** Parse a whole JSONL file; malformed lines are skipped. */
export async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partially-written trailing line or corrupt entry
    }
  }
  return out;
}

/** Parse only the first JSONL line, without reading the whole file. */
export async function readFirstJsonlLine(path: string): Promise<unknown | undefined> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    }
    return undefined;
  } finally {
    rl.close();
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Immediate subdirectories of `dir` (empty if `dir` is missing). */
export async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** Files directly in `dir` ending with `ext` (empty if `dir` is missing). */
export async function filesWithExt(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(ext)).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

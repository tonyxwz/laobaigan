import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acquireLock } from "../src/util/lock.ts";

describe("acquireLock", () => {
  it("is exclusive, releasable, and takes over stale locks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-lock-"));
    const path = join(dir, "run.lock");

    const release = acquireLock(path);
    expect(release).toBeTypeOf("function");
    expect(acquireLock(path)).toBeUndefined(); // held by us (alive)
    release!();
    expect(existsSync(path)).toBe(false);

    await writeFile(path, "999999999"); // dead pid
    const again = acquireLock(path);
    expect(again).toBeTypeOf("function");
    again!();
  });
});

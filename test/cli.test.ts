import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

async function lbg(...args: string[]) {
  const state = await mkdtemp(join(tmpdir(), "lbg-cli-"));
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, LBG_STATE_DIR: state, LBG_CONFIG: join(state, "none.json"), NODE_NO_WARNINGS: "1" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI: only lbg run calls models", () => {
  it.each([
    [["extract", "--session", "pi:x"], /lbg extract` is gone.*lbg run --dry-run --fresh --stages extract --session/],
    [["tree", "insert", "--all"], /lbg tree insert` is gone.*lbg run --stages sync,insert,score/],
    [["cluster"], /lbg cluster` is gone.*lbg run --stages sync,insert,score/],
    [["draft", "121"], /lbg draft` is gone.*lbg run --only <skill-id>/],
  ])("lbg %s points to lbg run", async (args, msg) => {
    const r = await lbg(...(args as string[]));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(msg);
  });

  it("refuses --fresh without --dry-run, and bad --only ids", async () => {
    expect((await lbg("run", "--fresh")).err).toMatch(/--fresh needs --dry-run/);
    expect((await lbg("run", "--only", "abc")).err).toMatch(/--only expects skill ids/);
  });

  it("a dry run with nothing to do leaves no state behind", async () => {
    const r = await lbg("run", "--dry-run", "--stages", "sync,score");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dry run: nothing kept/);
  });

  it("help no longer lists the removed commands", async () => {
    const r = await lbg("--help");
    expect(r.out).not.toMatch(/lbg (extract|draft|cluster|tree insert)\b/);
    expect(r.out).toMatch(/--only/);
  });
});

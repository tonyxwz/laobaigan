import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LAUNCHER = join(import.meta.dirname, "..", "bin", "lbg.js");

/** A package dir with bin/lbg.js and stand-ins for dist/cli.js and (optionally) src/cli.ts. */
async function pkg(withSrc: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lbg-launch-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "dist"));
  copyFileSync(LAUNCHER, join(dir, "bin", "lbg.js"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(join(dir, "dist", "cli.js"), 'console.log("dist", process.argv.slice(2).join(" "));');
  if (withSrc) {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "cli.ts"), 'const where: string = "src";\nconsole.log(where, process.argv.slice(2).join(" "));');
  }
  return dir;
}

const run = (bin: string, ...args: string[]) => execFileSync(process.execPath, [bin, ...args], { encoding: "utf8" }).trim();

describe("bin/lbg.js", () => {
  it("runs the TypeScript sources when present, passing arguments through", async () => {
    expect(run(join(await pkg(true), "bin", "lbg.js"), "status", "--json")).toBe("src status --json");
  });

  it("runs the build when the sources aren't shipped (published package)", async () => {
    expect(run(join(await pkg(false), "bin", "lbg.js"), "--help")).toBe("dist --help");
  });

  it("follows an npm-link style symlink through a node_modules path to the real checkout", async () => {
    const checkout = await pkg(true);
    const prefix = await mkdtemp(join(tmpdir(), "lbg-prefix-"));
    mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
    symlinkSync(checkout, join(prefix, "lib", "node_modules", "laobaigan"));
    // Node resolves the main module's symlinks, so type stripping isn't refused for node_modules.
    expect(run(join(prefix, "lib", "node_modules", "laobaigan", "bin", "lbg.js"), "x")).toBe("src x");
    rmSync(prefix, { recursive: true, force: true });
  });
});

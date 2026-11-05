import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSkillsDir, type FsProbe } from "../src/config.ts";
import { init, onPath, renderInit } from "../src/init.ts";
import type { SourceAdapter } from "../src/sources/types.ts";

/** A fake filesystem: path → "dir" | "symlink:<target>" (realpath follows it). */
function fsOf(entries: Record<string, string>): FsProbe {
  const real = (p: string): string => (entries[p]?.startsWith("symlink:") ? real(entries[p]!.slice(8)) : p);
  return { exists: (p) => p in entries, isSymlink: (p) => !!entries[p]?.startsWith("symlink:"), realpath: (p) => real(p) };
}

const H = "/home/u";
const PI = `${H}/.pi/agent/skills`;
const CLAUDE = `${H}/.claude/skills`;
const OC = `${H}/.config/opencode/skills`;

describe("detectSkillsDir", () => {
  it("picks pi's, then Claude's, then opencode's", () => {
    expect(detectSkillsDir(H, fsOf({ [PI]: "dir", [CLAUDE]: "dir" }))).toBe(PI);
    expect(detectSkillsDir(H, fsOf({ [CLAUDE]: "dir" }))).toBe(CLAUDE); // only ~/.claude
    expect(detectSkillsDir(H, fsOf({ [OC]: "dir" }))).toBe(OC);
    expect(detectSkillsDir(H, fsOf({}))).toBe(PI); // nothing yet
  });

  it("uses the real directory of a shared, symlinked setup, as written", () => {
    // this host: pi and claude link to opencode's dir
    const shared = fsOf({ [PI]: `symlink:${OC}`, [CLAUDE]: `symlink:${OC}`, [OC]: "dir" });
    expect(detectSkillsDir(H, shared)).toBe(OC);
    // a symlink to somewhere that isn't a candidate: follow it
    expect(detectSkillsDir(H, fsOf({ [PI]: "symlink:/data/skills", "/data/skills": "dir" }))).toBe("/data/skills");
  });
});

describe("lbg init", () => {
  const adapters = (available: Record<string, boolean>): SourceAdapter[] =>
    Object.entries(available).map(([agent, ok]) => ({ agent, available: async () => ok }) as unknown as SourceAdapter);

  it("writes a starter config once, with the detected skills dir", async () => {
    const h = await mkdtemp(join(tmpdir(), "lbg-home-"));
    await mkdir(join(h, ".claude", "skills"), { recursive: true });
    const configPath = join(h, ".config", "laobaigan", "config.json");
    const r = await init({ adapters: adapters({ claude: true, pi: false }), piDefaults: () => ({}), configPath, home: h });
    expect(r).toMatchObject({ config: "created", skillsDir: join(h, ".claude", "skills") });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ skillsDir: "~/.claude/skills" });
    const text = renderInit(r, h);
    expect(text).toContain("✓ claude");
    expect(text).toContain("· pi");
    expect(text).toMatch(/pi has no default model yet/);

    await writeFile(configPath, '{"skillsDir": "~/mine"}\n');
    const again = await init({ adapters: adapters({}), piDefaults: () => ({ provider: "p", model: "m" }), configPath, home: h });
    expect(again.config).toBe("kept");
    expect(readFileSync(configPath, "utf8")).toBe('{"skillsDir": "~/mine"}\n');
    expect(renderInit(again, h)).toContain("model: p/m");
    expect(renderInit(again, h)).toContain("No agent sessions found");
  });

  it("finds programs on PATH", async () => {
    const d = await mkdtemp(join(tmpdir(), "lbg-bin-"));
    await writeFile(join(d, "pi"), "");
    expect(onPath("pi", `/nonexistent:${d}`)).toBe(join(d, "pi"));
    expect(onPath("pi", "/nonexistent")).toBeUndefined();
  });
});

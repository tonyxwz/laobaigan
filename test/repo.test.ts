import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isPackageWorkspace, resolveRepo } from "../src/skills/repo.ts";

let ws: string;
let solo: string;
let plain: string;

beforeAll(async () => {
  // realpath: macOS-style /tmp symlinks would make git's top-level differ from our path
  const root = realpathSync(await mkdtemp(join(tmpdir(), "lbg-ws-")));
  ws = join(root, "bench");
  for (const p of ["Datasets", "Handbook"]) {
    await mkdir(join(ws, "src", p), { recursive: true });
    execFileSync("git", ["init", "-q", join(ws, "src", p)]);
  }
  await writeFile(join(ws, "packageInfo"), "packages = {};\n");
  solo = join(root, "solo");
  await mkdir(join(solo, "src", "OnlyPkg"), { recursive: true });
  execFileSync("git", ["init", "-q", join(solo, "src", "OnlyPkg")]);
  await writeFile(join(solo, "packageInfo"), "");
  plain = join(root, "plain");
  await mkdir(plain);
});

describe("resolveRepo", () => {
  it("uses the git top-level for paths inside a repo", async () => {
    const sub = join(ws, "src", "Handbook", "docs");
    await mkdir(sub, { recursive: true });
    expect(await resolveRepo(sub, "")).toEqual({ ok: true, root: join(ws, "src", "Handbook"), via: "git" });
  });

  it("maps a workspace root to the package the text mentions most", async () => {
    expect(await isPackageWorkspace(ws)).toBe(true);
    const text = "Run evals in Datasets. The wiki (Handbook) links to it. Datasets has the configs.";
    expect(await resolveRepo(ws, text)).toEqual({ ok: true, root: join(ws, "src", "Datasets"), via: "workspace-package" });
    // a full path counts more than a bare name
    expect((await resolveRepo(ws, `Datasets Datasets ${join(ws, "src", "Handbook")}`)) as { root: string }).toMatchObject({
      root: join(ws, "src", "Handbook"),
    });
  });

  it("is unresolved on ties or no mention, listing candidates", async () => {
    const tie = await resolveRepo(ws, "Datasets and Handbook");
    expect(tie).toMatchObject({ ok: false, candidates: [join(ws, "src", "Handbook"), join(ws, "src", "Datasets")].sort() });
    expect(await resolveRepo(ws, "nothing relevant")).toMatchObject({ ok: false, reason: expect.stringMatching(/none mentioned/) });
  });

  it("treats topics naming 3+ packages as workspace-wide (unresolved)", async () => {
    const ws3 = realpathSync(await mkdtemp(join(tmpdir(), "lbg-ws3-")));
    for (const p of ["Datasets", "Handbook", "Docs"]) {
      await mkdir(join(ws3, "src", p), { recursive: true });
      execFileSync("git", ["init", "-q", join(ws3, "src", p)]);
    }
    await writeFile(join(ws3, "packageInfo"), "");
    const text = "packages: Datasets Datasets Datasets, Handbook, Docs";
    expect(await resolveRepo(ws3, text)).toMatchObject({ ok: false, reason: expect.stringMatching(/spans 3 packages/) });
    // a weak lead (3 vs 2) isn't enough either
    expect(await resolveRepo(ws, "Datasets Datasets Datasets Handbook Handbook")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no clear winner/),
    });
  });

  it("does not match a package name inside a longer word", async () => {
    expect(await resolveRepo(ws, "HandbookExtra and Datasets")).toMatchObject({ root: join(ws, "src", "Datasets") });
  });

  it("uses the only package of a single-package workspace; rejects non-repos", async () => {
    expect(await resolveRepo(solo, "")).toMatchObject({ ok: true, root: join(solo, "src", "OnlyPkg") });
    expect(await resolveRepo(plain, "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/not a git repo/) });
    expect(await resolveRepo("", "x")).toMatchObject({ ok: false });
  });
});

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type Config, DEFAULT_CONFIG } from "../src/config.ts";
import { draftSkill } from "../src/pipeline/draft/render.ts";
import { resolveTarget } from "../src/pipeline/draft/target.ts";
import { acceptProposal } from "../src/pipeline/review/accept.ts";
import {
  closeDraft,
  discardDraft,
  openDraft,
} from "../src/pipeline/review/revise.ts";
import { syncTree } from "../src/pipeline/tree/sync.ts";
import { scoreTree, skillStats } from "../src/pipeline/tree/treescore.ts";
import { type NuggetInsert, StateDb } from "../src/state/db.ts";
import { Tree } from "../src/state/tree.ts";
import { fauxRunner, toolResults } from "./helpers/faux.ts";

const nugget = (sessionId: string, repo: string): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId,
  cwd: repo,
  kind: "correction",
  title: `fact from ${sessionId}`,
  knowledge: `knowledge from ${sessionId}`,
  triggers: [],
  scope: "repo",
  repo,
  confidence: 0.9,
  evidence: [{ label: "U1", quote: `quote ${sessionId}` }],
});

const calls = (...c: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(c, { stopReason: "toolUse" });
const report = (summary = "Done.") =>
  calls(fauxToolCall("report_draft", { summary }));

const AGENTS = "# Agents\n\nRead me first.\n\n## Build\nUse hatch.\n";
const DOC =
  "# Development\n\nWorking on it.\n\n## Tests\nRun vitest.\n\n## Conventions\nTabs.\n";

/** A repo with AGENTS.md, README.md and docs/development.md, synced with documents on. */
async function repoSetup() {
  const repo = realpathSync(await mkdtemp(join(tmpdir(), "lbg-repo-")));
  await mkdir(join(repo, ".git"));
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, "AGENTS.md"), AGENTS);
  await writeFile(join(repo, "README.md"), "# Tool\n\nFor users.\n");
  await writeFile(join(repo, "docs", "development.md"), DOC);
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "main.ts"), "export const main = 1;\n");
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  tree.ensureRoot({ scope: "repo", repo });
  const sync = () =>
    syncTree(tree, { skillsDir, declared: [], repoDocs: cfg.repoDocs });
  await sync();
  const node = (name: string) =>
    tree
      .trees({ scope: "repo", repo })[0]!
      .children.find((c) => c.name === name)!;
  /** Evidence from two sessions on a node, attached after its last render. */
  const teach = (id: number, covered = false) => {
    tree.updateNode(id, { renderedAt: new Date(Date.now() - 60_000) });
    for (const s of ["a", "b"]) {
      const n = db.insertNugget(nugget(`${id}-${s}`, repo));
      tree.attachNugget(n, id);
      if (covered) tree.setCovered(n, id);
    }
    scoreTree(tree, cfg.score);
  };
  return { repo, cfg, db, tree, node, teach, sync };
}

describe("repo documents as homes", () => {
  it("an update writes the document; the drafter reads the whole repo, and writes only agent files and docs", async () => {
    const s = await repoSetup();
    const doc = s.node("docs-development");
    s.teach(doc.id);
    expect(s.tree.getNode(doc.id)).toMatchObject({
      status: "candidate",
      proposalKind: "update",
    });
    expect(await resolveTarget(s.tree.subtree(doc.id)!, s.cfg)).toMatchObject({
      primary: ["docs/development.md"],
      writable: ["docs/development.md", "AGENTS.md", "README.md", "docs/"],
      readRoot: s.repo,
    });
    let prompt = "";
    let seen: ReturnType<typeof toolResults> = [];
    const runner = await fauxRunner([
      (ctx) => {
        prompt = JSON.stringify((ctx as { messages: unknown[] }).messages);
        return calls(
          fauxToolCall("read", { path: join(s.repo, "src", "main.ts") }),
          fauxToolCall("write", {
            path: join(s.repo, "docs", "development.md"),
            content: "live file",
          }),
          fauxToolCall("write", { path: "src/main.ts", content: "pwned" }),
          fauxToolCall("read", { path: "/etc/hostname" }),
          fauxToolCall("edit", {
            path: "docs/development.md",
            edits: [
              {
                oldText: "Run vitest.",
                newText: "Run vitest. Also run the CLI end to end.",
              },
            ],
          }),
          fauxToolCall("edit", {
            path: "README.md",
            edits: [
              { oldText: "For users.", newText: "For users. See docs/." },
            ],
          }),
        );
      },
      (ctx) => {
        seen = toolResults(ctx as never);
        return report();
      },
    ] satisfies FauxResponseStep[]);

    const out = await draftSkill(s.tree, runner, s.cfg, doc.id);
    expect(prompt).toContain("Task: update the document docs/development.md");
    expect(prompt).toContain(
      `Repository (read-only, read anything in it): ${s.repo}`,
    );
    expect(prompt).toContain(
      "Primary target (in the working directory): docs/development.md",
    );
    expect(seen.map((r) => [r.name, r.isError])).toEqual([
      ["read", false], // the source, in the live repo
      ["write", true], // the live repo is read-only
      ["write", true], // source code is never writable
      ["read", true], // nothing outside the repo
      ["edit", false],
      ["edit", false], // README.md: also writable
    ]);
    expect(seen[0]!.text).toContain("export const main");
    expect(seen[1]!.text).toMatch(/live repository, which is read-only/);
    expect(out).toMatchObject({
      status: "open",
      files: [{ path: "README.md" }, { path: "docs/development.md" }],
    });
    expect(readFileSync(join(s.repo, "docs", "development.md"), "utf8")).toBe(
      DOC,
    );
    const id = (out as { proposalId: number }).proposalId;

    // Revising rebuilds the same target.
    const ws = await openDraft(s.tree, id);
    expect(ws.target).toMatchObject({
      doc: "docs/development.md",
      primary: ["docs/development.md"],
      readRoot: s.repo,
    });
    expect(ws.target.pointer).toBeUndefined();
    expect(ws.target.skillDir).toBeUndefined();
    expect(existsSync(join(ws.scratch, "README.md"))).toBe(true);
    expect(existsSync(join(ws.scratch, "src"))).toBe(false);
    await discardDraft(ws);

    await acceptProposal(s.tree, s.cfg, id);
    expect(
      readFileSync(join(s.repo, "docs", "development.md"), "utf8"),
    ).toContain("end to end");
    expect(readFileSync(join(s.repo, "README.md"), "utf8")).toContain(
      "See docs/.",
    );
  });

  it("touching another node's file doesn't absorb that node's waiting evidence", async () => {
    const s = await repoSetup();
    const doc = s.node("docs-development");
    const build = s.node("build");
    s.teach(doc.id);
    // One session's worth of evidence waits on Build: not enough for a proposal yet.
    const waitingSince = new Date(Date.now() - 60_000);
    s.tree.updateNode(build.id, { renderedAt: waitingSince });
    s.tree.attachNugget(s.db.insertNugget(nugget("build-1", s.repo)), build.id);
    const runner = await fauxRunner([
      calls(
        fauxToolCall("edit", {
          path: "docs/development.md",
          edits: [{ oldText: "Tabs.", newText: "Tabs, always." }],
        }),
        fauxToolCall("edit", {
          path: "AGENTS.md",
          edits: [
            {
              oldText: "Use hatch.",
              newText: "Use hatch. Conventions: docs/development.md.",
            },
          ],
        }),
      ),
      report(),
    ]);
    const out = await draftSkill(s.tree, runner, s.cfg, doc.id);
    expect(out).toMatchObject({ status: "open" });
    await acceptProposal(
      s.tree,
      s.cfg,
      (out as { proposalId: number }).proposalId,
    );
    const after = s.tree.subtree(build.id)!;
    expect(after.summary).toContain("Conventions: docs/development.md");
    expect(after.renderedAt).toEqual(waitingSince);
    expect(skillStats(after).fresh).toMatchObject({ nuggets: 1 });
  });

  it("knowledge a document already states earns a pointer in AGENTS.md, not more text in the document", async () => {
    const s = await repoSetup();
    const doc = s.node("docs-development");
    s.teach(doc.id, true);
    expect(s.tree.getNode(doc.id)).toMatchObject({
      status: "candidate",
      proposalKind: "fix-description",
    });
    expect(await resolveTarget(s.tree.subtree(doc.id)!, s.cfg)).toMatchObject({
      primary: ["AGENTS.md"],
      doc: "docs/development.md",
      pointer: true,
    });

    // A change that doesn't name the document isn't a pointer.
    const vague = await fauxRunner([
      calls(
        fauxToolCall("edit", {
          path: "AGENTS.md",
          edits: [
            { oldText: "Use hatch.", newText: "Use hatch. Read the docs." },
          ],
        }),
      ),
      report(),
    ]);
    expect(await draftSkill(s.tree, vague, s.cfg, doc.id)).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/doesn't mention docs\/development\.md/),
    });

    let prompt = "";
    const good = await fauxRunner([
      (ctx) => {
        prompt = JSON.stringify((ctx as { messages: unknown[] }).messages);
        return calls(
          fauxToolCall("edit", {
            path: "AGENTS.md",
            edits: [
              {
                oldText: "## Build",
                newText:
                  "## Documentation\nRead docs/development.md before changing tests.\n\n## Build",
              },
            ],
          }),
        );
      },
      report(),
    ]);
    const out = await draftSkill(s.tree, good, s.cfg, doc.id);
    expect(prompt).toContain("did not read that document");
    expect(prompt).not.toContain("Rewrite the description");
    expect(out).toMatchObject({
      status: "open",
      files: [{ path: "AGENTS.md" }],
    });
    const ws = await openDraft(
      s.tree,
      (out as { proposalId: number }).proposalId,
    );
    expect(ws.target).toMatchObject({
      agentsMd: "AGENTS.md",
      doc: "docs/development.md",
      pointer: true,
    });
    await discardDraft(ws);
  });

  it("a placeholder the document already shows doesn't block a change; one the draft adds does", async () => {
    const s = await repoSetup();
    await writeFile(
      join(s.repo, "docs", "development.md"),
      `${DOC}\nExample: replace it with [REDACTED].\n`,
    );
    await s.sync();
    const doc = s.node("docs-development");
    s.teach(doc.id);
    const edit = (newText: string) =>
      calls(
        fauxToolCall("edit", {
          path: "docs/development.md",
          edits: [{ oldText: "Tabs.", newText }],
        }),
      );
    const bad = await fauxRunner([edit("Token is [REDACTED]."), report()]);
    expect(await draftSkill(s.tree, bad, s.cfg, doc.id)).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/contains a \[REDACTED\] placeholder/),
    });
    const good = await fauxRunner([edit("Tabs, always."), report()]);
    expect(await draftSkill(s.tree, good, s.cfg, doc.id)).toMatchObject({
      status: "open",
    });
  });

  it("AGENTS.md is always loaded: text it already states earns nothing", async () => {
    const s = await repoSetup();
    const build = s.node("build");
    s.teach(build.id, true);
    expect(s.tree.getNode(build.id)).toMatchObject({ status: "open" });
    expect(s.tree.getNode(build.id)!.proposalKind).toBeUndefined();
  });

  it("the AGENTS.md intro is a home too; no existing file may be deleted", async () => {
    const s = await repoSetup();
    const intro = s.node("agents-md-intro");
    expect(intro.summary).toBe("Read me first.");
    s.teach(intro.id);
    expect(await resolveTarget(s.tree.subtree(intro.id)!, s.cfg)).toMatchObject(
      { primary: ["AGENTS.md"], intro: true },
    );
    const runner = await fauxRunner([
      calls(
        fauxToolCall("edit", {
          path: "AGENTS.md",
          edits: [
            {
              oldText: "Read me first.",
              newText: "Read me first. Never push.",
            },
          ],
        }),
      ),
      report(),
    ]);
    const out = await draftSkill(s.tree, runner, s.cfg, intro.id);
    expect(out).toMatchObject({
      status: "open",
      files: [{ path: "AGENTS.md" }],
    });
    // The guard has no delete; a file removed from the scratch copy (a hand edit) counts as one.
    const ws = await openDraft(
      s.tree,
      (out as { proposalId: number }).proposalId,
    );
    await rm(join(ws.scratch, "docs", "development.md"));
    expect((await closeDraft(s.tree, s.cfg, ws)).problems).toEqual([
      "docs/development.md must not be deleted",
    ]);
    await discardDraft(ws);
  });
});

describe("skills of every agent's directory", () => {
  it("are mirrored, updated in place, and new skills go where the repo keeps them", async () => {
    const s = await repoSetup();
    const skill = (name: string) =>
      `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\n# ${name}\n\nSteps.\n`;
    await mkdir(join(s.repo, ".claude", "skills", "deploy"), {
      recursive: true,
    });
    await writeFile(
      join(s.repo, ".claude", "skills", "deploy", "SKILL.md"),
      skill("deploy"),
    );
    // Another agent's directory that is only a link to the first one: one skill, not two.
    await mkdir(join(s.repo, ".pi"));
    await symlink(
      join(s.repo, ".claude", "skills"),
      join(s.repo, ".pi", "skills"),
    );
    // Settings next to the skills are not something a draft may write.
    await writeFile(join(s.repo, ".claude", "settings.json"), "{}");
    await s.sync();
    const all = s.tree.trees({ scope: "repo", repo: s.repo })[0]!.children;
    expect(all.filter((c) => c.name === "deploy")).toHaveLength(1);
    const deploy = s.node("deploy");
    expect(deploy.sourcePath).toBe(
      join(s.repo, ".claude", "skills", "deploy", "SKILL.md"),
    );

    s.teach(deploy.id);
    const live = await resolveTarget(s.tree.subtree(deploy.id)!, s.cfg);
    expect(live).toMatchObject({
      skillDir: ".claude/skills/deploy",
      primary: [".claude/skills/deploy/"],
    });
    expect(live.writable).toEqual([
      ".claude/skills/deploy/",
      "AGENTS.md",
      "README.md",
      ".claude/skills/",
      "docs/",
    ]);

    const root = s.tree.ensureRoot({ scope: "repo", repo: s.repo });
    const latent = s.tree.createNode(root, {
      title: "Releases",
      name: "releases",
    });
    expect(await resolveTarget(s.tree.subtree(latent)!, s.cfg)).toMatchObject({
      skillDir: ".claude/skills/releases",
      primary: [".claude/skills/releases/", "AGENTS.md"],
    });

    // Updating one skill may add another, which must be a valid skill.
    let errors: boolean[] = [];
    const runner = await fauxRunner([
      calls(
        fauxToolCall("write", {
          path: ".claude/settings.json",
          content: '{"hooks":{}}',
        }),
        fauxToolCall("edit", {
          path: ".claude/skills/deploy/SKILL.md",
          edits: [{ oldText: "Steps.", newText: "Steps. Tag first." }],
        }),
        fauxToolCall("write", {
          path: ".claude/skills/rollback/SKILL.md",
          content: "# Rollback\n\nNo frontmatter.\n",
        }),
      ),
      (ctx) => {
        errors = toolResults(ctx as never).map((r) => r.isError);
        return report();
      },
    ]);
    expect(await draftSkill(s.tree, runner, s.cfg, deploy.id)).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(
        /\.claude\/skills\/rollback: frontmatter name must be "rollback"/,
      ),
    });
    expect(errors).toEqual([true, false, false]);
  });
});

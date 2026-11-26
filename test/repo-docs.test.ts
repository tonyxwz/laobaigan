import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type Config, DEFAULT_CONFIG } from "../src/config.ts";
import { acceptProposal } from "../src/pipeline/accept.ts";
import { draftSkill, resolveTarget } from "../src/pipeline/render.ts";
import { discardDraft, openDraft } from "../src/pipeline/revise.ts";
import { syncTree } from "../src/pipeline/sync.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
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
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  tree.ensureRoot({ scope: "repo", repo });
  await syncTree(tree, { skillsDir, declared: [], repoDocs: cfg.repoDocs });
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
  return { repo, cfg, db, tree, node, teach };
}

describe("repo documents as homes", () => {
  it("an update writes the document; the drafter can read the repo's other docs but not write them", async () => {
    const s = await repoSetup();
    const doc = s.node("docs-development");
    s.teach(doc.id);
    expect(s.tree.getNode(doc.id)).toMatchObject({
      status: "candidate",
      proposalKind: "update",
    });
    let prompt = "";
    let seen: ReturnType<typeof toolResults> = [];
    const runner = await fauxRunner([
      (ctx) => {
        prompt = JSON.stringify((ctx as { messages: unknown[] }).messages);
        return calls(
          fauxToolCall("read", { path: "README.md" }),
          fauxToolCall("write", { path: "README.md", content: "pwned" }),
          fauxToolCall("edit", {
            path: "docs/development.md",
            edits: [
              {
                oldText: "Run vitest.",
                newText: "Run vitest. Also run the CLI end to end.",
              },
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
    expect(seen.map((r) => [r.name, r.isError])).toEqual([
      ["read", false],
      ["write", true],
      ["edit", false],
    ]);
    expect(seen[0]!.text).toContain("For users.");
    expect(out).toMatchObject({
      status: "open",
      files: [{ path: "docs/development.md" }],
    });
    const id = (out as { proposalId: number }).proposalId;

    // Revising rebuilds the same target, with the context files in the scratch copy.
    const ws = await openDraft(s.tree, id, s.cfg);
    expect(ws.target).toMatchObject({
      doc: "docs/development.md",
      writable: ["docs/development.md"],
    });
    expect(ws.target.pointer).toBeUndefined();
    expect(existsSync(join(ws.scratch, "README.md"))).toBe(true);
    await discardDraft(ws);

    await acceptProposal(s.tree, s.cfg, id);
    expect(
      readFileSync(join(s.repo, "docs", "development.md"), "utf8"),
    ).toContain("end to end");
    expect(readFileSync(join(s.repo, "README.md"), "utf8")).toContain("users");
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
      writable: ["AGENTS.md"],
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
      s.cfg,
    );
    expect(ws.target).toMatchObject({
      agentsMd: "AGENTS.md",
      doc: "docs/development.md",
      pointer: true,
    });
    await discardDraft(ws);
  });

  it("AGENTS.md is always loaded: text it already states earns nothing", async () => {
    const s = await repoSetup();
    const build = s.node("build");
    s.teach(build.id, true);
    expect(s.tree.getNode(build.id)).toMatchObject({ status: "open" });
    expect(s.tree.getNode(build.id)!.proposalKind).toBeUndefined();
  });

  it("the AGENTS.md intro is a home too: only the text before the first section may change", async () => {
    const s = await repoSetup();
    const intro = s.node("agents-md-intro");
    expect(intro.summary).toBe("Read me first.");
    s.teach(intro.id);
    const edit = (oldText: string, newText: string) =>
      calls(
        fauxToolCall("edit", {
          path: "AGENTS.md",
          edits: [{ oldText, newText }],
        }),
      );
    const bad = await fauxRunner([edit("Use hatch.", "Use tox."), report()]);
    expect(await draftSkill(s.tree, bad, s.cfg, intro.id)).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(
        /section "Build" changed; only the text before the first section may change/,
      ),
    });
    const good = await fauxRunner([
      edit("Read me first.", "Read me first. Never push."),
      report(),
    ]);
    expect(await draftSkill(s.tree, good, s.cfg, intro.id)).toMatchObject({
      status: "open",
      files: [{ path: "AGENTS.md" }],
    });
  });
});

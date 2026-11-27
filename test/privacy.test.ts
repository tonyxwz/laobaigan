import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type Config, DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import {
  isPublicRepo,
  privateHits,
  privateProblems,
  privateTermsIn,
} from "../src/pipeline/common/privacy.ts";
import { draftSkill } from "../src/pipeline/draft/render.ts";
import {
  closeDraft,
  discardDraft,
  openDraft,
} from "../src/pipeline/draft/workspace.ts";
import {
  acceptProposal,
  privateHitsFor,
} from "../src/pipeline/review/accept.ts";
import { commitMessageFor } from "../src/pipeline/review/commit.ts";
import { syncTree } from "../src/pipeline/tree/sync.ts";
import { scoreTree } from "../src/pipeline/tree/treescore.ts";
import { type NuggetInsert, StateDb } from "../src/state/db.ts";
import { Proposals } from "../src/state/proposals.ts";
import { Tree } from "../src/state/tree.ts";
import { fauxRunner } from "./helpers/faux.ts";

const privacy = (publicRepos: string[], privateTerms: string[]) => ({
  privacy: { publicRepos, privateTerms },
});

describe("private terms", () => {
  const cfg = privacy(
    ["/pub/repo"],
    ["Acme", "/\\bwiki\\.corp\\b/", "/@corp\\.example$/im"],
  );

  it("match as case-insensitive text, or as a /regex/", () => {
    expect(privateTermsIn("the ACME wrapper", cfg)).toEqual(["Acme"]);
    expect(privateTermsIn("see wiki.corp/x", cfg)).toEqual([
      "/\\bwiki\\.corp\\b/",
    ]);
    // Plain text matches anywhere in a word; a regex is exactly what it says.
    expect(privateTermsIn("a pacmeister", cfg)).toEqual(["Acme"]);
    expect(privateTermsIn("see Wiki.Corp or mywiki.corporate", cfg)).toEqual(
      [],
    );
    expect(privateTermsIn("me@corp.example\nnext", cfg)).toHaveLength(1);
  });

  it("only count in a public repo, and only on lines the change adds", () => {
    expect(isPublicRepo("/pub/repo", cfg)).toBe(true);
    expect(isPublicRepo("/pub/repo/packages/x", cfg)).toBe(true);
    expect(isPublicRepo("/pub/repository", cfg)).toBe(false);
    const files = [
      { path: "docs/a.md", content: "old Acme line\nnew acme line\nfine\n" },
      { path: "docs/acme.md", content: "fine\n" },
      { path: "docs/gone.md", content: null },
    ];
    const before = (p: string) =>
      p === "docs/a.md" ? "old Acme line\nfine\n" : undefined;
    expect(privateHits(files, "/private/repo", cfg, before)).toEqual([]);
    const hits = privateHits(files, "/pub/repo", cfg, before);
    expect(hits).toEqual([
      { path: "docs/a.md", line: 2, term: "Acme" },
      { path: "docs/acme.md", line: 0, term: "Acme" }, // a new file's path counts too
    ]);
    expect(privateProblems(hits)).toEqual([
      'docs/a.md adds private term(s) "Acme" to a public repository (line 2)',
      'docs/acme.md adds private term(s) "Acme" to a public repository (in its path)',
    ]);
  });

  it("are validated when the config loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-cfg-"));
    const write = async (o: unknown) => {
      await writeFile(join(dir, "c.json"), JSON.stringify(o));
      return join(dir, "c.json");
    };
    expect(
      loadConfig(
        await write({
          privacy: { publicRepos: ["~/r"], privateTerms: ["x", "/y+/i"] },
        }),
      ).privacy,
    ).toEqual({
      publicRepos: [join(process.env.HOME!, "r")],
      privateTerms: ["x", "/y+/i"],
    });
    expect(loadConfig(await write({})).privacy).toEqual({
      publicRepos: [],
      privateTerms: [],
    });
    expect(() =>
      loadConfig(write0({ privacy: { privateTerms: ["/(/"] } }, dir)),
    ).toThrow(/bad pattern/);
    expect(() =>
      loadConfig(write0({ privacy: { privateTerms: "x" } }, dir)),
    ).toThrow(/privateTerms/);
    expect(() => loadConfig(write0({ repoDocs: ["../x"] }, dir))).toThrow(
      /repoDocs/,
    );
  });
});

function write0(o: unknown, dir: string): string {
  const p = join(dir, `c-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(o));
  return p;
}

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

const edit = (oldText: string, newText: string) =>
  fauxAssistantMessage(
    [
      fauxToolCall("edit", {
        path: "AGENTS.md",
        edits: [{ oldText, newText }],
      }),
    ],
    { stopReason: "toolUse" },
  );
const report = (summary = "Done.") =>
  fauxAssistantMessage([fauxToolCall("report_draft", { summary })], {
    stopReason: "toolUse",
  });

/** A public repo whose AGENTS.md already has a private term in another line of the Build section. */
async function publicRepo(over: Partial<Config["privacy"]> = {}) {
  const repo = realpathSync(await mkdtemp(join(tmpdir(), "lbg-repo-")));
  await mkdir(join(repo, ".git"));
  await writeFile(
    join(repo, "AGENTS.md"),
    "# Agents\n\n## Build\nUse hatch.\nOld acme note.\n",
  );
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    skillsDir,
    privacy: { publicRepos: [repo], privateTerms: ["acme"], ...over },
  };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  tree.ensureRoot({ scope: "repo", repo });
  await syncTree(tree, { skillsDir, declared: [] });
  const build = tree
    .trees({ scope: "repo", repo })[0]!
    .children.find((c) => c.title === "Build")!.id;
  tree.updateNode(build, { renderedAt: new Date(Date.now() - 60_000) });
  for (const s of ["a", "b"])
    tree.attachNugget(db.insertNugget(nugget(s, repo)), build);
  scoreTree(tree, cfg.score);
  return { repo, cfg, tree, build };
}

describe("the private-terms gate", () => {
  it("gives the drafter one retry, then stores the clean draft", async () => {
    const s = await publicRepo();
    let retryPrompt = "";
    const runner = await fauxRunner([
      edit("Use hatch.", "Use hatch, not the Acme wrapper."),
      report("Mentions Acme."),
      (ctx) => {
        retryPrompt = JSON.stringify((ctx as { messages: unknown[] }).messages);
        return edit("Use hatch, not the Acme wrapper.", "Use hatch directly.");
      },
      report("Build: use hatch directly."),
    ]);
    const out = await draftSkill(s.tree, runner, s.cfg, s.build);
    expect(retryPrompt).toContain("this repository is public");
    expect(retryPrompt).toContain("AGENTS.md adds private term(s)");
    expect(out).toMatchObject({ status: "open" });
    const p = new Proposals(s.tree.db).mustGet(
      (out as { proposalId: number }).proposalId,
    );
    expect(p.files[0]!.content).toContain("Use hatch directly.");
    expect(p.files[0]!.content).toContain("Old acme note."); // existing text is not the draft's doing
    expect(p.summary).toBe("Build: use hatch directly.");
  });

  it("fails the draft when the retry still adds one", async () => {
    const s = await publicRepo();
    const runner = await fauxRunner([
      edit("Use hatch.", "Use the Acme wrapper."),
      report(),
      edit("Use the Acme wrapper.", "Use the ACME tool."),
      report(),
    ]);
    expect(await draftSkill(s.tree, runner, s.cfg, s.build)).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(
        /AGENTS\.md adds private term\(s\) "acme" to a public repository \(line 4\)/,
      ),
    });
  });

  it("refuses accept, edit and revise for a draft made before the term was listed; --force doesn't help", async () => {
    const s = await publicRepo({ privateTerms: [] });
    const runner = await fauxRunner([
      edit("Use hatch.", "Use the Acme wrapper."),
      report("Uses the Acme wrapper."),
    ]);
    const out = await draftSkill(s.tree, runner, s.cfg, s.build);
    expect(out).toMatchObject({ status: "open" });
    const id = (out as { proposalId: number }).proposalId;
    const p = () => new Proposals(s.tree.db).mustGet(id);

    const strict: Config = {
      ...s.cfg,
      privacy: { ...s.cfg.privacy, privateTerms: ["acme"] },
    };
    expect(await privateHitsFor(p(), s.cfg)).toEqual([]);
    expect(await privateHitsFor(p(), strict)).toEqual([
      { path: "AGENTS.md", line: 4, term: "acme" },
    ]);
    await expect(
      acceptProposal(s.tree, strict, id, { force: true }),
    ).rejects.toThrow(/refused: AGENTS\.md adds private term\(s\) "acme"/);
    expect(readFileSync(join(s.repo, "AGENTS.md"), "utf8")).toContain(
      "Use hatch.",
    );
    expect(p().status).toBe("open");

    // The published commit message leaves out a summary that names the term.
    expect(commitMessageFor(s.tree, p(), s.cfg)).toContain("Acme wrapper");
    expect(commitMessageFor(s.tree, p(), strict)).not.toMatch(/acme/i);

    // A hand edit that keeps the term is not stored; one that removes it is, and then accept works.
    const ws = await openDraft(s.tree, id);
    expect((await closeDraft(s.tree, strict, ws)).problems).toEqual([
      'AGENTS.md adds private term(s) "acme" to a public repository (line 4)',
    ]);
    await writeFile(
      join(ws.scratch, "AGENTS.md"),
      "# Agents\n\n## Build\nUse hatch directly.\nOld acme note.\n",
    );
    expect(await closeDraft(s.tree, strict, ws)).toMatchObject({
      problems: [],
      changed: true,
    });
    await discardDraft(ws);
    await acceptProposal(s.tree, strict, id);
    expect(readFileSync(join(s.repo, "AGENTS.md"), "utf8")).toContain(
      "Use hatch directly.",
    );
  });

  it("leaves repos that aren't listed as public alone", async () => {
    const s = await publicRepo({ publicRepos: [] });
    const runner = await fauxRunner([
      edit("Use hatch.", "Use the Acme wrapper."),
      report(),
    ]);
    expect(await draftSkill(s.tree, runner, s.cfg, s.build)).toMatchObject({
      status: "open",
    });
  });
});

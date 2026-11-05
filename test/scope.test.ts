import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { draftSkill, type RenderTarget } from "../src/pipeline/render.ts";
import { reviseProposal } from "../src/pipeline/revise.ts";
import { checkScope, terms } from "../src/pipeline/scope.ts";
import { syncTree } from "../src/pipeline/sync.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Proposals, type DraftFile } from "../src/state/proposals.ts";
import { Tree } from "../src/state/tree.ts";
import { fauxRunner } from "./helpers/faux.ts";

const md = (desc: string, body = "# PR review\n\nUse `gh pr checkout` to check out a PR for review.\n") => `---\nname: pr-review\ndescription: ${desc}\n---\n\n${body}`;
const OLD = "Review peers code and add suggestions about best practices";
const WIDE =
  "Review peers code and add suggestions about best practices on GitHub PRs (check out with `gh pr checkout`), push follow-up commits to an existing PR with `git push`, and write/update PR descriptions via github-mcp review tools.";
const target: RenderTarget = { root: "/s", skillName: "pr-review", writable: ["pr-review/"], skillDir: "pr-review" };
const base = new Map([["pr-review/SKILL.md", md(OLD)]]);
const change = (content: string): DraftFile[] => [{ path: "pr-review/SKILL.md", baseHash: "x", content }];

describe("checkScope", () => {
  it("flags #4's widened description; rewording in the skill's own words is fine", () => {
    const c = checkScope(change(md(WIDE)), base, target, "update", true)!;
    expect(c.widened).toBe(true);
    expect(c.added).toEqual(expect.arrayContaining(["github", "mcp"]));
    expect(checkScope(change(md("Review peers' code, with gh pr checkout, and suggest best practices")), base, target, "update", true)!.widened).toBe(false);
    expect(checkScope(change(md(OLD)), base, target, "update", true)).toMatchObject({ added: [], widened: false });
  });

  it("words already in the skill's body or references don't count as new", () => {
    const b = new Map([...base, ["pr-review/references/revisions.md", "Push follow-up commits to existing PRs on GitHub with git push and github-mcp tools."]]);
    expect(checkScope(change(md(WIDE)), b, target, "update", true)!.widened).toBe(false);
  });

  it("only applies to updates of live skill folders", () => {
    expect(checkScope(change(md(WIDE)), base, target, "fix-description", true)).toBeUndefined();
    expect(checkScope(change(md(WIDE)), base, target, "new", false)).toBeUndefined();
    expect(checkScope(change(md(WIDE)), base, target, "update", false)).toBeUndefined();
    expect(checkScope(change(md(WIDE)), base, { ...target, skillDir: undefined, agentsMd: "AGENTS.md" } as RenderTarget, "update", true)).toBeUndefined();
  });

  it("stems plurals and verb forms", () => {
    expect([...terms("Rendering diagrams with tools")].sort()).toEqual(["diagram", "render", "tool"]);
    expect([...terms("images image boxes linked libraries")].sort()).toEqual(["box", "image", "library", "link"]);
  });
});

const nugget = (sessionId: string, title: string): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId,
  cwd: "/",
  kind: "fact",
  title,
  knowledge: `${title}.`,
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: title, ts: "2026-11-01T10:00:00.000Z" }],
});

/** A live pr-review skill with two fresh nuggets → candidate update. */
async function liveSetup() {
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  await mkdir(join(skillsDir, "pr-review"));
  await writeFile(join(skillsDir, "pr-review", "SKILL.md"), md(OLD));
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  await syncTree(tree, { skillsDir, declared: [] });
  const skill = tree.trees()[0]!.children.find((c) => c.name === "pr-review")!.id;
  tree.updateNode(skill, { renderedAt: new Date(Date.now() - 60_000) });
  for (const [s, t] of [["a", "Push follow-up commits to an existing PR"], ["b", "Write PR descriptions with github-mcp"]]) tree.attachNugget(db.insertNugget(nugget(s!, t!)), skill);
  scoreTree(tree, cfg.score);
  expect(tree.getNode(skill)).toMatchObject({ status: "candidate", proposalKind: "update" });
  return { cfg, db, tree, skill, skillsDir };
}

const write = (desc: string) => fauxAssistantMessage([fauxToolCall("write", { path: "pr-review/SKILL.md", content: md(desc) })], { stopReason: "toolUse" });
const report = () => fauxAssistantMessage([fauxToolCall("report_draft", { summary: "s" })], { stopReason: "toolUse" });

describe("drafting a live skill's update", () => {
  it("gives the drafter one retry when the description widens; the fixed draft is stored", async () => {
    const { cfg, db, tree, skill } = await liveSetup();
    let retryPrompt = "";
    const runner = await fauxRunner([
      write(WIDE),
      report(),
      (ctx) => {
        retryPrompt = JSON.stringify((ctx as { messages: unknown[] }).messages);
        return write("Review peers' code (check it out with gh pr checkout) and suggest best practices");
      },
      report(),
    ]);
    const out = await draftSkill(tree, runner, cfg, skill);
    expect(out.status).toBe("open");
    expect(retryPrompt).toContain("widens this live skill");
    expect(retryPrompt).toContain("github");
    const p = new Proposals(db).get((out as { proposalId: number }).proposalId)!;
    expect(p.files[0]!.content).toContain("description: Review peers' code (check it out with gh pr checkout)");
  });

  it("fails with a readable reason if the retry still widens it", async () => {
    const { cfg, tree, skill } = await liveSetup();
    const out = await draftSkill(tree, await fauxRunner([write(WIDE), report(), write(WIDE), report()]), cfg, skill);
    expect(out).toMatchObject({ status: "failed", reason: expect.stringMatching(/description widens the skill's scope \(new: .*github.*\)/) });
    expect(tree.getNode(skill)!.status).toBe("candidate");
  });

  it("revise (you steering) only warns", async () => {
    const { cfg, db, tree, skill } = await liveSetup();
    const first = await draftSkill(tree, await fauxRunner([write("Review peers' code with gh pr checkout and suggest best practices"), report()]), cfg, skill);
    const id = (first as { proposalId: number }).proposalId;
    const r = await reviseProposal(tree, await fauxRunner([write(WIDE), report()]), cfg, id, "make the description cover PR authoring too");
    expect(r.problems).toEqual([]);
    expect(r.warnings[0]).toMatch(/widens the skill's scope.*Keep it only if you mean to change what this skill is about/);
    expect(new Proposals(db).get(id)!.files[0]!.content).toContain("github-mcp");
  });
});

describe("nothing on-topic to add", () => {
  it("re-files the off-topic evidence and closes the proposal instead of failing", async () => {
    const { cfg, db, tree, skill } = await liveSetup();
    const props = new Proposals(db);
    const ns = tree.subtree(skill)!.nuggets.map((n) => n.id);
    const runner = await fauxRunner([
      fauxAssistantMessage(
        [fauxToolCall("report_draft", { summary: "Nothing here is about reviewing others' PRs.", excluded: ns.map((nuggetId) => ({ nuggetId, reason: "about authoring PRs" })) })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("route_to_skills", { newSkills: [{ key: "a", title: "PR authoring", name: "pr-authoring", description: "Post and describe your own PRs." }], placements: ns.map((nuggetId) => ({ nuggetId, newSkillKey: "a" })) })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("route_to_sections", { newSections: [], placements: ns.map((nuggetId) => ({ nuggetId, body: true })) })], { stopReason: "toolUse" }),
    ]);
    const out = await draftSkill(tree, runner, cfg, skill);
    expect(out).toMatchObject({ status: "nothing", excluded: [{ now: { path: "pr-authoring" } }, { now: { path: "pr-authoring" } }] });
    const p = props.get((out as { proposalId: number }).proposalId)!;
    expect(p).toMatchObject({ status: "failed", detail: "nothing on-topic to add: 2 off-topic item(s) re-filed elsewhere" });
    scoreTree(tree, cfg.score);
    expect(tree.getNode(skill)!.status).toBe("open"); // nothing fresh left on it
  });
});

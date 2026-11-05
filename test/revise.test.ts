import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { acceptProposal } from "../src/pipeline/accept.ts";
import { chatRevise, editProposal, type Launcher } from "../src/pipeline/interactive.ts";
import { draftSkill } from "../src/pipeline/render.ts";
import { reviseProposal } from "../src/pipeline/revise.ts";
import { syncTree } from "../src/pipeline/sync.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Proposals } from "../src/state/proposals.ts";
import { Tree } from "../src/state/tree.ts";
import { fauxRunner } from "./helpers/faux.ts";

const nugget = (sessionId: string): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId,
  cwd: "/",
  kind: "fact",
  title: `fact ${sessionId}`,
  knowledge: `knowledge ${sessionId}`,
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: "q" }],
});

const md = (body: string, name = "dotfiles-management") => `---\nname: ${name}\ndescription: Dotfiles. Use for zsh and tmux.\n---\n\n# Dotfiles\n\n${body}\n`;
const PATH = "dotfiles-management/SKILL.md";

/** A skills dir and an open proposal #id with SKILL.md = md("v1"). */
async function openProposal() {
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  await syncTree(tree, { skillsDir, declared: [] });
  const dot = tree.createNode(tree.ensureRoot({ scope: "global" }), { title: "Dotfiles", name: "dotfiles-management" });
  for (const s of ["a", "b", "c"]) tree.attachNugget(db.insertNugget(nugget(s)), dot);
  scoreTree(tree, cfg.score);
  const out = await draftSkill(
    tree,
    await fauxRunner([fauxAssistantMessage([fauxToolCall("write", { path: PATH, content: md("v1") })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxToolCall("report_draft", { summary: "first" })], { stopReason: "toolUse" })]),
    cfg,
    dot,
  );
  const id = (out as { proposalId: number }).proposalId;
  return { skillsDir, cfg, db, tree, id, props: new Proposals(db) };
}

const content = (props: Proposals, id: number) => props.get(id)!.files.find((f) => f.path === PATH)!.content;

describe("reviseProposal (one shot)", () => {
  it("starts from the stored draft, applies feedback, stores the result and adds the cost", async () => {
    const { cfg, tree, id, props } = await openProposal();
    let seenDraft = "";
    const runner = await fauxRunner([
      fauxAssistantMessage([fauxToolCall("read", { path: PATH })], { stopReason: "toolUse" }),
      (ctx) => {
        seenDraft = JSON.stringify((ctx as { messages: unknown[] }).messages);
        return fauxAssistantMessage([fauxToolCall("edit", { path: PATH, edits: [{ oldText: "v1", newText: "v2: shorter" }] })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage([fauxToolCall("report_draft", { summary: "Made it shorter." })], { stopReason: "toolUse" }),
    ]);
    const r = await reviseProposal(tree, runner, cfg, id, "make it shorter");
    expect(r).toMatchObject({ problems: [], changed: true, summary: "Made it shorter." });
    expect(seenDraft).toContain("make it shorter");
    expect(seenDraft).toContain("v1"); // it read the stored draft
    expect(content(props, id)).toContain("v2: shorter");
    expect(props.get(id)).toMatchObject({ status: "open", summary: "Made it shorter." });
  });

  it("keeps the previous draft when the revision fails verification", async () => {
    const { cfg, tree, id, props } = await openProposal();
    const runner = await fauxRunner([
      fauxAssistantMessage([fauxToolCall("write", { path: PATH, content: md("v2", "Wrong Name") })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("report_draft", { summary: "x" })], { stopReason: "toolUse" }),
    ]);
    const r = await reviseProposal(tree, runner, cfg, id, "rename it");
    expect(r.problems[0]).toMatch(/frontmatter name/);
    expect(content(props, id)).toContain("v1");
    expect(props.get(id)!.summary).toBe("first");
  });

  it("rebases a stale draft onto the live files", async () => {
    const { skillsDir, cfg, tree, id, props } = await openProposal();
    await mkdir(join(skillsDir, "dotfiles-management"));
    await writeFile(join(skillsDir, PATH), "written by hand meanwhile");
    await expect(acceptProposal(tree, cfg, id)).rejects.toThrow(/stale/);
    const runner = await fauxRunner([
      fauxAssistantMessage([fauxToolCall("edit", { path: PATH, edits: [{ oldText: "v1", newText: "v1, rebased" }] })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("report_draft", { summary: "rebased" })], { stopReason: "toolUse" }),
    ]);
    expect((await reviseProposal(tree, runner, cfg, id, "keep it")).problems).toEqual([]);
    await acceptProposal(tree, cfg, id); // no longer stale
    expect(readFileSync(join(skillsDir, PATH), "utf8")).toContain("v1, rebased");
  });
});

describe("interactive (chat revise and edit)", () => {
  /** A launcher that plays the role of pi / the editor: edits files in its cwd. */
  const fakeTool =
    (steps: ((cwd: string, args: string[], env: NodeJS.ProcessEnv) => void)[], calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = []): Launcher =>
    (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env });
      steps.shift()?.(opts.cwd, args, opts.env);
      return 0;
    };

  it("chat: starts pi guarded in the draft's scratch dir, stores the result", async () => {
    const { cfg, tree, id, props } = await openProposal();
    const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const launcher = fakeTool([(cwd) => writeFileSyncish(join(cwd, PATH), md("v2 from the chat"))], calls);
    const r = await chatRevise(tree, cfg, id, { launcher, ask: async () => false });
    expect(r).toMatchObject({ problems: [], changed: true, kept: false });
    expect(content(props, id)).toContain("v2 from the chat");

    const { cmd, args, env } = calls[0]!;
    expect(cmd).toBe("pi");
    expect(args).toEqual(expect.arrayContaining(["--no-approve", "--no-extensions", "--no-skills", "--no-context-files", "--no-mcp", "--tools", "read,ls,find,grep,write,edit"]));
    expect(args).not.toContain("--model"); // pi's own default
    expect(args).not.toContain("--provider");
    expect(args[args.indexOf("-e") + 1]).toMatch(/src\/pi\/guard-extension\.ts$/);
    expect(args[args.indexOf("--session-dir") + 1]).toMatch(/lbg-chat-.*\/sessions$/); // not ~/.pi/agent/sessions
    expect(JSON.parse(env.LBG_GUARD!)).toMatchObject({ writable: ["dotfiles-management/"] });
    expect(args.at(-1)).toMatch(/proposal #\d+ \(new\) for dotfiles-management/);
  });

  it("chat: on problems I can go back in (pi --continue) or keep the previous draft", async () => {
    const { cfg, tree, id, props } = await openProposal();
    const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const launcher = fakeTool(
      [
        (cwd) => writeFileSyncish(join(cwd, PATH), md("broken", "Bad Name")),
        (cwd) => writeFileSyncish(join(cwd, PATH), md("fixed")),
      ],
      calls,
    );
    const answers = [true];
    const r = await chatRevise(tree, cfg, id, { launcher, ask: async () => answers.shift() ?? false });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toContain("--continue");
    expect(r.problems).toEqual([]);
    expect(content(props, id)).toContain("fixed");

    const keep = await chatRevise(tree, cfg, id, { launcher: fakeTool([(cwd) => writeFileSyncish(join(cwd, PATH), md("x", "Bad"))]), ask: async () => false });
    expect(keep).toMatchObject({ kept: true });
    expect(content(props, id)).toContain("fixed");
  });

  it("edit: opens the drafted files in the editor; no change → nothing stored", async () => {
    const { cfg, tree, id, props } = await openProposal();
    const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const unchanged = await editProposal(tree, cfg, id, { launcher: fakeTool([() => {}], calls), ask: async () => false, editor: "code -w" });
    expect(unchanged.changed).toBe(false);
    expect(calls[0]).toMatchObject({ cmd: "code", args: ["-w", PATH] });

    await editProposal(tree, cfg, id, { launcher: fakeTool([(cwd) => writeFileSyncish(join(cwd, PATH), md("hand-edited"))]), ask: async () => false, editor: "vi" });
    expect(content(props, id)).toContain("hand-edited");
    expect(existsSync(join(cfg.skillsDir, "dotfiles-management"))).toBe(false); // still only a proposal
  });
});

import { writeFileSync } from "node:fs";
function writeFileSyncish(p: string, c: string) {
  writeFileSync(p, c);
}

describe("guardExtensionPath", () => {
  it("resolves the extension next to the running module, in source and in dist", async () => {
    const { guardExtensionPath } = await import("../src/pipeline/interactive.ts");
    expect(guardExtensionPath("file:///repo/src/pipeline/interactive.ts")).toBe("/repo/src/pi/guard-extension.ts");
    expect(guardExtensionPath("file:///usr/lib/node_modules/laobaigan/dist/pipeline/interactive.js")).toBe(
      "/usr/lib/node_modules/laobaigan/dist/pi/guard-extension.js",
    );
    const { existsSync } = await import("node:fs");
    expect(existsSync(guardExtensionPath())).toBe(true);
  });
});

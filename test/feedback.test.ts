import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { rejectProposal } from "../src/pipeline/accept.ts";
import { readChatTurns } from "../src/pipeline/chatlog.ts";
import { chatRevise, editProposal, type Launcher } from "../src/pipeline/interactive.ts";
import { draftSkill } from "../src/pipeline/render.ts";
import { reviseProposal } from "../src/pipeline/revise.ts";
import { reviewFeedbackPrompt } from "../src/pipeline/review.ts";
import { syncTree } from "../src/pipeline/sync.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Feedback } from "../src/state/feedback.ts";
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
const writeDraft = (body: string) => [
  fauxAssistantMessage([fauxToolCall("write", { path: PATH, content: md(body) })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("report_draft", { summary: "draft" })], { stopReason: "toolUse" }),
];

async function setup() {
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  await syncTree(tree, { skillsDir, declared: [] });
  const root = tree.ensureRoot({ scope: "global" });
  const dot = tree.createNode(root, { title: "Dotfiles", name: "dotfiles-management" });
  for (const s of ["a", "b", "c"]) tree.attachNugget(db.insertNugget(nugget(s)), dot);
  scoreTree(tree, cfg.score);
  const draft = async (body = "v1") => (await draftSkill(tree, await fauxRunner(writeDraft(body)), cfg, dot)) as { proposalId: number };
  return { cfg, db, tree, root, dot, draft, props: new Proposals(db), fb: new Feedback(db) };
}

/** A pi session file as pi writes it: header, then messages linked by parentId. */
function piSession(dir: string, messages: { role: "user" | "assistant"; text: string }[]): void {
  mkdirSync(dir, { recursive: true });
  const lines: unknown[] = [{ type: "session", version: 3, id: "s1", timestamp: "2026-11-05T10:00:00Z", cwd: "/tmp/lbg-draft-x" }];
  let parent: string | null = null;
  messages.forEach((m, i) => {
    const id = `m${i}`;
    const content = m.role === "user" ? m.text : [{ type: "text", text: m.text }];
    lines.push({ type: "message", id, parentId: parent, timestamp: `2026-11-05T10:00:0${i}Z`, message: { role: m.role, content } });
    parent = id;
  });
  writeFileSync(join(dir, "2026-11-05T10-00-00_s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("Feedback store", () => {
  it("stores feedback redacted, per proposal and per skill", async () => {
    const { draft, fb, dot } = await setup();
    const { proposalId } = await draft();
    fb.add({ proposalId, kind: "revise", text: "use key AKIAABCDEFGHIJKLMNOP for the bucket" });
    expect(fb.forProposal(proposalId)[0]).toMatchObject({ kind: "revise", text: expect.stringContaining("[REDACTED:aws-access-key]"), proposalStatus: "open" });
    expect(fb.forNode(dot).map((f) => f.kind)).toEqual(["revise"]);
    expect(() => fb.add({ proposalId, kind: "nope" as never, text: "" })).toThrow(/Bad feedback kind/);
    expect(() => fb.add({ proposalId: 999, kind: "revise", text: "" })).toThrow(/No proposal/);
  });

  it("follows the proposal when the skill's node is replaced", async () => {
    const { draft, fb, tree, dot, root, props } = await setup();
    const { proposalId } = await draft();
    rejectProposal(tree, proposalId, "too broad");
    const heir = tree.createNode(root, { title: "Dotfiles v2", name: "dotfiles" });
    tree.updateNode(dot, { status: "open" });
    for (const n of tree.subtree(dot)!.nuggets) tree.attachNugget(n.id, heir);
    expect(tree.removeNode(dot, heir)).toBe(true);
    expect(props.get(proposalId)!.nodeId).toBe(heir);
    expect(fb.forNode(heir).map((f) => [f.kind, f.text])).toEqual([["reject", "too broad"]]);
  });
});

describe("capture", () => {
  it("reject keeps the reason (or that there was none)", async () => {
    const { draft, fb, tree } = await setup();
    const a = await draft();
    rejectProposal(tree, a.proposalId, "  outdated: we moved to chezmoi  ");
    expect(fb.forProposal(a.proposalId)).toMatchObject([{ kind: "reject", text: "outdated: we moved to chezmoi", proposalStatus: "rejected" }]);
  });

  it("one-shot revise keeps my feedback, even when the redraft fails", async () => {
    const { draft, fb, tree, cfg } = await setup();
    const { proposalId } = await draft();
    const runner = await fauxRunner([fauxAssistantMessage([fauxToolCall("report_draft", { summary: "nothing" })], { stopReason: "toolUse" })]);
    await reviseProposal(tree, runner, cfg, proposalId, "tmux config lives in ~/.tmux.conf.local, not ~/.tmux.conf");
    expect(fb.forProposal(proposalId)).toMatchObject([{ kind: "revise", text: "tmux config lives in ~/.tmux.conf.local, not ~/.tmux.conf" }]);
  });

  it("chat keeps my turns from pi's session file, not lbg's opening message", async () => {
    const { draft, fb, tree, cfg } = await setup();
    const { proposalId } = await draft();
    const launcher: Launcher = (_cmd, args, opts) => {
      const dir = args[args.indexOf("--session-dir") + 1]!;
      piSession(dir, [
        { role: "user", text: args.at(-1)! }, // lbg's opening
        { role: "assistant", text: "The draft covers zsh and tmux. What should change?" },
        { role: "user", text: "drop the Homebrew part, I use mise everywhere" },
        { role: "assistant", text: "Removed it." },
      ]);
      writeFileSync(join(opts.cwd, PATH), md("v2 without Homebrew"));
      return 0;
    };
    await chatRevise(tree, cfg, proposalId, { launcher, ask: async () => false });
    const [f] = fb.forProposal(proposalId);
    expect(f).toMatchObject({ kind: "chat", text: "drop the Homebrew part, I use mise everywhere" });
    expect(f!.turns!.map((t) => t.role)).toEqual(["assistant", "user", "assistant"]);
  });

  it("a chat where I said nothing stores nothing", async () => {
    const { draft, fb, tree, cfg } = await setup();
    const { proposalId } = await draft();
    const launcher: Launcher = (_c, args) => (piSession(args[args.indexOf("--session-dir") + 1]!, [{ role: "user", text: args.at(-1)! }]), 0);
    await chatRevise(tree, cfg, proposalId, { launcher, ask: async () => false });
    expect(fb.forProposal(proposalId)).toEqual([]);
  });

  it("edit keeps the diff of the AI draft against my version, only when I changed it", async () => {
    const { draft, fb, tree, cfg } = await setup();
    const { proposalId } = await draft("Install with Homebrew.");
    const noop: Launcher = () => 0;
    await editProposal(tree, cfg, proposalId, { launcher: noop, ask: async () => false, editor: "true" });
    expect(fb.forProposal(proposalId)).toEqual([]);
    const edit: Launcher = (_c, _a, opts) => (writeFileSync(join(opts.cwd, PATH), md("Install with mise.")), 0);
    await editProposal(tree, cfg, proposalId, { launcher: edit, ask: async () => false, editor: "true" });
    const [f] = fb.forProposal(proposalId);
    expect(f).toMatchObject({ kind: "edit", text: `Edited the draft by hand: ${PATH}` });
    expect(f!.diff).toContain("-Install with Homebrew.");
    expect(f!.diff).toContain("+Install with mise.");
  });

  it("reads turns from nested session dirs; missing dir → none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-chat-"));
    piSession(join(dir, "sessions", "--tmp-lbg-draft-x--"), [{ role: "user", text: "hi there, keep it short" }]);
    expect(await readChatTurns(join(dir, "sessions"))).toEqual([{ role: "user", text: "hi there, keep it short" }]);
    expect(await readChatTurns(join(dir, "nope"))).toEqual([]);
  });
});

describe("drafting sees review feedback", () => {
  it("a redraft after a reject sees the reason and my earlier revisions; nearby skills see the rejection", async () => {
    const { draft, tree, cfg, db, dot, root } = await setup();
    const first = await draft();
    await reviseProposal(
      tree,
      await fauxRunner([fauxAssistantMessage([fauxToolCall("report_draft", { summary: "x" })], { stopReason: "toolUse" })]),
      cfg,
      first.proposalId,
      "never mention Homebrew",
    );
    rejectProposal(tree, first.proposalId, "too broad: split tmux into its own skill");

    // the skill comes back with new evidence and is drafted again
    for (const s of ["d", "e"]) tree.attachNugget(db.insertNugget(nugget(s)), dot);
    scoreTree(tree, cfg.score);
    expect(tree.getNode(dot)!.status).toBe("candidate");
    let prompt = "";
    const runner = await fauxRunner([
      (ctx) => {
        prompt = JSON.stringify((ctx as { messages: unknown[] }).messages);
        return writeDraft("v2")[0]!;
      },
      writeDraft("v2")[1]!,
    ]);
    await draftSkill(tree, runner, cfg, dot);
    expect(prompt).toContain("<review_feedback>");
    expect(prompt).toContain('REJECTED: \\"too broad: split tmux into its own skill\\"');
    expect(prompt).toContain('asked for a revision: \\"never mention Homebrew\\"');
    expect(prompt.indexOf("REJECTED")).toBeLessThan(prompt.indexOf("asked for a revision")); // newest first

    // a sibling skill's draft sees that rejection as "nearby"
    const tmux = tree.createNode(root, { title: "tmux", name: "tmux" });
    const nearby = reviewFeedbackPrompt(tree, tree.getNode(tmux)!);
    expect(nearby).toContain("<rejected_nearby>");
    expect(nearby).toContain('- dotfiles-management: rejected');
    expect(nearby).not.toContain("<review_feedback>");
  });

  it("is size-capped and empty when there is nothing", async () => {
    const { draft, tree, fb, dot } = await setup();
    expect(reviewFeedbackPrompt(tree, tree.getNode(dot)!)).toBe("");
    const { proposalId } = await draft();
    for (let i = 0; i < 50; i++) fb.add({ proposalId, kind: "revise", text: `feedback ${i} ${"x".repeat(200)}` });
    const p = reviewFeedbackPrompt(tree, tree.getNode(dot)!, { maxChars: 2000 });
    expect(p.length).toBeLessThanOrEqual(2000);
    expect(p).toContain("feedback 49"); // newest kept
    expect(p).not.toContain("feedback 0 ");
    expect(p.trimEnd().endsWith("</review_feedback>")).toBe(true);
  });
});

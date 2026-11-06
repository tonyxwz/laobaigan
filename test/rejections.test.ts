import { mkdtemp } from "node:fs/promises";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { rejectProposal } from "../src/pipeline/accept.ts";
import { buildClassifyPrompt } from "../src/pipeline/classify.ts";
import { exitCode, runPipeline } from "../src/pipeline/run.ts";
import { MIGRATIONS, StateDb } from "../src/state/db.ts";
import { Feedback } from "../src/state/feedback.ts";
import { Rejections } from "../src/state/rejections.ts";
import { setup as proposalSetup } from "./proposals.test.ts";

/** A runner that must never be called. */
const noCalls: PiRunner = {
  async run() {
    throw new Error("no model call expected");
  },
};

class Classifier implements PiRunner {
  prompts: string[] = [];
  answer: (prompt: string) => unknown = () => ({ kind: "not-useful", rule: "Don't propose a skill about tmux key bindings." });
  fail = false;
  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    if (req.resultTool.name !== "classify_rejection") throw new Error(`unexpected ${req.resultTool.name}`);
    this.prompts.push(req.prompt);
    if (this.fail) throw new Error("model unavailable");
    return { value: this.answer(req.prompt) as Static<S>, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 } };
  }
}

/** An open proposal on a latent skill, plus a sibling skill to point wrong-place at. */
function setup() {
  const s = proposalSetup();
  const id = s.props.create(s.draft());
  s.props.markOpen(id, [{ path: "dotfiles-management/SKILL.md", baseHash: null, content: "x" }], "draft");
  // a latent skill with evidence (sync keeps it; a file-origin node with no file would be removed)
  const sibling = s.tree.createNode(s.root, { title: "Cloud credentials", name: "cloud-credentials", description: "vault login profiles" });
  s.tree.attachNugget(s.db.insertNugget({ runId: 1, agent: "pi", sessionId: "z", cwd: "/", kind: "fact", title: "vault login", knowledge: "vault login", triggers: [], scope: "global", confidence: 0.9, evidence: [] }), sibling);
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir: realpathSync(tmpdir()), stateDir: mkdtempSync(join(tmpdir(), "lbg-state-")) };
  return { ...s, proposalId: id, sibling, cfg, mem: new Rejections(s.db) };
}

const deps = (s: ReturnType<typeof setup>, runner: PiRunner) => ({ adapters: [], db: s.db, runner, cfg: s.cfg });

describe("lbg proposal reject → rejection memory", () => {
  it("makes no model call and leaves a pending memory with a topic snapshot", () => {
    const s = setup();
    const r = rejectProposal(s.tree, s.proposalId, "tmux key bindings are personal, not worth a skill");
    expect(r).toEqual({ memoryId: 1, status: "pending", forgotten: 0 });
    const m = s.mem.mustGet(r.memoryId);
    expect(m).toMatchObject({
      proposalId: s.proposalId,
      nodeId: s.skill,
      scope: "global",
      status: "pending",
      locked: false,
      reason: "tmux key bindings are personal, not worth a skill",
      topic: { name: "dotfiles-management", title: "Dotfiles", proposalKind: "new", evidence: s.ids.map((id) => ({ id, title: expect.any(String) })) },
    });
    expect(m.kind).toBeUndefined();
    expect(new Feedback(s.db).forProposal(s.proposalId).map((f) => f.kind)).toEqual(["reject"]);
    expect(s.tree.getNode(s.skill)!.status).toBe("rejected");
  });

  it("--kind is used right away (locked, reason as rule); --to only with wrong-place in the same scope", () => {
    const s = setup();
    expect(() => rejectProposal(s.tree, s.proposalId, "x", { kind: "later", targetNodeId: s.sibling })).toThrow(/only goes with --kind wrong-place/);
    expect(() => rejectProposal(s.tree, s.proposalId, "x", { kind: "wrong-place", targetNodeId: s.skill })).toThrow(/rejected skill itself/);
    const repoSkill = s.tree.createNode(s.tree.ensureRoot({ scope: "repo", repo: "/w/A" }), { title: "repo skill" });
    expect(() => rejectProposal(s.tree, s.proposalId, "x", { kind: "wrong-place", targetNodeId: repoSkill })).toThrow(/another scope/);
    expect(s.props.get(s.proposalId)!.status).toBe("open"); // nothing happened

    const r = rejectProposal(s.tree, s.proposalId, "vault login steps belong with the credentials skill", { kind: "wrong-place", targetNodeId: s.sibling });
    expect(r).toMatchObject({ status: "active", kind: "wrong-place" });
    expect(s.mem.mustGet(r.memoryId)).toMatchObject({ kind: "wrong-place", rule: "vault login steps belong with the credentials skill", targetNodeId: s.sibling, locked: true, status: "active" });
  });

  it("no reason: active as 'later', unlocked so I can still edit it", () => {
    const s = setup();
    const r = rejectProposal(s.tree, s.proposalId);
    expect(s.mem.mustGet(r.memoryId)).toMatchObject({ kind: "later", rule: "rejected without a reason", status: "active", locked: false });
  });
});

describe("lbg run's extract stage classifies rejections (before sessions)", () => {
  it("classifies pending memories; nothing pending → no call", async () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.proposalId, "tmux key bindings are personal");
    const c = new Classifier();
    const r = await runPipeline(deps(s, c));
    expect(r.stages.map((x) => x.stage)).toEqual(["sync", "extract", "insert", "score", "draft"]);
    expect(r.stages[1]).toMatchObject({ status: "ok", calls: 1, summary: "0 session(s) extracted, 0 new nugget(s); 1 rejection(s) classified" });
    expect(r.rejections).toEqual([{ id: memoryId, kind: "not-useful", rule: "Don't propose a skill about tmux key bindings." }]);
    expect(s.mem.mustGet(memoryId)).toMatchObject({ status: "active", kind: "not-useful", locked: false });
    expect(c.prompts[0]).toContain("tmux key bindings are personal");
    expect(c.prompts[0]).toContain(`id ${s.sibling}: cloud-credentials`);
    expect(c.prompts[0]).not.toContain(`id ${s.skill}:`); // not offered as its own target

    const again = await runPipeline(deps(s, noCalls));
    expect(again.stages[1]).toMatchObject({ calls: 0, summary: "0 session(s) extracted, 0 new nugget(s)" });
  });

  it("wrong-place gets a target from the scope's skills; an unknown target is dropped", async () => {
    const s = setup();
    const a = rejectProposal(s.tree, s.proposalId, "this is about vault login, it belongs with the credentials skill").memoryId;
    const c = new Classifier();
    c.answer = () => ({ kind: "wrong-place", rule: "File vault login steps under cloud-credentials.", targetSkillId: s.sibling });
    const r = await runPipeline(deps(s, c), { stages: ["extract"] });
    expect(r.rejections).toEqual([{ id: a, kind: "wrong-place", rule: "File vault login steps under cloud-credentials.", target: "cloud-credentials" }]);
    expect(s.mem.mustGet(a).targetNodeId).toBe(s.sibling);

    // second memory, classifier names a skill that isn't in the scope
    const p2 = s.props.create(s.draft());
    s.props.markOpen(p2, [], "d");
    const b = rejectProposal(s.tree, p2, "wrong place again").memoryId;
    c.answer = () => ({ kind: "wrong-place", rule: "Elsewhere.", targetSkillId: 99999 });
    await runPipeline(deps(s, c), { stages: ["extract"] });
    expect(s.mem.mustGet(b)).toMatchObject({ kind: "wrong-place", status: "active" });
    expect(s.mem.mustGet(b).targetNodeId).toBeUndefined();
  });

  it("model errors leave memories pending (with the error) for the next run", async () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.proposalId, "outdated: we moved to mise");
    const c = new Classifier();
    c.fail = true;
    const r = await runPipeline(deps(s, c), { stages: ["extract"] });
    expect(r.stages[0]).toMatchObject({ stage: "extract", status: "error", calls: 1 });
    expect(r.abortedReason).toBeUndefined(); // one failure: sessions still ran
    expect(s.mem.mustGet(memoryId)).toMatchObject({ status: "pending", error: "model unavailable" });
    c.fail = false;
    c.answer = () => ({ kind: "outdated", rule: "Use mise, not nvm, for Node versions." });
    await runPipeline(deps(s, c), { stages: ["extract"] });
    expect(s.mem.mustGet(memoryId)).toMatchObject({ status: "active", kind: "outdated" });
    expect(s.mem.mustGet(memoryId).error).toBeUndefined();
  });
});

describe("repeated classification errors", () => {
  it("skip the session part and the later model stages (exit 3)", async () => {
    const s = setup();
    rejectProposal(s.tree, s.proposalId, "first");
    const p2 = s.props.create(s.draft());
    s.props.markOpen(p2, [], "d");
    rejectProposal(s.tree, p2, "second");
    const c = new Classifier();
    c.fail = true;
    let sessionsListed = false;
    const adapter = {
      agent: "pi" as const,
      available: async () => true,
      async *list() {
        sessionsListed = true;
      },
      load: async () => {
        throw new Error("unused");
      },
    };
    const r = await runPipeline({ ...deps(s, c), adapters: [adapter] });
    expect(sessionsListed).toBe(false);
    expect(r.abortedReason).toMatch(/2 consecutive model errors classifying rejections/);
    expect(r.stages.find((x) => x.stage === "extract")).toMatchObject({ status: "error", calls: 2, summary: expect.stringContaining("sessions skipped (model errors)") });
    expect(r.stages.filter((x) => x.status === "skipped").map((x) => x.stage)).toEqual(["insert", "draft"]);
    expect(exitCode(r)).toBe(3);
  });
});

describe("lbg rejections edit | forget", () => {
  it("edit locks (never reclassified); forget stops using it", async () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.proposalId, "meh");
    expect(() => s.mem.edit(memoryId, { rule: "x" })).toThrow(/isn't classified yet; give --kind/);
    const m = s.mem.edit(memoryId, { kind: "not-useful", rule: "No skill about tmux key bindings." });
    expect(m).toMatchObject({ kind: "not-useful", rule: "No skill about tmux key bindings.", status: "active", locked: true });
    expect(s.mem.classify(memoryId, { kind: "later", rule: "nope" })).toBe(false);
    await runPipeline(deps(s, noCalls), { stages: ["extract"] });
    expect(s.mem.mustGet(memoryId).kind).toBe("not-useful");

    s.mem.forget(memoryId);
    expect(s.mem.list(["pending", "active"])).toEqual([]);
    expect(s.mem.mustGet(memoryId).status).toBe("removed");
    expect(() => s.mem.edit(memoryId, { rule: "x" })).toThrow(/forgotten/);
  });

  it("rules are one line, redacted, bounded", () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.proposalId, "multi\nline token=abcdef123456 " + "x".repeat(400), { kind: "later" });
    const rule = s.mem.mustGet(memoryId).rule!;
    expect(rule).not.toContain("\n");
    expect(rule).not.toContain("abcdef123456");
    expect(rule.length).toBeLessThanOrEqual(240);
  });

  it("memories follow their node when it is replaced", () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.proposalId, "x", { kind: "wrong-place", targetNodeId: s.sibling });
    const heir = s.tree.createNode(s.root, { title: "credentials (new)" });
    s.tree.removeNode(s.sibling, heir);
    expect(s.mem.mustGet(memoryId).targetNodeId).toBe(heir);
  });
});

describe("migration 16", () => {
  it("applies on a v15 database", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lbg-mem-")), "state.db");
    const raw = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 15)) raw.exec(m);
    raw.exec("PRAGMA user_version = 15");
    raw.close();
    const db = new StateDb(path);
    expect(new Rejections(db).list()).toEqual([]);
  });
});

describe("classify prompt", () => {
  it("lists the kinds' inputs", () => {
    const s = setup();
    const { memoryId } = rejectProposal(s.tree, s.proposalId, "stale");
    const p = buildClassifyPrompt(s.mem.mustGet(memoryId), []);
    expect(p).toContain("Reason given by the engineer:\nstale");
    expect(p).toContain("Rejected proposal: a new skill");
  });
});

import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { exitCode, runPipeline } from "../src/pipeline/run.ts";
import type { SessionRef, SourceAdapter, Transcript, Turn } from "../src/sources/types.ts";
import { StateDb } from "../src/state/db.ts";
import { Proposals } from "../src/state/proposals.ts";
import { Tree } from "../src/state/tree.ts";

const ts = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));

class FakeAdapter implements SourceAdapter {
  readonly agent = "pi" as const;
  sessions = new Map<string, Turn[]>();
  available = async () => true;
  async *list(): AsyncIterable<SessionRef> {
    for (const [id] of this.sessions) yield { agent: "pi", sessionId: id, location: `/fake/${id}`, cwd: "/nonexistent", updatedAt: ts(0), version: "1" };
  }
  async load(ref: SessionRef): Promise<Transcript> {
    return { agent: "pi", sessionId: ref.sessionId, location: ref.location, cwd: "/nonexistent", startedAt: ts(0), updatedAt: ts(0), turns: this.sessions.get(ref.sessionId)! };
  }
}

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 };

/**
 * Answers each stage's result tool: one tmux nugget per session, all routed into a new
 * "tmux-config" skill, drafted as a valid SKILL.md written into the guarded scratch dir.
 */
class StageRunner implements PiRunner {
  calls: string[] = [];
  failOn = new Set<string>();
  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    const tool = req.resultTool.name;
    this.calls.push(tool);
    if (this.failOn.has(tool)) throw new Error(`${tool}: model unavailable`);
    const ids = [...req.prompt.matchAll(/<nugget id="(\d+)"/g)].map((m) => Number(m[1]));
    let value: unknown;
    if (tool === "report_knowledge") {
      value = {
        nuggets: [{ kind: "fact", title: "tmux config", knowledge: "tmux config lives in ~/.tmux.conf.local", triggers: ["tmux"], scope: "global", evidence: [{ label: "U1", quote: "tmux.conf.local" }], confidence: 0.9 }],
      };
    } else if (tool === "route_to_skills") {
      value = { newSkills: [{ key: "t", title: "tmux configuration", name: "tmux-config", description: "Use when editing tmux config." }], placements: ids.map((nuggetId) => ({ nuggetId, newSkillKey: "t" })) };
    } else if (tool === "route_to_sections") {
      value = { newSections: [], placements: ids.map((nuggetId) => ({ nuggetId, body: true })) };
    } else if (tool === "report_draft") {
      const dir = join(req.fileGuard!.root, "tmux-config");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: tmux-config\ndescription: Use when editing tmux config.\n---\n\n# tmux\n\nConfig lives in ~/.tmux.conf.local.\n");
      value = { summary: "New tmux skill." };
    } else throw new Error(`unexpected tool ${tool}`);
    return { value: value as Static<S>, usage };
  }
}

async function setup() {
  const skillsDir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-skills-")));
  const cfg: Config = { ...DEFAULT_CONFIG, skillsDir, settleMinutes: 0 };
  const adapter = new FakeAdapter();
  for (const id of ["a", "b", "c"]) adapter.sessions.set(id, [{ role: "user", text: `my tmux config is in ~/.tmux.conf.local, remember that (${id})`, ts: ts(1), origin: "prompt" }]);
  const db = new StateDb(":memory:");
  const runner = new StageRunner();
  let clock = new Date(); // proposals record real close times; the backoff compares against them
  const deps = { adapters: [adapter], db, runner, cfg, now: () => clock };
  return { skillsDir, cfg, adapter, db, runner, deps, advance: (h: number) => (clock = new Date(clock.getTime() + h * 3600e3)) };
}

describe("runPipeline", () => {
  it("goes from sessions to an open proposal, then makes no calls when nothing is new", async () => {
    const { db, runner, deps, skillsDir } = await setup();
    const r = await runPipeline(deps);
    expect(r.stages.map((s) => [s.stage, s.status])).toEqual([
      ["sync", "ok"],
      ["extract", "ok"],
      ["insert", "ok"],
      ["score", "ok"],
      ["draft", "ok"],
    ]);
    expect(runner.calls).toEqual(["report_knowledge", "report_knowledge", "report_knowledge", "route_to_skills", "route_to_sections", "report_draft"]);
    expect(r.proposals).toEqual([{ id: 1, nodeId: expect.any(Number), skill: "tmux-config", files: 1, cost: 0.01 }]);
    expect(r.calls).toBe(6);
    expect(r.usage.cost).toBeCloseTo(0.06);
    expect(exitCode(r)).toBe(0);
    expect(existsSync(join(skillsDir, "tmux-config"))).toBe(false); // only proposed, not written

    // the run log has one row with every stage
    const row = db.db.prepare("SELECT kind, stats FROM run").all() as { kind: string; stats: string }[];
    expect(row.map((x) => x.kind)).toEqual(["run"]);
    expect(JSON.parse(row[0]!.stats).stages.map((s: { stage: string; calls: number }) => [s.stage, s.calls])).toEqual([
      ["sync", 0],
      ["extract", 3],
      ["insert", 2],
      ["score", 0],
      ["draft", 1],
    ]);

    // nothing new: no model calls; the proposed skill isn't drafted again
    runner.calls = [];
    const again = await runPipeline(deps);
    expect(runner.calls).toEqual([]);
    expect(again.calls).toBe(0);
    expect(again.stages.find((s) => s.stage === "draft")!.summary).toBe("no candidates to draft");
  });

  it("skips the remaining model stages after repeated model errors (exit 3)", async () => {
    const { runner, deps } = await setup();
    runner.failOn.add("report_knowledge");
    const r = await runPipeline(deps);
    expect(r.abortedReason).toMatch(/consecutive model errors/);
    expect(r.stages.map((s) => [s.stage, s.status])).toEqual([
      ["sync", "ok"],
      ["extract", "ok"],
      ["insert", "skipped"],
      ["score", "ok"],
      ["draft", "skipped"],
    ]);
    expect(exitCode(r)).toBe(3);
  });

  it("a failed draft is a failed stage (exit 2) and isn't retried for retryAfterHours", async () => {
    const { runner, deps, db, advance } = await setup();
    runner.failOn.add("report_draft");
    const r = await runPipeline(deps);
    expect(r.stages.find((s) => s.stage === "draft")).toMatchObject({ status: "error", error: expect.stringMatching(/tmux-config: .*model unavailable/) });
    expect(exitCode(r)).toBe(2);
    expect(new Proposals(db).list(["failed"])).toHaveLength(1);

    runner.calls = [];
    advance(1);
    await runPipeline(deps);
    expect(runner.calls).toEqual([]); // backing off

    runner.failOn.clear();
    advance(24);
    const later = await runPipeline(deps);
    expect(runner.calls).toEqual(["report_draft"]);
    expect(later.proposals).toHaveLength(1);
  });

  it("runs only the requested stages and respects the insert budget", async () => {
    const { runner, deps, db } = await setup();
    const r = await runPipeline({ ...deps, cfg: { ...deps.cfg, insert: { maxCallsPerRun: 0 } } }, { stages: ["extract", "insert"] });
    expect(r.stages.map((s) => s.stage)).toEqual(["extract", "insert"]);
    expect(r.stages[1]!.summary).toMatch(/3 deferred/);
    expect(runner.calls).toEqual(["report_knowledge", "report_knowledge", "report_knowledge"]);
    expect(new Tree(db).unplacedNuggets()).toHaveLength(3);
  });
});

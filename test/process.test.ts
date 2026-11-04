import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, type Config } from "../src/config.ts";
import type { PiRequest, PiResult, PiRunner } from "../src/pi/run-pi.ts";
import { processSessions } from "../src/pipeline/process.ts";
import type { SessionRef, SourceAdapter, Transcript, Turn } from "../src/sources/types.ts";
import { StateDb } from "../src/state/db.ts";

const ts = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
const user = (text: string, m: number): Turn => ({ role: "user", text, ts: ts(m), origin: "prompt" });
const asst = (text: string, m: number): Turn => ({ role: "assistant", text, ts: ts(m) });

/** In-memory adapter whose sessions can be mutated between runs. */
class FakeAdapter implements SourceAdapter {
  readonly agent = "pi" as const;
  sessions = new Map<string, { turns: Turn[]; version: string }>();
  available = async () => true;
  async *list(): AsyncIterable<SessionRef> {
    for (const [id, s] of this.sessions)
      yield { agent: "pi", sessionId: id, location: `/fake/${id}`, cwd: "/nonexistent", updatedAt: ts(0), version: s.version };
  }
  async load(ref: SessionRef): Promise<Transcript> {
    const s = this.sessions.get(ref.sessionId)!;
    return { agent: "pi", sessionId: ref.sessionId, location: ref.location, cwd: "/nonexistent", startedAt: ts(0), updatedAt: ts(0), turns: s.turns };
  }
}

/** Runner that records prompts and returns one nugget citing the last U-label it sees. */
class FakeRunner implements PiRunner {
  prompts: string[] = [];
  fail = false;
  async run<S extends TSchema>(req: PiRequest<S>): Promise<PiResult<Static<S>>> {
    this.prompts.push(req.prompt);
    if (this.fail) throw new Error("bedrock down");
    const labels = [...req.prompt.matchAll(/\[(U\d+)/g)].map((m) => m[1]!);
    const value = {
      nuggets: [
        {
          kind: "correction",
          title: "Use make",
          knowledge: "Always `make release`.",
          triggers: ["building"],
          scope: "global",
          evidence: [{ label: labels[labels.length - 1] ?? "U1", quote: "make" }, { label: "C", quote: "x" }],
          confidence: 0.9,
        },
      ],
    };
    return { value: value as Static<S>, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 } };
  }
}

const cfg: Config = {
  ...DEFAULT_CONFIG,
  skillsDir: "/nonexistent",
  settleMinutes: 0,
};

describe("processSessions", () => {
  it("extracts once, skips unchanged, re-extracts only new turns on resume, dedups copied history", async () => {
    const db = new StateDb(":memory:");
    const adapter = new FakeAdapter();
    const runner = new FakeRunner();
    adapter.sessions.set("a", {
      version: "1",
      turns: [user("build it", 1), asst("npm run build", 2), user("no, use make release", 3)],
    });

    // run 1: extracts
    let res = await processSessions([adapter], db, runner, cfg);
    expect(res.outcomes.map((o) => o.status)).toEqual(["extracted"]);
    expect(res.outcomes[0]!.nuggets![0]!.evidence).toEqual([{ label: "U2", quote: "make" }]);
    expect(db.counts()).toMatchObject({ extracted: 1, nuggets: 1, turnsSeen: 2 });

    // run 2: unchanged version → no model call
    res = await processSessions([adapter], db, runner, cfg);
    expect(res.outcomes.map((o) => o.status)).toEqual(["up-to-date"]);
    expect(runner.prompts).toHaveLength(1);

    // run 3: resumed in place → only the new turn is labelled U, old ones are context
    adapter.sessions.get("a")!.version = "2";
    adapter.sessions.get("a")!.turns.push(asst("ok", 4), user("and the logs are in /apollo/env/X/var/output/logs", 5));
    res = await processSessions([adapter], db, runner, cfg);
    expect(res.outcomes.map((o) => o.status)).toEqual(["extracted"]);
    const p = runner.prompts[1]!;
    expect(p).toContain("[C 2026-01-01 00:01] USER:");
    expect(p).toContain("[U1 2026-01-01 00:05] USER:");
    expect(p).not.toContain("[U2");

    // run 4: a new session that copies the history (resume into a new file) → nothing new
    adapter.sessions.set("b", { version: "1", turns: [...adapter.sessions.get("a")!.turns] });
    res = await processSessions([adapter], db, runner, cfg);
    expect(res.outcomes.find((o) => o.ref.sessionId === "b")).toMatchObject({ status: "skipped", detail: "no new human turns" });
    expect(runner.prompts).toHaveLength(2);
  });

  it("retries a session after a model error, and records nothing in plan/dry-run mode", async () => {
    const db = new StateDb(":memory:");
    const adapter = new FakeAdapter();
    const runner = new FakeRunner();
    adapter.sessions.set("a", { version: "1", turns: [user("the deploy account is the dev one, use profile aws-bench", 1)] });

    expect((await processSessions([adapter], db, runner, cfg, { plan: true })).outcomes[0]!.status).toBe("planned");
    expect((await processSessions([adapter], db, runner, cfg, { dryRun: true })).outcomes[0]!.status).toBe("extracted");
    expect(db.counts()).toMatchObject({ sessions: 0, nuggets: 0, turnsSeen: 0 });

    runner.fail = true;
    expect((await processSessions([adapter], db, runner, cfg)).outcomes[0]).toMatchObject({ status: "error", detail: "bedrock down" });
    expect(db.counts()).toMatchObject({ errors: 1, turnsSeen: 0 });

    runner.fail = false;
    expect((await processSessions([adapter], db, runner, cfg)).outcomes[0]!.status).toBe("extracted");
    expect(db.counts()).toMatchObject({ errors: 0, extracted: 1, nuggets: 1 });
  });

  it("respects the call budget", async () => {
    const db = new StateDb(":memory:");
    const adapter = new FakeAdapter();
    for (const id of ["a", "b", "c"]) adapter.sessions.set(id, { version: "1", turns: [user(`fact ${id}: the build uses gradle`, 1)] });
    const res = await processSessions([adapter], db, new FakeRunner(), cfg, { maxCalls: 2 });
    expect(res.outcomes.map((o) => o.status)).toEqual(["extracted", "extracted", "deferred"]);
  });
});

describe("loadConfig", () => {
  it("merges the file over defaults and expands ~", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-cfg-"));
    const path = join(dir, "config.json");
    await writeFile(path, `{\n  // comment\n  "skillsDir": "~/my-skills",\n  "models": { "extract": "x" }\n}`);
    const c = loadConfig(path);
    expect(c.skillsDir).toMatch(/\/my-skills$/);
    expect(c.skillsDir).not.toContain("~");
    expect(c.models).toEqual({ extract: "x" }); // distill: pi's default
  });

  it("validates declared topics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-cfg-"));
    const path = join(dir, "config.json");
    const write = (topics: unknown) => writeFile(path, JSON.stringify({ topics }));
    await write([{ name: "dotfiles-management", description: "d", repo: "~/x", scope: "repo" }]);
    expect(loadConfig(path).topics[0]).toMatchObject({ name: "dotfiles-management", scope: "repo", repo: expect.not.stringContaining("~") });
    await write([{ name: "Dotfiles Management", description: "d" }]);
    expect(() => loadConfig(path)).toThrow(/lowercase/);
    await write([{ name: "x" }]);
    expect(() => loadConfig(path)).toThrow(/needs a description/);
    await write([{ name: "x", description: "d", scope: "repo" }]);
    expect(() => loadConfig(path)).toThrow(/no repo/);
    await write([{ name: "x", description: "d" }, { name: "x", description: "e" }]);
    expect(() => loadConfig(path)).toThrow(/duplicate/);
  });

  it("uses defaults when the file is missing", () => {
    expect(loadConfig("/nonexistent/config.json").models).toEqual({}); // everything follows pi
  });
});

describe("processSessions abort", () => {
  it("stops after N consecutive model errors instead of failing every session", async () => {
    const db = new StateDb(":memory:");
    const adapter = new FakeAdapter();
    for (const id of ["a", "b", "c", "d"]) adapter.sessions.set(id, { version: "1", turns: [user(`fact ${id}: builds use gradle`, 1)] });
    const runner = new FakeRunner();
    runner.fail = true;
    const res = await processSessions([adapter], db, runner, cfg, { maxConsecutiveErrors: 2 });
    expect(res.outcomes.map((o) => o.status)).toEqual(["error", "error", "aborted", "aborted"]);
    expect(res.abortedReason).toMatch(/2 consecutive model errors/);
    expect(runner.prompts).toHaveLength(2);
  });
});

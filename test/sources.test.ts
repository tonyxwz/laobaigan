import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter, classifyUserText } from "../src/sources/claude.ts";
import { OpencodeAdapter } from "../src/sources/opencode.ts";
import { PiAdapter } from "../src/sources/pi.ts";
import { scan } from "../src/sources/index.ts";
import type { SourceAdapter, Transcript } from "../src/sources/types.ts";

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

async function loadOnly(adapter: SourceAdapter): Promise<Transcript> {
  const refs = [];
  for await (const r of adapter.list()) refs.push(r);
  expect(refs).toHaveLength(1);
  return adapter.load(refs[0]!);
}

describe("ClaudeAdapter", () => {
  it("normalizes prompts, merges split assistant lines, maps tool results, flags rewinds", async () => {
    const root = await mkdtemp(join(tmpdir(), "lbg-claude-"));
    const dir = join(root, "-proj");
    await mkdir(dir);
    const base = { sessionId: "s1", cwd: "/proj", isSidechain: false };
    await writeFile(
      join(dir, "s1.jsonl"),
      jsonl([
        { type: "mode", mode: "normal", sessionId: "s1" },
        { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "build the pkg" } },
        { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } },
        { ...base, type: "assistant", uuid: "a2", parentUuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Running build" }] } },
        { ...base, type: "assistant", uuid: "a3", parentUuid: "a2", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run build" } }] } },
        { ...base, type: "user", uuid: "r1", parentUuid: "a3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "error: use make", is_error: true }] } },
        // rewound prompt (sibling of u2)
        { ...base, type: "user", uuid: "x1", parentUuid: "r1", message: { role: "user", content: "use gradle" } },
        { ...base, type: "user", uuid: "u2", parentUuid: "r1", message: { role: "user", content: "no, use `make release`" } },
        { ...base, type: "user", uuid: "n1", parentUuid: "u2", isMeta: true, message: { role: "user", content: "Base directory for this skill: /x" } },
        { ...base, type: "user", uuid: "n2", parentUuid: "n1", message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" } },
        { ...base, type: "user", uuid: "c1", parentUuid: "n2", message: { role: "user", content: "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR-1</command-args>" } },
        { ...base, type: "user", uuid: "sc", parentUuid: "c1", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
        { type: "ai-title", title: "Build pkg" },
      ]),
    );

    const t = await loadOnly(new ClaudeAdapter(root));
    expect(t.cwd).toBe("/proj");
    expect(t.title).toBe("Build pkg");
    expect(t.turns.map((x) => [x.role, x.origin, x.text, x.offBranch ?? false])).toEqual([
      ["user", "prompt", "build the pkg", false],
      ["assistant", undefined, "Running build", false],
      ["tool", undefined, "error: use make", false],
      ["user", "prompt", "use gradle", true],
      ["user", "prompt", "no, use `make release`", false],
      ["user", "command", "/review PR-1", false],
    ]);
    expect(t.turns[1]!.toolCalls).toEqual([{ name: "Bash", input: '{"command":"npm run build"}' }]);
    expect(t.turns[2]).toMatchObject({ toolName: "Bash", isError: true });
  });

  it("classifies user text noise", () => {
    expect(classifyUserText("<task-notification><id>1</id>")).toBeUndefined();
    expect(classifyUserText("   ")).toBeUndefined();
    expect(classifyUserText("[Request interrupted by user]")).toEqual({ text: "[Request interrupted by user]", origin: "interrupt" });
    expect(classifyUserText("<bash-input>ls -la</bash-input>")).toEqual({ text: "!ls -la", origin: "command" });
  });
});

describe("PiAdapter", () => {
  it("reads header, walks the tree in file order, flags off-branch entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "lbg-pi-"));
    const dir = join(root, "--proj--");
    await mkdir(dir);
    await writeFile(
      join(dir, "2026-01-01_p1.jsonl"),
      jsonl([
        { type: "session", version: 3, id: "p1", timestamp: "2026-01-01T00:00:00Z", cwd: "/proj" },
        { type: "model_change", id: "e0", parentId: null, provider: "x", modelId: "y" },
        { type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:01Z", message: { role: "system", content: "" } },
        { type: "message", id: "e2", parentId: "e1", message: { role: "user", content: [{ type: "text", text: "where are the logs?" }] } },
        { type: "message", id: "e3", parentId: "e2", message: { role: "assistant", content: [{ type: "thinking", thinking: "?" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls /var/log" } }] } },
        { type: "message", id: "e4", parentId: "e3", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "syslog" }] } },
        { type: "message", id: "e5", parentId: "e4", message: { role: "user", content: "wrong place" } }, // abandoned
        { type: "message", id: "e6", parentId: "e4", message: { role: "user", content: "logs are in /apollo/env/X/var/output/logs" } },
        { type: "message", id: "e7", parentId: "e6", message: { role: "bashExecution", command: "tail app.log", output: "ok", exitCode: 0 } },
        { type: "session_info", id: "e8", parentId: "e7", name: "Find logs" },
      ]),
    );

    const t = await loadOnly(new PiAdapter(root));
    expect(t.sessionId).toBe("p1");
    expect(t.cwd).toBe("/proj");
    expect(t.title).toBe("Find logs");
    expect(t.turns.map((x) => [x.role, x.text, x.offBranch ?? false])).toEqual([
      ["user", "where are the logs?", false],
      ["assistant", "", false],
      ["tool", "syslog", false],
      ["user", "wrong place", true],
      ["user", "logs are in /apollo/env/X/var/output/logs", false],
      ["user", "!tail app.log", false],
      ["tool", "ok", false],
    ]);
    expect(t.turns[1]!.toolCalls).toEqual([{ name: "bash", input: '{"command":"ls /var/log"}' }]);
  });
});

describe("OpencodeAdapter", () => {
  it("reads sessions and messages from sqlite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-oc-"));
    const dbPath = join(dir, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, directory text, title text, parent_id text,
               time_created integer, time_updated integer, time_archived integer);
             CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer,
               time_created integer, time_updated integer, data text);`);
    db.prepare(`INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)`).run("ses_1", "/proj", "Migrate", null, 1000, 5000, null);
    db.prepare(`INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)`).run("ses_old", "/proj", "Archived", null, 1000, 5000, 6000);
    const msg = db.prepare(`INSERT INTO session_message VALUES (?,?,?,?,?,?,?)`);
    msg.run("m1", "ses_1", "user", 1, 1000, 1000, JSON.stringify({ text: "migrate config" }));
    msg.run("m2", "ses_1", "assistant", 2, 2000, 2000, JSON.stringify({
      content: [
        { type: "text", text: "Checking" },
        { type: "tool", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a b" }] } },
      ],
    }));
    msg.run("m3", "ses_1", "idle", 3, 3000, 3000, JSON.stringify({ outcome: "succeeded" }));
    db.close();

    const t = await loadOnly(new OpencodeAdapter(dbPath));
    expect(t).toMatchObject({ sessionId: "ses_1", cwd: "/proj", title: "Migrate" });
    expect(t.turns.map((x) => [x.role, x.text])).toEqual([
      ["user", "migrate config"],
      ["assistant", "Checking"],
      ["tool", "a b"],
    ]);
    expect(t.turns[1]!.toolCalls).toEqual([{ name: "shell", input: '{"command":"ls"}' }]);
  });
});

describe("scan", () => {
  it("skips unavailable adapters and sessions that haven't settled", async () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const fake = (agent: "claude" | "pi", available: boolean, updated: string): SourceAdapter => ({
      agent,
      available: async () => available,
      async *list() {
        yield { agent, sessionId: agent, location: "", updatedAt: new Date(updated), version: "1" };
      },
      load: async () => {
        throw new Error("unused");
      },
    });
    const res = await scan(
      [fake("claude", true, "2026-01-01T00:59:00Z"), fake("pi", true, "2026-01-01T00:00:00Z"), fake("pi", false, "2026-01-01T00:00:00Z")],
      { settleMs: 30 * 60e3, now },
    );
    expect(res.map((r) => r.ref.sessionId)).toEqual(["pi"]);
  });
});

describe("unreadable sources", () => {
  it("skips an opencode 1.x database with a warning, and keeps scanning the other agents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-oc1-"));
    const dbPath = join(dir, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session (id text PRIMARY KEY, directory text, title text, time_updated integer);
             CREATE TABLE message (id text PRIMARY KEY, session_id text, data text);
             CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, data text);`);
    db.prepare("INSERT INTO session VALUES ('ses_1', '/proj', 't', 1000)").run();
    db.close();

    const other: SourceAdapter = {
      agent: "pi",
      available: async () => true,
      async *list() {
        yield { agent: "pi", sessionId: "p1", location: "", updatedAt: new Date(0), version: "1" };
      },
      load: async () => {
        throw new Error("unused");
      },
    };
    const warnings: [string, string][] = [];
    const res = await scan([new OpencodeAdapter(dbPath), other], { onWarning: (a, m) => warnings.push([a, m]) });
    expect(res.map((r) => r.ref.sessionId)).toEqual(["p1"]);
    expect(warnings).toEqual([["opencode", expect.stringMatching(/opencode 1\.x schema .*Upgrade opencode to 2\.x/)]]);

    // not an opencode database at all
    const odd = join(dir, "other.db");
    new DatabaseSync(odd).close();
    warnings.length = 0;
    await scan([new OpencodeAdapter(odd)], { onWarning: (a, m) => warnings.push([a, m]) });
    expect(warnings[0]![1]).toMatch(/no session_v2 table \(not an opencode 2\.x database\)/);
  });

  it("any adapter error only skips that agent", async () => {
    const broken: SourceAdapter = {
      agent: "claude",
      available: async () => true,
      // eslint-disable-next-line require-yield
      async *list() {
        throw new Error("EACCES: permission denied, scandir '/x'");
      },
      load: async () => {
        throw new Error("unused");
      },
    };
    const warnings: string[] = [];
    expect(await scan([broken], { onWarning: (_a, m) => warnings.push(m) })).toEqual([]);
    expect(warnings).toEqual(["EACCES: permission denied, scandir '/x'"]);
  });
});

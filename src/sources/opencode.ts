import { DatabaseSync } from "node:sqlite";
import { DEFAULT_LIMITS, DEFAULT_PATHS, type NormalizeLimits } from "../config.ts";
import { exists } from "../util/fs.ts";
import { isRecord, renderInput, str, toDate, truncate } from "../util/text.ts";
import { SourceUnavailable, type ListOptions, type SessionRef, type SourceAdapter, type ToolCall, type Transcript, type Turn } from "./types.ts";

/**
 * opencode (v2): SQLite at ~/.local/share/opencode/opencode.db
 *
 *  - `session_v2`: one row per session (directory, title, parent_id, time_* in epoch ms)
 *  - `session_message`: rows ordered by `seq`, `type` in {user, assistant, idle, ...},
 *    `data` is JSON. User: {text, files, agents}. Assistant: {content: [part...]} where
 *    parts are {type:"text", text} or {type:"tool", name, state:{input, content|output, error}}.
 *
 * The db is opened read-only; opencode may be writing concurrently (WAL mode).
 */
export class OpencodeAdapter implements SourceAdapter {
  readonly agent = "opencode" as const;

  private readonly dbPath: string;
  private readonly limits: NormalizeLimits;

  constructor(dbPath = DEFAULT_PATHS.opencodeDb, limits: NormalizeLimits = DEFAULT_LIMITS) {
    this.dbPath = dbPath;
    this.limits = limits;
  }

  available(): Promise<boolean> {
    return exists(this.dbPath);
  }

  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  async *list(opts: ListOptions = {}): AsyncIterable<SessionRef> {
    const since = opts.since?.getTime() ?? 0;
    const rows = this.withDb((db) => {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
      if (!tables.has("session_v2")) {
        throw new SourceUnavailable(
          tables.has("session")
            ? `${this.dbPath} uses the opencode 1.x schema (no session_v2 table). Upgrade opencode to 2.x and start it once to migrate it; skipping opencode sessions until then.`
            : `${this.dbPath} has no session_v2 table (not an opencode 2.x database); skipping opencode sessions.`,
        );
      }
      return db
        .prepare(
          `SELECT id, directory, title, time_updated FROM session_v2
           WHERE time_updated >= ? AND time_archived IS NULL ORDER BY time_updated`,
        )
        .all(since);
    });
    for (const r of rows) {
      const updated = Number(r.time_updated);
      yield {
        agent: this.agent,
        sessionId: String(r.id),
        location: this.dbPath,
        cwd: String(r.directory),
        ...(r.title ? { title: String(r.title) } : {}),
        updatedAt: new Date(updated),
        version: String(updated),
      };
    }
  }

  async load(ref: SessionRef): Promise<Transcript> {
    const { session, messages } = this.withDb((db) => ({
      session: db.prepare(`SELECT * FROM session_v2 WHERE id = ?`).get(ref.sessionId),
      messages: db
        .prepare(`SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq`)
        .all(ref.sessionId),
    }));
    if (!session) throw new Error(`opencode session not found: ${ref.sessionId}`);
    return parseOpencode(
      session,
      messages.map((m) => ({ type: String(m.type), timeCreated: Number(m.time_created), data: safeJson(m.data) })),
      ref,
      this.limits,
    );
  }
}

export interface OpencodeMessageRow {
  type: string;
  timeCreated: number;
  data: unknown;
}

export function parseOpencode(
  session: Record<string, unknown>,
  rows: OpencodeMessageRow[],
  ref: SessionRef,
  limits: NormalizeLimits,
): Transcript {
  const turns: Turn[] = [];
  for (const row of rows) {
    const d = isRecord(row.data) ? row.data : {};
    const ts = toDate(row.timeCreated);
    if (row.type === "user") {
      const text = (str(d.text) ?? "").trim();
      if (text) turns.push({ role: "user", text, ts, origin: text.startsWith("/") ? "command" : "prompt" });
      continue;
    }
    if (row.type !== "assistant" || !Array.isArray(d.content)) continue;

    // Flush text + tool calls as one assistant turn, followed by its tool results.
    const texts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const results: Turn[] = [];
    for (const p of d.content) {
      if (!isRecord(p)) continue;
      if (p.type === "text" && str(p.text)) texts.push(p.text as string);
      else if (p.type === "tool") {
        const name = str(p.name) ?? "unknown";
        const state = isRecord(p.state) ? p.state : {};
        toolCalls.push({ name, input: renderInput(state.input, limits.toolInputChars) });
        const error = str(state.error);
        const out = error ?? partsText(state.content) ?? str(state.output) ?? "";
        results.push({
          role: "tool",
          toolName: name,
          text: truncate(out, limits.toolResultChars),
          ts,
          ...(error || state.status === "error" ? { isError: true } : {}),
        });
      }
    }
    const text = texts.join("\n");
    if (text || toolCalls.length) turns.push({ role: "assistant", text, ts, ...(toolCalls.length ? { toolCalls } : {}) });
    turns.push(...results);
  }

  const parent = str(session.parent_id);
  const title = str(session.title);
  return {
    agent: "opencode",
    sessionId: ref.sessionId,
    location: ref.location,
    cwd: str(session.directory) ?? ref.cwd ?? "",
    ...(title ? { title } : {}),
    startedAt: toDate(session.time_created) ?? turns[0]?.ts ?? ref.updatedAt,
    updatedAt: toDate(session.time_updated) ?? ref.updatedAt,
    ...(parent ? { parentSessionId: parent } : {}),
    turns,
  };
}

function partsText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.map((c) => (isRecord(c) && c.type === "text" ? (str(c.text) ?? "") : "")).join("\n");
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

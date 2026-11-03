import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { DEFAULT_LIMITS, DEFAULT_PATHS, type NormalizeLimits } from "../config.ts";
import { exists, filesWithExt, readFirstJsonlLine, readJsonl, subdirs } from "../util/fs.ts";
import { isRecord, renderInput, str, toDate, truncate } from "../util/text.ts";
import { activeBranch } from "../util/tree.ts";
import type { ListOptions, SessionRef, SourceAdapter, ToolCall, Transcript, Turn } from "./types.ts";

/**
 * pi: ~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl
 *
 * First line is a `session` header ({id, cwd, timestamp, parentSession?}). Other
 * entries form a tree via `id` / `parentId`; the active leaf is the last entry.
 * Entries are emitted in file (chronological) order, ignoring compaction so
 * pre-compaction user messages are kept; entries off the leaf→root path are
 * flagged `offBranch`. See pi docs/session-format.md and docs/message-types.md.
 */
export class PiAdapter implements SourceAdapter {
  readonly agent = "pi" as const;

  private readonly root: string;
  private readonly limits: NormalizeLimits;

  constructor(root = DEFAULT_PATHS.piSessions, limits: NormalizeLimits = DEFAULT_LIMITS) {
    this.root = root;
    this.limits = limits;
  }

  available(): Promise<boolean> {
    return exists(this.root);
  }

  async *list(opts: ListOptions = {}): AsyncIterable<SessionRef> {
    for (const dir of await subdirs(this.root)) {
      for (const file of await filesWithExt(dir, ".jsonl")) {
        const st = await stat(file);
        if (opts.since && st.mtime < opts.since) continue;
        const header = await readFirstJsonlLine(file);
        const h = isRecord(header) && header.type === "session" ? header : undefined;
        const cwd = h && str(h.cwd);
        yield {
          agent: this.agent,
          sessionId: (h && str(h.id)) ?? basename(file, ".jsonl"),
          location: file,
          ...(cwd ? { cwd } : {}),
          updatedAt: st.mtime,
          version: `${st.mtimeMs}:${st.size}`,
        };
      }
    }
  }

  async load(ref: SessionRef): Promise<Transcript> {
    const lines = (await readJsonl(ref.location)).filter(isRecord);
    return parsePi(lines, ref, this.limits);
  }
}

type Entry = Record<string, unknown>;

export function parsePi(lines: Entry[], ref: SessionRef, limits: NormalizeLimits): Transcript {
  const header = lines.find((l) => l.type === "session");
  const byId = new Map<string, Entry>();
  let leaf: string | undefined;
  let title: string | undefined;
  for (const l of lines) {
    const id = str(l.id);
    if (l.type === "session" || !id) continue;
    byId.set(id, l);
    leaf = id;
    if (l.type === "session_info") title = str(l.name) ?? title;
  }
  const active = activeBranch(byId, leaf, (e) => str(e.parentId));

  const turns: Turn[] = [];
  for (const e of lines) {
    if (e.type !== "message" || !isRecord(e.message)) continue;
    const m = e.message;
    const ts = toDate(e.timestamp) ?? toDate(m.timestamp);
    const off = active.has(str(e.id) ?? "") ? {} : { offBranch: true };
    const push = (t: Turn) => turns.push({ ...t, ...off });
    switch (m.role) {
      case "user": {
        const text = contentText(m.content).trim();
        if (text) push({ role: "user", text, ts, origin: "prompt" });
        break;
      }
      case "bashExecution": {
        // User-issued `!cmd`: the command is human input, output is like a tool result.
        const cmd = str(m.command);
        if (cmd) push({ role: "user", text: `!${cmd}`, ts, origin: "command" });
        const out = str(m.output);
        if (out) push({ role: "tool", toolName: "bash", text: truncate(out, limits.toolResultChars), ts });
        break;
      }
      case "assistant": {
        const texts: string[] = [];
        const toolCalls: ToolCall[] = [];
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (!isRecord(b)) continue;
            if (b.type === "text" && str(b.text)) texts.push(b.text as string);
            else if (b.type === "toolCall")
              toolCalls.push({ name: str(b.name) ?? "unknown", input: renderInput(b.arguments, limits.toolInputChars) });
          }
        }
        const text = texts.join("\n");
        if (text || toolCalls.length)
          push({ role: "assistant", text, ts, ...(toolCalls.length ? { toolCalls } : {}) });
        break;
      }
      case "toolResult":
        push({
          role: "tool",
          toolName: str(m.toolName) ?? "unknown",
          text: truncate(contentText(m.content), limits.toolResultChars),
          ts,
          ...(m.isError === true ? { isError: true } : {}),
        });
        break;
      // system / custom / branchSummary / compactionSummary: not human-authored
    }
  }

  const parentSession = header && str(header.parentSession);
  return {
    agent: "pi",
    sessionId: ref.sessionId,
    location: ref.location,
    cwd: (header && str(header.cwd)) ?? ref.cwd ?? "",
    ...(title ? { title } : {}),
    startedAt: (header && toDate(header.timestamp)) ?? turns[0]?.ts ?? ref.updatedAt,
    updatedAt: turns[turns.length - 1]?.ts ?? ref.updatedAt,
    ...(parentSession ? { parentSessionId: basename(parentSession, ".jsonl") } : {}),
    turns,
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isRecord(b) ? (b.type === "text" ? (str(b.text) ?? "") : `[${String(b.type)}]`) : ""))
    .filter(Boolean)
    .join("\n");
}

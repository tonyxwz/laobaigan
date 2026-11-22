import { DEFAULT_LIMITS, DEFAULT_PATHS, type NormalizeLimits } from "../config.ts";
import { exists, filesWithExt, findInJsonl, readJsonl, subdirs } from "../util/fs.ts";
import { isRecord, renderInput, str, toDate, truncate } from "../util/text.ts";
import { activeBranch } from "../util/tree.ts";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ListOptions, SessionRef, SourceAdapter, ToolCall, Transcript, Turn } from "./types.ts";

/**
 * Claude Code: ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
 *
 * Each line is an event. Conversation events (`user` / `assistant`) form a tree via
 * `uuid` / `parentUuid`; other lines (`system`, `attachment`, `mode`, ...) may also
 * sit in the chain. One API response is split across several `assistant` lines
 * sharing `message.id`. Tool results arrive as `user` lines with `tool_result` blocks.
 * Lines are emitted in file (chronological) order; turns off the active branch
 * (rewinds / edited prompts) are kept and flagged `offBranch`.
 * Sub-agent transcripts live in `<session-uuid>/` subdirectories and are ignored.
 *
 * Memory notes Claude saved for the project live in `<cwd-slug>/memory/*.md`
 * (`MEMORY.md` is only an index of them). Each note is listed as its own
 * "session" (`mem-<name>-<hash>`) and loaded as a one-turn transcript, see
 * `parseClaudeMemory`.
 */
export class ClaudeAdapter implements SourceAdapter {
  readonly agent = "claude" as const;

  private readonly root: string;
  private readonly limits: NormalizeLimits;

  constructor(root = DEFAULT_PATHS.claudeProjects, limits: NormalizeLimits = DEFAULT_LIMITS) {
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
        yield {
          agent: this.agent,
          sessionId: basename(file, ".jsonl"),
          location: file,
          updatedAt: st.mtime,
          version: `${st.mtimeMs}:${st.size}`,
        };
      }
      for (const file of await filesWithExt(join(dir, "memory"), ".md")) {
        if (basename(file) === "MEMORY.md") continue;
        const st = await stat(file);
        if (opts.since && st.mtime < opts.since) continue;
        yield {
          agent: this.agent,
          sessionId: memorySessionId(file),
          location: file,
          updatedAt: st.mtime,
          version: `${st.mtimeMs}:${st.size}`,
        };
      }
    }
  }

  async load(ref: SessionRef): Promise<Transcript> {
    if (isMemoryFile(ref.location)) {
      const md = await readFile(ref.location, "utf8");
      return parseClaudeMemory(md, ref, await projectCwd(join(ref.location, "..", "..")));
    }
    const lines = (await readJsonl(ref.location)).filter(isRecord);
    return parseClaude(lines, ref, this.limits);
  }
}

type Line = Record<string, unknown>;

export function parseClaude(lines: Line[], ref: SessionRef, limits: NormalizeLimits): Transcript {
  const byId = new Map<string, Line>();
  let leaf: string | undefined;
  let title: string | undefined;
  for (const l of lines) {
    const uuid = str(l.uuid);
    if (uuid) byId.set(uuid, l);
    if ((l.type === "user" || l.type === "assistant") && uuid && l.isSidechain !== true) leaf = uuid;
    if (l.type === "ai-title" || l.type === "summary") title = str(l.title) ?? str(l.summary) ?? title;
  }

  // Follow parentUuid, and across compaction boundaries follow logicalParentUuid.
  const active = activeBranch(byId, leaf, (l) => str(l.parentUuid) ?? str(l.logicalParentUuid));

  const toolNames = new Map<string, string>();
  const turns: Turn[] = [];
  let cwd: string | undefined;
  let lastAssistantMsgId: string | undefined;

  for (const l of lines) {
    if (l.type !== "user" && l.type !== "assistant") continue;
    if (l.isSidechain === true) continue;
    cwd ??= str(l.cwd);
    const message = isRecord(l.message) ? l.message : undefined;
    if (!message) continue;
    const ts = toDate(l.timestamp);
    const off = active.size > 0 && !active.has(str(l.uuid) ?? "") ? { offBranch: true } : {};

    if (l.type === "assistant") {
      const { text, toolCalls } = assistantContent(message.content, toolNames, limits);
      if (!text && toolCalls.length === 0) continue;
      const msgId = str(message.id);
      const prev = turns[turns.length - 1];
      if (prev && prev.role === "assistant" && msgId && msgId === lastAssistantMsgId) {
        // Same API response split over multiple lines: merge.
        prev.text = [prev.text, text].filter(Boolean).join("\n");
        if (toolCalls.length) prev.toolCalls = [...(prev.toolCalls ?? []), ...toolCalls];
      } else {
        turns.push({ role: "assistant", text, ts, ...(toolCalls.length ? { toolCalls } : {}), ...off });
      }
      lastAssistantMsgId = msgId;
      continue;
    }

    // user line: either a human prompt or tool results
    lastAssistantMsgId = undefined;
    if (l.isMeta === true || l.isCompactSummary === true) continue;
    const content = message.content;
    if (typeof content === "string") {
      const t = classifyUserText(content);
      if (t) turns.push({ role: "user", ts, ...t, ...off });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const b of content) {
      if (!isRecord(b)) continue;
      if (b.type === "tool_result") {
        const id = str(b.tool_use_id);
        turns.push({
          role: "tool",
          toolName: (id && toolNames.get(id)) || "unknown",
          text: truncate(blockText(b.content), limits.toolResultChars),
          ts,
          ...(b.is_error === true ? { isError: true } : {}),
          ...off,
        });
      } else if (b.type === "text") {
        const s = str(b.text);
        if (s) texts.push(s);
      }
    }
    if (texts.length) {
      const t = classifyUserText(texts.join("\n"));
      if (t) turns.push({ role: "user", ts, ...t, ...off });
    }
  }

  const startedAt = turns[0]?.ts ?? ref.updatedAt;
  return {
    agent: "claude",
    sessionId: ref.sessionId,
    location: ref.location,
    cwd: cwd ?? ref.cwd ?? "",
    ...(title ? { title } : {}),
    startedAt,
    updatedAt: turns[turns.length - 1]?.ts ?? ref.updatedAt,
    turns,
  };
}

function assistantContent(
  content: unknown,
  toolNames: Map<string, string>,
  limits: NormalizeLimits,
): { text: string; toolCalls: ToolCall[] } {
  if (typeof content === "string") return { text: content, toolCalls: [] };
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isRecord(b)) continue;
      if (b.type === "text" && str(b.text)) texts.push(b.text as string);
      else if (b.type === "tool_use") {
        const name = str(b.name) ?? "unknown";
        const id = str(b.id);
        if (id) toolNames.set(id, name);
        toolCalls.push({ name, input: renderInput(b.input, limits.toolInputChars) });
      }
      // thinking blocks are intentionally dropped
    }
  }
  return { text: texts.join("\n"), toolCalls };
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isRecord(b) && b.type === "text" ? (str(b.text) ?? "") : isRecord(b) ? `[${String(b.type)}]` : ""))
    .join("\n");
}

const NOISE_PREFIXES = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<task-notification>",
  "<system-reminder>",
  "<bash-stdout>",
  "<bash-stderr>",
  "Caveat: The messages below were generated",
  "Base directory for this skill:",
];

/** Classify a user-role text: drop injected noise, normalize slash commands. */
export function classifyUserText(raw: string): Pick<Turn, "text" | "origin"> | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  if (NOISE_PREFIXES.some((p) => s.startsWith(p))) return undefined;
  if (s.startsWith("[Request interrupted by user")) return { text: s, origin: "interrupt" };
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(s);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim();
    return { text: [cmd[1]!.trim(), args].filter(Boolean).join(" "), origin: "command" };
  }
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>$/.exec(s);
  if (bash) return { text: `!${bash[1]!.trim()}`, origin: "command" };
  return { text: s, origin: "prompt" };
}

/** A memory note: `<projects>/<cwd-slug>/memory/<name>.md`. */
function isMemoryFile(path: string): boolean {
  return path.endsWith(".md") && basename(join(path, "..")) === "memory";
}

/** Stable, unique per file (note names repeat across projects), readable in a 12-char prefix. */
export function memorySessionId(path: string): string {
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 6);
  return `mem-${basename(path, ".md")}-${hash}`;
}

/**
 * The project's working directory, from the `cwd` of one of its session files.
 * The directory slug can't be decoded reliably (both `/` and `-` become `-`).
 * Empty when no session file says.
 */
async function projectCwd(dir: string): Promise<string> {
  for (const file of await filesWithExt(dir, ".jsonl")) {
    try {
      const cwd = await findInJsonl(file, (l) => (isRecord(l) ? str(l.cwd) : undefined));
      if (cwd) return cwd;
    } catch {
      // unreadable session file: try the next one
    }
  }
  return "";
}

/**
 * A Claude Code memory note as a transcript with one user turn.
 *
 * The note is what Claude wrote down of what I told it, so it is treated as my
 * words: the extract prompt says so (`Transcript.memory`). The turn's timestamp
 * is the note's `modified` date, so an edited note is a new turn (and extracted
 * again) while an untouched one stays seen.
 */
export function parseClaudeMemory(md: string, ref: SessionRef, cwd: string): Transcript {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  const front = fm?.[1] ?? "";
  const field = (k: string) => new RegExp(`^\\s*${k}:\\s*(.*)$`, "m").exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "") || undefined;
  const name = field("name") ?? basename(ref.location, ".md");
  const description = field("description");
  const origin = field("originSessionId");
  const ts = toDate(field("modified")) ?? ref.updatedAt;
  const body = (fm ? md.slice(fm[0].length) : md).trim();
  const text = [`Memory note "${name}"${description ? `: ${description}` : ""}`, body].filter(Boolean).join("\n\n");
  return {
    agent: "claude",
    sessionId: ref.sessionId,
    location: ref.location,
    cwd,
    title: `memory: ${name}`,
    startedAt: ts,
    updatedAt: ts,
    memory: origin ? { originSessionId: origin } : {},
    turns: body || description ? [{ role: "user", origin: "prompt", text, ts }] : [],
  };
}

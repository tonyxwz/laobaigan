import type { Transcript, Turn } from "../sources/types.ts";
import { truncate } from "../util/text.ts";
import { isHumanTurn } from "./fingerprint.ts";
import { redact } from "./redact.ts";

export interface PrefilterOptions {
  /** Approx token budget per chunk (chars / 4). */
  chunkTokens: number;
  /** Max tokens of already-seen context prepended to the first chunk. */
  contextTokens: number;
}

export const DEFAULT_PREFILTER: PrefilterOptions = { chunkTokens: 40_000, contextTokens: 6_000 };

export interface Signals {
  newHumanTurns: number;
  newHumanChars: number;
  /** Human turns ≥ 200 chars: likely explanations rather than commands. */
  longTurns: number;
  /** Turns containing correction phrasing ("no,", "actually", "as I said", …). */
  corrections: number;
  /** Human prompts that were rewound / edited away. */
  rewinds: number;
  /** Human turns right after a tool error. */
  afterToolError: number;
  /** Heuristic score for ranking/debugging. */
  score: number;
}

export interface Excerpt {
  /** One string per extract call. Redacted. */
  chunks: string[];
  /** Label (e.g. "U3") → turn index in the transcript, for citing evidence. */
  labels: Map<string, number>;
  signals: Signals;
  redactions: Record<string, number>;
  /** Reason when the session isn't worth an LLM call. */
  skip?: string;
}

const CORRECTION =
  /(^|\b)(no[,.!]|nope|actually|as i said|i told you|i said|again[,.]|don'?t|do not|never|always|instead|should be|wrong|not what i|that'?s not|remember)\b/i;
const TRIVIAL =
  /^(?:(?:hi|hello|hey)\b[^.?!]{0,40}[.?!]*|(?:thanks?(?: you)?|ok(?:ay)?|yes|yep|y|no|continue|go(?: on| ahead)?|lgtm|looks good|sure|do it|proceed|great|nice|cool)[\s.!?]*)$/i;

/** True for greetings / acks that carry no knowledge. Exported for tests. */
export function isTrivialPrompt(text: string): boolean {
  return TRIVIAL.test(text.trim());
}

/**
 * Condense a transcript into an extraction excerpt.
 *
 * Human turns whose fingerprint is in `seen` become context (`C` blocks, not
 * citable); the others get labels `U1..Un` and are what the model may cite.
 */
export function buildExcerpt(
  t: Transcript,
  fingerprints: Map<number, string>,
  seen: Set<string>,
  opts: PrefilterOptions = DEFAULT_PREFILTER,
): Excerpt {
  const blocks = segment(t.turns);
  const labels = new Map<string, number>();
  const signals: Signals = {
    newHumanTurns: 0,
    newHumanChars: 0,
    longTurns: 0,
    corrections: 0,
    rewinds: 0,
    afterToolError: 0,
    score: 0,
  };

  const newAt = blocks.map((b) => {
    if (b.userIndex === undefined) return false;
    const fp = fingerprints.get(b.userIndex);
    return !fp || !seen.has(fp);
  });
  const rendered: { text: string; isNew: boolean }[] = [];
  let n = 0;
  let prevHadError = false;
  let substantive = 0;
  for (const [bi, b] of blocks.entries()) {
    // Context blocks are condensed, except the one right before a new turn:
    // its assistant reply / tool errors are what the user is reacting to.
    const condensed = !newAt[bi] && !newAt[bi + 1];
    if (b.userIndex === undefined) {
      // assistant activity before the first human turn
      rendered.push({ text: renderSegment(b.segment, condensed), isNew: false });
      prevHadError = b.segment.some((x) => x.isError);
      continue;
    }
    const turn = t.turns[b.userIndex]!;
    const isNew = newAt[bi]!;
    let label: string;
    if (isNew) {
      label = `U${++n}`;
      labels.set(label, b.userIndex);
      signals.newHumanTurns++;
      signals.newHumanChars += turn.text.length;
      if (turn.text.length >= 200) signals.longTurns++;
      if (CORRECTION.test(turn.text)) signals.corrections++;
      if (turn.offBranch) signals.rewinds++;
      if (prevHadError) signals.afterToolError++;
      if (turn.origin === "prompt" && !isTrivialPrompt(turn.text)) substantive++;
    } else {
      label = "C";
    }
    const head = `[${label}${turn.ts ? ` ${turn.ts.toISOString().slice(0, 16).replace("T", " ")}` : ""}${
      turn.offBranch ? " rewound" : ""
    }${turn.origin === "command" ? " command" : ""}] USER:`;
    const body = isNew ? turn.text : truncate(turn.text, 600);
    rendered.push({ text: `${head}\n${indent(body)}\n${renderSegment(b.segment, condensed)}`, isNew });
    prevHadError = b.segment.some((x) => x.isError);
  }

  signals.score =
    signals.longTurns * 2 + signals.corrections * 3 + signals.rewinds * 2 + signals.afterToolError * 2 + substantive;

  const empty = { chunks: [], labels, signals, redactions: {} };
  if (signals.newHumanTurns === 0) return { ...empty, skip: "no new human turns" };
  if (substantive === 0) return { ...empty, skip: "only trivial prompts" };

  // Context = rendered blocks before the first new one, trimmed to the budget (keep the tail).
  const firstNew = rendered.findIndex((r) => r.isNew);
  const ctxBlocks = rendered.slice(0, firstNew).map((r) => r.text);
  let ctx = ctxBlocks.join("\n");
  const ctxChars = opts.contextTokens * 4;
  if (ctx.length > ctxChars) ctx = `… (earlier conversation omitted)\n${ctx.slice(ctx.length - ctxChars)}`;

  const chunkChars = opts.chunkTokens * 4;
  const chunks: string[] = [];
  let cur = ctx ? `${ctx}\n` : "";
  for (const r of rendered.slice(firstNew)) {
    if (cur.length + r.text.length > chunkChars && cur.length > 0) {
      chunks.push(cur);
      cur = "… (continued from previous chunk)\n";
    }
    cur += `${r.text}\n`;
  }
  if (cur.trim()) chunks.push(cur);

  const redactions: Record<string, number> = {};
  const redacted = chunks.map((c) => {
    const r = redact(c);
    for (const [k, v] of Object.entries(r.hits)) redactions[k] = (redactions[k] ?? 0) + v;
    return r.text;
  });
  return { chunks: redacted, labels, signals, redactions };
}

interface Block {
  /** Index of the human turn starting this block; undefined for the leading segment. */
  userIndex?: number;
  /** Assistant/tool turns following it until the next human turn. */
  segment: Turn[];
}

function segment(turns: Turn[]): Block[] {
  const out: Block[] = [{ segment: [] }];
  turns.forEach((t, i) => {
    if (isHumanTurn(t)) out.push({ userIndex: i, segment: [] });
    else out[out.length - 1]!.segment.push(t);
  });
  if (out[0]!.segment.length === 0) out.shift();
  return out;
}

/** First + last assistant text, tool usage counts, and up to 3 tool errors. */
function renderSegment(seg: Turn[], condensed: boolean): string {
  const lines: string[] = [];
  const texts = seg.filter((x) => x.role === "assistant" && x.text.trim()).map((x) => x.text.trim());
  const interrupts = seg.filter((x) => x.role === "user" && x.origin === "interrupt").length;
  const tools = new Map<string, number>();
  for (const x of seg) for (const c of x.toolCalls ?? []) tools.set(c.name, (tools.get(c.name) ?? 0) + 1);
  const errors = seg.filter((x) => x.role === "tool" && x.isError);

  if (condensed) {
    const last = texts[texts.length - 1];
    if (last) lines.push(`  ASSISTANT: ${truncate(oneLine(last), 300)}`);
  } else {
    if (texts[0]) lines.push(`  ASSISTANT: ${indent(truncate(texts[0], 600), 4).trimStart()}`);
    if (texts.length > 1) lines.push(`  ASSISTANT (final): ${indent(truncate(texts[texts.length - 1]!, 800), 4).trimStart()}`);
    for (const e of errors.slice(0, 3)) lines.push(`  TOOL ERROR (${e.toolName}): ${truncate(oneLine(e.text), 300)}`);
  }
  if (tools.size) lines.push(`  tools: ${[...tools].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(", ")}`);
  if (interrupts) lines.push(`  (user interrupted the agent${interrupts > 1 ? ` ×${interrupts}` : ""})`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function indent(s: string, n = 4): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

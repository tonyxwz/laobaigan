import { newSinceDraft } from "../pipeline/accept.ts";
import type { SessionOutcome } from "../pipeline/process.ts";
import type { TreeScoreResult } from "../pipeline/treescore.ts";
import { type AgentId, ALL_AGENTS, type Transcript } from "../sources/index.ts";
import { type ProposalRow, Proposals } from "../state/proposals.ts";
import { isExpired, type MemoryRow } from "../state/rejections.ts";
import { subtreeNuggets, type Tree, type TreeNode } from "../state/tree.ts";
import { tildify } from "../util/path.ts";
import { indent, truncate } from "../util/text.ts";

/** Parsing of command arguments and rendering of what the commands print. */

export function parseAgents(s: string): AgentId[] {
  return s.split(",").map((a) => {
    const id = a.trim() as AgentId;
    if (!ALL_AGENTS.includes(id))
      throw new Error(
        `Unknown agent: ${a} (expected ${ALL_AGENTS.join(", ")})`,
      );
    return id;
  });
}

export function parseSessionTarget(s: string | undefined): {
  agent: AgentId;
  idPrefix: string;
} {
  const m = s && /^([a-z]+):(.+)$/.exec(s);
  if (!m) throw new Error("expected <agent>:<sessionId>");
  return { agent: parseAgents(m[1]!)[0]!, idPrefix: m[2]! };
}

export function renderOutcomes(
  outcomes: SessionOutcome[],
  out: (s: string) => void,
): void {
  const counts: Record<string, number> = {};
  for (const o of outcomes) {
    counts[o.status] = (counts[o.status] ?? 0) + 1;
    if (o.status === "up-to-date") continue;
    const e = o.excerpt;
    out(
      `${o.status.padEnd(9)} ${o.ref.agent.padEnd(8)} ${o.ref.sessionId.slice(0, 12).padEnd(12)} ` +
        (e
          ? `new=${String(e.signals.newHumanTurns).padStart(3)} score=${String(e.signals.score).padStart(3)} chunks=${e.chunks} ~${e.approxTokens}tok`
          : "") +
        `${o.detail ? `  ${o.detail}` : ""}${e && Object.keys(e.redactions).length ? `  redacted=${JSON.stringify(e.redactions)}` : ""}\n`,
    );
    for (const n of o.nuggets ?? []) {
      out(
        `    • [${n.kind}/${n.scope}${n.repo ? `:${n.repo}` : ""}] ${n.title} (conf ${n.confidence}${
          n.coveredBySkill ? `, covered by ${n.coveredBySkill}` : ""
        }; ${n.evidence.map((x) => x.label).join(",")})\n`,
      );
    }
  }
  out(
    `\n${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}\n`,
  );
}

export function shortPath(p: string | undefined): string {
  return p ? tildify(p) : "?";
}

export function sessionsOf(n: TreeNode): number {
  return new Set(subtreeNuggets(n).map((m) => `${m.agent}:${m.sessionId}`))
    .size;
}

/** Page `text` on a terminal ($LBG_PAGER → delta → less -R); plain stdout when piped. */
export async function page(text: string, noPager: boolean): Promise<void> {
  const write = () => void process.stdout.write(text);
  if (noPager || !process.stdout.isTTY) return write();
  const { spawn, spawnSync } = await import("node:child_process");
  const has = (bin: string) =>
    spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status ===
    0;
  const cmd =
    process.env.LBG_PAGER ??
    (has("delta") ? "delta" : has("less") ? "less -R" : "");
  if (!cmd) return write();
  await new Promise<void>((resolve) => {
    const child = spawn("sh", ["-c", cmd], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", () => (write(), resolve()));
    child.on("close", () => resolve());
    child.stdin.on("error", () => {}); // pager quit early
    child.stdin.end(text);
  });
}

export function renderMemory(m: MemoryRow, tree: Tree): string {
  const skill = m.topic.name ?? m.topic.title;
  const target =
    m.targetNodeId !== undefined ? tree.getNode(m.targetNodeId) : undefined;
  const age = Math.max(
    0,
    Math.round((Date.now() - m.createdAt.getTime()) / 86400e3),
  );
  const head =
    `#${String(m.id).padEnd(3)} ${m.status.padEnd(7)} ${(m.kind ?? "?").padEnd(11)} ${skill}  ` +
    `[${m.scope === "global" ? "global" : `repo ${shortPath(m.repo)}`}] proposal #${m.proposalId}, ${age}d${m.locked ? ", edited" : ""}` +
    `${m.caught ? `, caught ${m.caught}` : ""}${m.extractUses ? `, in ${m.extractUses} extraction call(s)` : ""}` +
    `${m.expiresAt ? (isExpired(m) ? `, EXPIRED ${m.expiresAt.toISOString().slice(0, 10)} (lbg rejections keep ${m.id})` : `, expires ${m.expiresAt.toISOString().slice(0, 10)}`) : ""}\n`;
  const lines = [head];
  if (m.rule)
    lines.push(
      `      rule: ${m.rule}${target ? ` (→ #${target.id} ${target.name ?? target.title})` : ""}\n`,
    );
  if (m.reason)
    lines.push(
      `      reason: ${truncate(m.reason.replace(/\s+/g, " "), 160)}\n`,
    );
  if (m.status === "pending")
    lines.push(
      `      ${m.error ? `last try failed: ${m.error}` : "classified by the next lbg run"}\n`,
    );
  return lines.join("");
}

export function renderProposalLine(p: ProposalRow, tree: Tree): string {
  const fresh = p.status === "open" ? newSinceDraft(tree, p).length : 0;
  const dropped =
    p.status === "open"
      ? new Proposals(tree.db).droppedSinceDraft(p).length
      : 0;
  const node = tree.getNode(p.nodeId);
  const where = p.scope === "global" ? "global" : `repo ${shortPath(p.repo)}`;
  const cost = (p.usage as { cost?: number } | undefined)?.cost;
  return (
    `#${String(p.id).padEnd(3)} ${p.status.padEnd(8)} ${p.kind.padEnd(15)} ${p.skillName ?? node?.title ?? `node ${p.nodeId}`}  ` +
    `[${where}] ${p.files.length} file(s), ${p.sessions} session(s)${cost !== undefined ? `, $${cost.toFixed(2)}` : ""}` +
    `${fresh ? `, +${fresh} new since draft` : ""}${dropped ? `, ${dropped} dropped since draft` : ""}  ${p.createdAt.toISOString().slice(0, 16).replace("T", " ")}\n`
  );
}

export function renderScore(
  r: TreeScoreResult,
  out: (s: string) => void,
): void {
  for (const p of r.promoted)
    out(`candidate: #${p.id} ${p.title} → ${p.kind} (score ${p.score})\n`);
  for (const d of r.demoted)
    out(`no longer a candidate: #${d.id} ${d.title}\n`);
  if (r.moved)
    out(
      `${r.moved} nugget(s) moved out of wrong-place rejected skills to their targets\n`,
    );
}

/** One skill line plus its sections (a live skill's own sections only when they hold evidence). */
export function renderSkill(s: TreeNode, out: (s: string) => void): void {
  out(
    `  #${String(s.id).padEnd(4)} ${s.origin.padEnd(8)} ${(s.status + (s.proposalKind ? `:${s.proposalKind}` : "")).padEnd(25)} score=${String(s.score).padStart(3)} ` +
      `s=${sessionsOf(s)} n=${subtreeNuggets(s).length}  ${s.name ? `${s.name} — ` : ""}${s.title}${s.locked ? " (locked)" : ""}` +
      `${s.origin === "file" && s.children.length ? `  [${s.children.length} section(s)]` : ""}\n`,
  );
  for (const c of s.children) {
    if (
      s.origin === "file" &&
      c.origin === "file" &&
      subtreeNuggets(c).length === 0
    )
      continue;
    out(
      `        · #${c.id} ${c.origin === "file" ? "" : `${c.origin} `}${c.title} (n=${subtreeNuggets(c).length})${c.locked ? " (locked)" : ""}\n`,
    );
  }
}

export function renderTree(
  root: TreeNode,
  out: (s: string) => void,
  opts: { onlyWithEvidence?: boolean; statuses?: string[] } = {},
): void {
  out(
    `\n${root.scope === "global" ? "Global skills" : `repo ${shortPath(root.repo)}`}  (root #${root.id}, ${root.children.length} skill(s))\n`,
  );
  const skills = [...root.children]
    .filter((s) => !opts.onlyWithEvidence || subtreeNuggets(s).length > 0)
    .filter((s) => !opts.statuses || opts.statuses.includes(s.status))
    .sort(
      (a, b) =>
        sessionsOf(b) - sessionsOf(a) || b.score - a.score || a.id - b.id,
    );
  for (const s of skills) renderSkill(s, out);
}

export function renderNodeDetail(n: TreeNode, path: string[]): string {
  const lines = [
    `#${n.id} ${n.title}${n.name ? `  [${n.name}]` : ""}`,
    `path: ${path.join(" › ")}`,
    `depth: ${n.depth}   origin: ${n.origin}   status: ${n.status}   score: ${n.score}${n.locked ? "   (locked)" : ""}${n.summaryDirty ? "   (summary stale)" : ""}`,
  ];
  if (n.description) lines.push(`description: ${n.description}`);
  if (n.sourcePath) lines.push(`source: ${n.sourcePath}`);
  if (n.summary) lines.push("", "## Summary", n.summary);
  const nuggetLines = (ns: TreeNode["nuggets"], pad: string) => {
    for (const m of ns) {
      lines.push(
        "",
        `${pad}#${m.id} [${m.kind}] ${m.title}  (${m.agent}:${m.sessionId.slice(0, 12)}, conf ${m.confidence}${m.coveredBy ? `, covered by ${m.coveredBy}` : ""})`,
      );
      for (const e of m.evidence)
        lines.push(
          `${pad}    ${e.label}${e.ts ? ` ${e.ts.slice(0, 16).replace("T", " ")}` : ""}: "${e.quote}"`,
        );
    }
  };
  if (n.nuggets.length) {
    lines.push("", `## Nuggets (${n.nuggets.length})`);
    nuggetLines(n.nuggets, "");
  }
  for (const c of n.children) {
    lines.push("", `## #${c.id} ${c.title}  (n=${subtreeNuggets(c).length})`);
    if (c.summary) lines.push(c.summary);
    nuggetLines(c.nuggets, "  ");
  }
  const forgotten = [n, ...n.children].flatMap((x) => x.forgotten);
  if (forgotten.length) {
    lines.push(
      "",
      `## Forgotten (${forgotten.length}; not counted, not drafted)`,
    );
    for (const m of forgotten)
      lines.push(
        `  #${m.id} ${m.title}  (${m.forgottenReason ?? "forgotten"}, ${m.forgottenAt!.toISOString().slice(0, 10)})`,
      );
  }
  return `${lines.join("\n")}\n`;
}

/** When a nugget's evidence was said (first evidence timestamp), else when it was extracted. */
export function evidenceTime(n: {
  evidence: { ts?: string }[];
  createdAt: Date;
}): number {
  const ts = n.evidence
    .map((e) => e.ts)
    .filter((x): x is string => !!x)
    .sort()[0];
  return ts ? Date.parse(ts) : n.createdAt.getTime();
}

export function summarize(t: Transcript) {
  const user = t.turns.filter(
    (x) => x.role === "user" && x.origin !== "command",
  );
  return {
    agent: t.agent,
    sessionId: t.sessionId,
    cwd: t.cwd,
    title: t.title,
    firstPrompt: truncate((user[0]?.text ?? "").replace(/\s+/g, " "), 100),
    startedAt: t.startedAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    userTurns: user.length,
    turns: t.turns.length,
    ...(t.parentSessionId ? { parentSessionId: t.parentSessionId } : {}),
  };
}

export function renderTranscript(t: Transcript): string {
  const lines = [
    `# ${t.agent}:${t.sessionId}${t.title ? ` — ${t.title}` : ""}`,
    `cwd: ${t.cwd}`,
    `time: ${t.startedAt.toISOString()} → ${t.updatedAt.toISOString()}`,
    "",
  ];
  for (const turn of t.turns) {
    const ts = `${turn.ts ? turn.ts.toISOString().slice(11, 19) : "--:--:--"}${turn.offBranch ? " off-branch" : ""}`;
    if (turn.role === "user") {
      lines.push(
        `[${ts}] USER${turn.origin && turn.origin !== "prompt" ? ` (${turn.origin})` : ""}:`,
        indent(turn.text),
        "",
      );
    } else if (turn.role === "assistant") {
      lines.push(`[${ts}] ASSISTANT:`);
      if (turn.text) lines.push(indent(turn.text));
      for (const c of turn.toolCalls ?? [])
        lines.push(`    → ${c.name} ${c.input}`);
      lines.push("");
    } else {
      lines.push(
        `[${ts}] TOOL ${turn.toolName}${turn.isError ? " (error)" : ""}:`,
        indent(truncate(turn.text, 400)),
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

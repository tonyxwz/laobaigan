import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { Feedback } from "../state/feedback.ts";
import { readChatTurns, readClaudeChatTurns } from "./chatlog.ts";
import { editDiff } from "./accept.ts";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentModel, DEFAULT_PATHS, type Config } from "../config.ts";
import { claudeToolsFor } from "../pi/claude-guard.ts";
import { CLAUDE_CONTEXT_ENV, CLAUDE_CONTEXT_SETTINGS, claudeEffort, claudeSettings } from "../pi/run-claude.ts";
import type { Turn } from "../state/feedback.ts";
import { GUARDED_TOOLS } from "../pi/guard.ts";
import type { Tree } from "../state/tree.ts";
import { DRAFT_SYSTEM_PROMPT } from "./render.ts";
import { closeDraft, discardDraft, openDraft, reviseContext, type CloseResult, type DraftWorkspace } from "./revise.ts";

/**
 * Interactive changes to an open proposal, in my own terminal:
 *
 *   revise  the configured agent and model (cfg.agent), in the draft's scratch dir, writing only the
 *           proposal's paths, no bash tool:
 *           - pi (`pi` on PATH: my TUI and pi settings) with lbg's guard extension. Its session
 *             is kept in a temp dir, never in ~/.pi/agent/sessions.
 *           - "claude-code": my `claude` CLI with Claude Code's built-in file tools and
 *             lbg's guard as a PreToolUse hook command (in --settings). Its session
 *             file is read for feedback and deleted afterwards.
 *           Either way lbg doesn't learn from its own drafting chats.
 *   edit    $VISUAL / $EDITOR on the drafted files. No AI.
 *
 * On exit the files are verified and stored; on problems I can go back in or keep the
 * previous draft.
 */

/**
 * The guard extension next to this module: src/pi/guard-extension.ts when running from
 * source, dist/pi/guard-extension.js from an install (pi then loads plain JS, no
 * TypeScript inside node_modules).
 */
export function guardExtensionPath(moduleUrl: string = import.meta.url): string {
  const here = fileURLToPath(moduleUrl);
  return join(dirname(here), "..", "pi", `guard-extension${extname(here)}`);
}

const EXTENSION = guardExtensionPath();

/** The PreToolUse hook command next to this module (claude-guard-hook.ts / .js, like the extension). */
export function claudeHookPath(moduleUrl: string = import.meta.url): string {
  const here = fileURLToPath(moduleUrl);
  return join(dirname(here), "..", "pi", `claude-guard-hook${extname(here)}`);
}

/** Quote for sh (Claude Code runs hook commands through a shell). */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Runs a program attached to the terminal; returns its exit status. Injectable for tests. */
export type Launcher = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => number;

export const terminalLauncher: Launcher = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: "inherit" });
  if (r.error) throw new Error(`Couldn't start ${cmd}: ${r.error.message}`);
  return r.status ?? 1;
};

/** Asks a yes/no question; injectable for tests. */
export type Ask = (question: string) => Promise<boolean>;

export interface InteractiveResult extends CloseResult {
  /** I chose to keep the previous draft after problems. */
  kept: boolean;
}

async function loop(
  tree: Tree,
  cfg: Config,
  ws: DraftWorkspace,
  session: (first: boolean) => void,
  ask: Ask,
  log: (m: string) => void,
  summary: string,
  refreshEvidence: boolean,
): Promise<InteractiveResult> {
  for (let first = true; ; first = false) {
    session(first);
    const r = await closeDraft(tree, cfg, ws, { summary, refreshEvidence });
    if (!r.problems.length) return { ...r, kept: false };
    log(`The draft has problems:\n${r.problems.map((p) => `  - ${p}`).join("\n")}`);
    if (!(await ask("Go back in and fix them? (no = keep the previous draft)"))) return { ...r, kept: true };
  }
}

export interface PiChatOptions {
  launcher?: Launcher;
  ask: Ask;
  log?: (m: string) => void;
  /** pi executable. Default: `pi` on PATH. */
  pi?: string;
  /** Where Claude Code keeps sessions (to read and delete the chat). Default: ~/.claude/projects. */
  claudeProjects?: string;
}

export async function chatRevise(tree: Tree, cfg: Config, id: number, opts: PiChatOptions): Promise<InteractiveResult> {
  const launcher = opts.launcher ?? terminalLauncher;
  const log = opts.log ?? (() => {});
  const ws = await openDraft(tree, id);
  const side = await mkdtemp(join(tmpdir(), "lbg-chat-"));
  const cleanups: (() => Promise<void>)[] = [];
  try {
    const promptFile = join(side, "system.md");
    await writeFile(
      promptFile,
      [
        DRAFT_SYSTEM_PROMPT.replace(/\n- When done, call report_draft once\.$/, ""),
        "",
        "You are revising a draft together with the engineer in an interactive chat. Make the changes they ask for, show them what you changed, and keep the draft valid. They will exit when it's done.",
        "",
        reviseContext(tree, ws),
      ].join("\n"),
    );
    const env = { ...process.env, LBG_GUARD: JSON.stringify({ root: ws.scratch, writable: ws.target.writable }) };
    const opening = `This is proposal #${id} (${ws.proposal.kind}) for ${ws.target.skillName}. Read the draft and summarize it in a few lines, then ask me what to change.`;
    const name = `lbg proposal #${id} ${ws.target.skillName}`;
    const { model, thinking } = agentModel(cfg);
    let session: (first: boolean) => void;
    let chat: () => Promise<Turn[]>;
    let agent: string;
    if (cfg.agent === "pi") {
      agent = "pi";
      const base = [
        "--session-dir",
        join(side, "sessions"),
        // The scratch dir holds the draft (e.g. .agents/skills/<name>/), which pi would treat as
        // project resources and ask to trust. Never load them: the draft is data, not a skill to use.
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-mcp",
        "-e",
        EXTENSION,
        "--tools",
        GUARDED_TOOLS.join(","),
        "--append-system-prompt",
        promptFile,
        "--name",
        name,
        ...(model ? ["--model", model] : []),
        ...(thinking ? ["--thinking", thinking] : []),
      ];
      session = (first) => void launcher(opts.pi ?? "pi", first ? [...base, opening] : [...base, "--continue"], { cwd: ws.scratch, env });
      chat = () => readChatTurns(join(side, "sessions"), opening);
    } else {
      agent = "Claude Code";
      const sessionId = randomUUID();
      // My claudeCode.settings first, then lbg's: the guard hook runs next to any of mine.
      const settings = claudeSettings(cfg.claudeCode.settings, {
        ...CLAUDE_CONTEXT_SETTINGS,
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${shq(process.execPath)} ${shq(claudeHookPath())}` }] }] },
      });
      const effort = claudeEffort(thinking);
      // Every option before the prompt, each with its value in one argument where it takes a
      // list (--tools=…), so nothing swallows the prompt. The prompt must come last: a wrapper
      // `claude` may parse the command line itself, and some take a leading prompt for a
      // subcommand, then drop --settings (and with it lbg's guard hook).
      const base = [
        `--tools=${claudeToolsFor(GUARDED_TOOLS).join(",")}`,
        // Whatever lbg's hook doesn't allow is denied, never asked.
        "--permission-mode",
        "dontAsk",
        "--settings",
        JSON.stringify(settings),
        "--setting-sources",
        (cfg.claudeCode.settingSources ?? ["user"]).join(","),
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--append-system-prompt",
        await readFile(promptFile, "utf8"),
        "--name",
        name,
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
      ];
      // No CLAUDE.md / rules / auto-memory, like pi's --no-context-files.
      const ccEnv = { ...env, ...CLAUDE_CONTEXT_ENV, ...(thinking === "off" ? { MAX_THINKING_TOKENS: "0" } : {}) };
      session = (first) =>
        void launcher(cfg.claudeCode.executable ?? "claude", first ? [...base, "--session-id", sessionId, opening] : [...base, "--resume", sessionId], {
          cwd: ws.scratch,
          env: ccEnv,
        });
      chat = async () => {
        const file = await findClaudeSession(opts.claudeProjects ?? DEFAULT_PATHS.claudeProjects, sessionId);
        return file ? readClaudeChatTurns(file, opening) : [];
      };
      cleanups.push(() => removeClaudeSession(opts.claudeProjects ?? DEFAULT_PATHS.claudeProjects, sessionId));
    }
    const result = await loop(
      tree,
      cfg,
      ws,
      session,
      opts.ask,
      log,
      `${ws.proposal.summary ?? ""}${ws.proposal.summary ? "\n" : ""}(Revised in an interactive ${agent} session.)`.trim(),
      true, // the chat saw the current evidence
    );
    // Keep what I said: it's review feedback for this skill (the session is deleted next).
    try {
      const turns = await chat();
      const mine = turns.filter((t) => t.role === "user");
      if (mine.length) {
        new Feedback(tree.db).add({ proposalId: id, kind: "chat", text: mine.map((t) => t.text).join("\n\n"), turns });
        log(`kept ${mine.length} message(s) of yours from the chat as feedback for ${ws.target.skillName}`);
      }
    } catch (e) {
      log(`couldn't read the chat for feedback: ${e instanceof Error ? e.message : String(e)}`);
    }
    return result;
  } finally {
    for (const c of cleanups) await c().catch(() => {});
    await discardDraft(ws);
    await rm(side, { recursive: true, force: true });
  }
}

/** `<id>.jsonl` in one of Claude Code's project dirs. */
async function findClaudeSession(projects: string, sessionId: string): Promise<string | undefined> {
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const f = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

/** Delete the chat's session file (and its sidecar dir, and the project dir if that leaves it empty). */
async function removeClaudeSession(projects: string, sessionId: string): Promise<void> {
  const file = await findClaudeSession(projects, sessionId);
  if (!file) return;
  const dir = dirname(file);
  await rm(file, { force: true });
  await rm(join(dir, sessionId), { recursive: true, force: true });
  if (!(await readdir(dir)).length) await rm(dir, { recursive: true, force: true });
}

export interface EditOptions {
  launcher?: Launcher;
  ask: Ask;
  log?: (m: string) => void;
  /** Default: $VISUAL, $EDITOR, then vi. */
  editor?: string;
}

export async function editProposal(tree: Tree, cfg: Config, id: number, opts: EditOptions): Promise<InteractiveResult> {
  const launcher = opts.launcher ?? terminalLauncher;
  const editor = opts.editor ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  const ws = await openDraft(tree, id);
  try {
    const files = ws.proposal.files.filter((f) => f.content !== null).map((f) => f.path);
    const before = ws.proposal.files;
    const result = await loop(
      tree,
      cfg,
      ws,
      () => {
        // The editor may be "code -w" etc.: split off its arguments.
        const [cmd, ...args] = editor.split(/\s+/).filter(Boolean);
        launcher(cmd!, [...args, ...files.filter((f) => existsSync(join(ws.scratch, f)))], { cwd: ws.scratch, env: process.env });
      },
      opts.ask,
      opts.log ?? (() => {}),
      ws.proposal.summary ?? "",
      false, // a hand edit doesn't add evidence
    );
    // My hand edit is feedback: what I changed in the AI's draft.
    if (result.changed && !result.kept) {
      const diff = editDiff(before, result.files);
      if (diff) {
        const paths = [...new Set(result.files.map((f) => f.path))].filter((p) => diff.includes(`b/${p}`) || diff.includes(`a/${p}`));
        new Feedback(tree.db).add({ proposalId: id, kind: "edit", text: `Edited the draft by hand: ${paths.join(", ")}`, diff });
      }
    }
    return result;
  } finally {
    await discardDraft(ws);
  }
}

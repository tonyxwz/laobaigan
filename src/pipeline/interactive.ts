import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import { GUARDED_TOOLS } from "../pi/guard.ts";
import type { Tree } from "../state/tree.ts";
import { DRAFT_SYSTEM_PROMPT } from "./render.ts";
import { closeDraft, discardDraft, openDraft, reviseContext, type CloseResult, type DraftWorkspace } from "./revise.ts";

/**
 * Interactive changes to an open proposal, in my own terminal:
 *
 *   revise  my local pi CLI (`pi` on PATH: my TUI and pi settings, so pi's default model) in the
 *           draft's scratch dir, with lbg's guard extension: write only the proposal's paths,
 *           no bash tool. Its session is kept in a temp dir, never in
 *           ~/.pi/agent/sessions, so lbg doesn't learn from its own drafting chats.
 *   edit    $VISUAL / $EDITOR on the drafted files. No AI.
 *
 * On exit the files are verified and stored; on problems I can go back in or keep the
 * previous draft.
 */

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "pi", "guard-extension.ts");

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
): Promise<InteractiveResult> {
  for (let first = true; ; first = false) {
    session(first);
    const r = await closeDraft(tree, cfg, ws, { summary });
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
}

export async function chatRevise(tree: Tree, cfg: Config, id: number, opts: PiChatOptions): Promise<InteractiveResult> {
  const launcher = opts.launcher ?? terminalLauncher;
  const log = opts.log ?? (() => {});
  const ws = await openDraft(tree, id);
  const side = await mkdtemp(join(tmpdir(), "lbg-chat-"));
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
      `lbg proposal #${id} ${ws.target.skillName}`,
    ];
    const opening = `This is proposal #${id} (${ws.proposal.kind}) for ${ws.target.skillName}. Read the draft and summarize it in a few lines, then ask me what to change.`;
    return await loop(
      tree,
      cfg,
      ws,
      (first) => {
        launcher(opts.pi ?? "pi", first ? [...base, opening] : [...base, "--continue"], { cwd: ws.scratch, env });
      },
      opts.ask,
      log,
      `${ws.proposal.summary ?? ""}${ws.proposal.summary ? "\n" : ""}(Revised in an interactive pi session.)`.trim(),
    );
  } finally {
    await discardDraft(ws);
    await rm(side, { recursive: true, force: true });
  }
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
    return await loop(
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
    );
  } finally {
    await discardDraft(ws);
  }
}

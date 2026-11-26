#!/usr/bin/env node
import { parseArgs } from "node:util";
import { type Context, OPTIONS } from "./commands/context.ts";
import { parseAgents } from "./commands/format.ts";
import { initCommand } from "./commands/init.ts";
import { nuggetsCommand } from "./commands/nuggets.ts";
import { promptCommand } from "./commands/prompt.ts";
import { proposalCommand } from "./commands/proposal.ts";
import { rejectionsCommand } from "./commands/rejections.ts";
import { runCommand } from "./commands/run.ts";
import { scanCommand } from "./commands/scan.ts";
import { serviceCommand } from "./commands/service.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { showCommand } from "./commands/show.ts";
import { statusCommand } from "./commands/status.ts";
import { treeCommand } from "./commands/tree.ts";
import { defaultAdapters } from "./sources/index.ts";

const USAGE = `lbg (laobaigan 老白干) — distill repeated explanations from agent sessions into skills

Inspect sessions (read-only, no state):
  lbg sessions [--since 7d] [--agent claude,pi,opencode] [--settle 30m] [--json]
  lbg show <agent>:<sessionId> [--user-only] [--json]        <sessionId> may be a unique prefix

Pipeline:
  lbg scan    [--since all] [--agent ...] [--session <agent>:<id> [--excerpt]] [--fresh] [--json]
      What the next run's extract would do (change detection + prefilter). No model calls, no writes.
      --excerpt  print the exact text the model would see (with --session)
  lbg run     [--stages sync,extract,insert,score,draft] [--only <skill-id>...] [--session <agent>:<id>]
              [--dry-run [--fresh]] [--max-calls N] [--json]
      The only command that runs the pipeline's model calls (what the hourly timer runs): sync skill
      files, extract (classify new rejections, then read new sessions), place nuggets in the tree,
      score, draft the top candidates into proposals. Budgets: rejections.maxCallsPerRun,
      extract.maxCallsPerRun, insert.maxCallsPerRun, render.maxPerRun (--max-calls: sessions only).
      --only      draft these skills now (ignores the retry wait); default stages: sync,score,draft
      --session   extract only this session (rejections wait for a normal run); prints its nuggets
      --dry-run   run on a temporary copy of the state db: models are called, nothing is kept
      --fresh     with --dry-run: treat every message as new (prompt tuning)
      Exit 0 ok, 2 a stage failed, 3 aborted (repeated model errors), 75 another run holds the lock.

Knowledge tree (one per scope: root → skills → sections → nuggets):
  lbg tree [--status candidate,...] [--json]            The tree (live skills' own sections collapsed)
  lbg tree show <id> [--json]                          One node: path, summary, sections, evidence
  lbg tree sync [--dry-run]                            Mirror skill files (global + known repos) and declared topics
  lbg tree score                                       Recompute scores; promote skills that earned a proposal

Curating the tree (hand edits are locked so automation never undoes them; live skill
files change only through proposals; every edit re-scores right away):
  lbg tree merge <into> <from>...                      Fold skills into one (their sections and nuggets move)
  lbg tree split <skill> <section>... [--title T]      Move sections out into a new skill
  lbg tree move <node> <parent>                        Section → other skill, section → root (new skill), skill → section
  lbg tree rename <id> [--title T] [--name skill-name]
  lbg tree unlock <id>                                 Let automation reorganize it again
  lbg nuggets move <nugget> <node>
  lbg nuggets forget <nugget>... [--reason "..."]       Stop it counting (outdated); kept so its session isn't re-read
  lbg nuggets forget --skill <id> --before <date>        Forget a skill's evidence from before a date
  lbg nuggets unforget <nugget>...

  lbg nuggets [--json]                                       List stored nuggets

Proposals (lbg never runs git: accept writes the files; commit them yourself if you like):
  lbg proposals [--status open,accepted,...]  List proposals (default: open)
  lbg proposal show <id> [--no-pager]          Summary, evidence, and the diff against the live files
  lbg proposal diff <id> [--no-pager]          Only the diff (git format; pipe it into delta etc.)
      On a terminal both page through $LBG_PAGER, else delta if installed, else less -R.
  lbg proposal accept <id> [--force] [--commit] Write the files into the skills dir / repo (--force: even if they changed since;
                                               --commit: then run commitCommand from the config)
  lbg proposal revise <id>                     Chat with pi about the draft (your pi TUI; writes only the draft's files)
  lbg proposal revise <id> "feedback"          One shot: pi redrafts with your feedback
  lbg proposal edit <id>                       Edit the drafted files in $VISUAL / $EDITOR
  lbg proposal reject <id> [--reason "..."] [--kind outdated|not-useful|wrong-place|later] [--to <skill>] [--forget]
      No model call. Leaves a rejection memory that the next lbg run classifies (--kind: use mine now;
      --to: with wrong-place, where it belongs; --forget: its evidence stops counting. An outdated
      rejection forgets its evidence anyway).

Rejection memories (what rejections teach lbg):
  lbg rejections [--status pending,active,removed] [--json]   List (default: pending + active)
  lbg rejections edit <id> [--kind K] [--rule "..."] [--to <skill>]   Correct one; locks it (never reclassified)
  lbg rejections keep <id>                                    Renew a not-useful memory (they expire after rejections.expireDays)
  lbg rejections forget <id>                                  Stop using it
  lbg proposal drop <id> <nugget>... [--reason "..."] [--to <node>] [--revise]
                                               Take evidence off a proposal (off-topic); it's re-filed elsewhere
                                               (or put in --to), never routed back. --revise redrafts without it
  lbg prompt                                   How many proposals are waiting, and the shell prompt snippets (starship / zsh)

Setup:
  lbg init                                     Detect agents, skills dir and model; write a starter config (never overwrites)

Background service (systemd user timer, hourly lbg run):
  lbg service install [--path DIR[:DIR]]       Write and enable the units for this lbg (--path: extra PATH for credential helpers)
  lbg service uninstall                        Stop and remove the units (state is kept)
  lbg service status                           What the timer runs, and when
  lbg status                                                 State db counts and recent runs

Options:
  --since   Duration (30m, 6h, 7d, 2w), ISO date, or "all"
  --agent   Comma-separated agents to include. Default: all available
  --settle  Skip sessions modified within this window. Default: config (30m) for pipeline, 0 for sessions
  --json    Machine-readable output
Config: ~/.config/laobaigan/config.json (override with LBG_CONFIG)
`;

const COMMANDS: Record<string, (ctx: Context) => Promise<number>> = {
  sessions: sessionsCommand,
  show: showCommand,
  scan: scanCommand,
  run: runCommand,
  tree: treeCommand,
  init: initCommand,
  service: serviceCommand,
  prompt: promptCommand,
  rejections: rejectionsCommand,
  proposals: proposalCommand,
  proposal: proposalCommand,
  nuggets: nuggetsCommand,
  status: statusCommand,
};

async function main(argv: string[]): Promise<number> {
  const gone: Record<string, string> = {
    extract:
      "lbg run --stages extract (prompt tuning on one session: lbg run --dry-run --fresh --stages extract --session <agent>:<id>)",
    cluster: "lbg run --stages sync,insert,score",
    draft: "lbg run --only <skill-id>... (drafts them now)",
  };
  // Checked before parsing, so old flags (e.g. tree insert --all) still get the pointer.
  const [a0, a1] = argv.filter((x) => !x.startsWith("-"));
  const goneKey =
    a0 === "tree" && a1 === "insert"
      ? "tree insert"
      : a0 && gone[a0]
        ? a0
        : undefined;
  if (goneKey) {
    const instead =
      goneKey === "tree insert"
        ? "lbg run --stages sync,insert,score (on a db copy: add --dry-run)"
        : gone[goneKey]!;
    process.stderr.write(
      `\`lbg ${goneKey}\` is gone: only \`lbg run\` calls models now. Use: ${instead}\n`,
    );
    return 1;
  }
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: OPTIONS,
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return cmd || values.help ? 0 : 1;
  }

  if (cmd === "topics" || cmd === "clusters") {
    process.stderr.write(
      `\`lbg ${cmd}\` is gone: topics and clusters became the knowledge tree. Use \`lbg tree\` (see lbg --help).\n`,
    );
    return 1;
  }
  const agents = values.agent ? parseAgents(values.agent) : undefined;
  const adapters = defaultAdapters();
  const out = (s: string) => process.stdout.write(s);
  const json = (v: unknown) => out(`${JSON.stringify(v, null, 2)}\n`);

  const run = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!run) {
    process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
    return 1;
  }
  return run({ cmd, rest, values, agents, adapters, out, json });
}

// `lbg … | head` closes stdout early: exit quietly instead of crashing on EPIPE.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

main(process.argv.slice(2)).then(
  (code) => {
    // Don't call process.exit(): it can truncate large output piped to stdout.
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);

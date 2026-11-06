# Using lbg

The complete reference for the `lbg` command line. For a first look, see the [README](../README.md). For how lbg works inside, see [architecture](architecture.md); for terms, the [glossary](glossary.md).

- [Setup](#setup)
- [Running lbg](#running-lbg)
- [Reviewing proposals](#reviewing-proposals)
- [Rejections and rejection memory](#rejections-and-rejection-memory)
- [Evidence (nuggets)](#evidence-nuggets)
- [Shaping the knowledge tree](#shaping-the-knowledge-tree)
- [Looking at sessions](#looking-at-sessions)
- [Shell prompt](#shell-prompt)
- [Background service](#background-service)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

Common options: `--json` prints machine-readable output; `--since` takes a duration (`30m`, `6h`, `7d`, `2w`), an ISO date, or `all`; `--agent` takes a comma-separated list (`claude,pi,opencode`). `lbg --help` prints every command with its options.

## Setup

You need Node ≥ 24 and pi configured with a default model (`~/.pi/agent/settings.json`). The interactive `lbg proposal revise` also needs the `pi` CLI on `PATH`.

```bash
npm install -g laobaigan       # puts `lbg` on PATH
lbg init                       # finds your agents' sessions, skills dir and pi's model; writes ~/.config/laobaigan/config.json
lbg run                        # first pass over all your history (takes a while; uses the model)
lbg service install            # then run hourly in the background
```

`lbg init` never overwrites an existing config. It tells you which agents' sessions it found, which skills directory it picked, and which model pi will use.

**Node version managers (mise, nvm, fnm, volta):** `npm install -g` installs into the current Node version's own directory. After you switch or upgrade Node, `lbg` disappears from `PATH` and the timer points at the old install. Either reinstall and run `lbg service install` again (it warns you about this), or install outside the versioned directory once with `npm config set prefix ~/.local` (with `~/.local/bin` on `PATH`).

**Upgrading:** `npm install -g laobaigan@latest`, then `lbg service install` again.

**Uninstalling:** `lbg service uninstall`, then `npm uninstall -g laobaigan`. Your data stays in `~/.local/state/laobaigan` until you delete it.

## Running lbg

`lbg run` does one pass, and it is the only command that makes the pipeline's model calls (the hourly timer runs it too):

1. **sync**: reads your skill files (global and the repositories lbg knows)
2. **extract**: classifies new rejections, then reads new or changed sessions into evidence
3. **insert**: files new evidence into the knowledge tree
4. **score**: decides which skills have earned a proposal
5. **draft**: drafts the top candidates as proposals (your files aren't touched)

With nothing new, a run makes no model calls. Work over the per-run budgets (see [Configuration](#configuration)) waits for the next run.

```bash
lbg run                                          # one pass now
lbg run --stages sync,score                      # only some stages
lbg run --only <skill-id>...                     # draft these candidates now (also ignores the 24 h retry wait after a failed draft)
lbg run --dry-run                                # a pass on a copy of your data: models are called, nothing is kept
lbg run --dry-run --fresh --stages extract --session pi:01a19be3   # what lbg would learn from one session
lbg run --max-calls 10                           # read at most 10 sessions this time
```

| Option | What it does |
|---|---|
| `--stages a,b` | Run only these stages (`sync`, `extract`, `insert`, `score`, `draft`). |
| `--only <id>…` | Draft only these skills, now. Without `--stages`, it runs sync, score and draft only. |
| `--session <agent>:<id>` | Read only this session (an id prefix is enough), even if it's still active. Prints what it learned. Pending rejections wait for a normal run. |
| `--dry-run` | Work on a temporary copy of the state database. Models are called and cost money, but nothing is kept, not even the prompt file. |
| `--fresh` | With `--dry-run` only: treat every message as new, even ones lbg has already read. |
| `--max-calls N` | Session budget for this run. |

The run prints one line per stage and one per new proposal:

```
draft   1 new proposal(s) (1 call(s), $0.0785)
new proposal #3: dataset-evaluation-and-review (1 file(s)) — review with: lbg proposal show 3
```

Exit codes: 0 ok, 2 a stage failed, 3 stopped after repeated model errors, 75 another run was still going.

`lbg status` shows counts and the run history with calls and cost per stage.

## Reviewing proposals

A proposal is a drafted change to one skill, kept in lbg's database until you accept or reject it.

```bash
lbg proposals                          # what's waiting: skill, kind, target, sessions, cost
lbg proposals --status accepted,rejected
lbg proposal show <id>                 # summary, evidence, items it left out, review feedback, diff against the live files
lbg proposal diff <id>                 # only the diff, in git format
```

`show` and `diff` page through `$LBG_PAGER`, else `delta` if installed, else `less -R`, when the output is a terminal. Use `--no-pager` to print directly.

### Kinds of proposal

| Kind | When | What it changes |
|---|---|---|
| `new` | something you explained in ≥ 3 sessions (or ≥ 2 with different agents) has no skill yet | a new skill folder (`SKILL.md` + `references/`), or a new `AGENTS.md` section / `.agents/skills/<name>` in a repository |
| `update` | a skill you have got new knowledge from ≥ 2 sessions | that skill's files |
| `fix-description` | you explained something a skill already says | the skill's `description`, so agents load it when they should |

Global knowledge goes to your skills directory; knowledge about one repository goes to that repository.

### Changing a draft

```bash
lbg proposal revise <id>               # chat with pi about the draft, in your own pi TUI
lbg proposal revise <id> "feedback"    # one shot: pi redrafts with your feedback
lbg proposal edit <id>                 # edit the drafted files in $VISUAL / $EDITOR
lbg proposal drop <id> <nugget>...     # take off-topic evidence off it
```

- Revise and edit only touch the draft. pi can write nothing but the proposal's files, and has no shell.
- The interactive revise needs a terminal. When you leave pi, lbg checks the draft (allowed paths, frontmatter, secrets) and asks you to go back in if something is wrong.
- `drop` re-files the evidence elsewhere (or under `--to <node>`), and it never comes back to this skill. Add `--reason "…"`; add `--revise` to redraft without it right away.
- lbg remembers what you say while reviewing: your messages in a revise chat, one-shot feedback, your hand edits and reject reasons. The next draft of that skill sees them, and other skills in the same scope see why you rejected something.

**New evidence while a proposal waits:** if you explain the topic again, the new evidence still lands on that skill. `lbg proposals` shows it as `+N new since draft`, `lbg proposal show` lists it, and a revise adds it to the draft. If you accept without revising, it still counts and can lead to an `update` proposal later.

**Live files that changed since the draft:** `lbg proposal show` warns, shows what changed on disk, and diffs against what the draft was based on. A revise or edit rebases the draft onto the current files.

### Accepting

```bash
lbg proposal accept <id>               # write the files
lbg proposal accept <id> --commit      # write them, then run your commitCommand (see Configuration)
lbg proposal accept <id> --force       # write them even though the live files changed since the draft
```

lbg never runs git. Accepting writes the files, makes the skill live in lbg's tree right away, and prints the paths and a suggested commit message. With `--commit` it runs your own `commitCommand`. If that command fails, the proposal is still accepted; commit by hand. Forgot `--commit`? Run it again on the accepted proposal: it only runs the commit, and tells you if you've edited the files since.

Accepting refuses if the live files changed since the draft was made: revise the proposal, or use `--force`.

### Rejecting

```bash
lbg proposal reject <id> --reason "…"
lbg proposal reject <id> --reason "…" --kind wrong-place --to <skill>
lbg proposal reject <id> --reason "…" --forget     # its evidence also stops counting
```

Rejecting makes no model call and keeps the files out. Give a reason: it is the most useful thing you can tell lbg. See the next section for what happens with it.

## Rejections and rejection memory

Each rejection leaves a **rejection memory**. The next `lbg run` classifies it into a kind and a one-line rule, unless you gave `--kind` (then your reason is the rule).

| Kind | Meaning | What lbg does |
|---|---|---|
| `outdated` | the knowledge is stale | its evidence stops counting; corrected knowledge about the topic is welcome and can be proposed |
| `not-useful` | don't make a skill about this topic | not extracted again, never proposed again; expires after 90 days |
| `wrong-place` | right knowledge, wrong skill | its evidence moves to the skill it belongs in (`--to`) |
| `later` | not now | proposed again once the topic comes up in 2 new sessions |

A rejection with no reason becomes `later`. Similar knowledge goes to the rejected skill instead of growing a look-alike, and drafts of nearby skills follow the rule. The run prints one line per classified memory (`rejection #N classified: … — check: lbg rejections`).

```bash
lbg rejections                                   # pending + active memories
lbg rejections --status removed
lbg rejections edit <id> --kind not-useful --rule "…" [--to <skill>]   # correct it; yours is never reclassified
lbg rejections keep <id>                         # renew a not-useful memory before it expires
lbg rejections forget <id>                       # stop using it
```

## Evidence (nuggets)

Evidence is what lbg extracted from your sessions: one thing you taught an agent, with quotes. `lbg proposal show` and `lbg tree show` list evidence ids.

```bash
lbg nuggets                                      # all stored evidence
lbg nuggets forget <id>... --reason "…"          # it's outdated: stops counting and stays out of drafts
lbg nuggets forget --skill <id> --before <date>  # a skill's evidence from before a date
lbg nuggets unforget <id>...
lbg nuggets move <id> <node>                     # re-file it under another skill or section
```

Forgotten evidence stays in the database, so lbg doesn't read its session again.

## Shaping the knowledge tree

lbg keeps what it has learned in a tree per scope: the global skills, and one per repository. Under each are skills, then sections, then evidence. A skill is **live** (one of your skill files), **declared** (named in your config) or **latent** (grown by lbg, not published yet).

```bash
lbg tree                               # every scope (live skills' own sections collapsed)
lbg tree --status candidate            # what will be drafted next
lbg tree show <id>                     # one skill or section: path, summary, sections, evidence
```

Hand edits are locked, so automation never undoes them. Your own skill files only change through proposals, and a skill with an open proposal can't be reshaped until you finish it.

```bash
lbg tree merge <into> <from>...        # fold skills into one (their sections and evidence move)
lbg tree split <skill> <section>... [--title "…"]   # move sections out into a new skill
lbg tree move <node> <parent>          # section → other skill, section → root (new skill), skill → section
lbg tree rename <id> --title "…" --name skill-name
lbg tree unlock <id>                   # let automation reorganize it again
```

Every edit re-scores right away. Two model-free commands run single stages by hand:

```bash
lbg tree sync [--dry-run]              # read your skill files into the tree now
lbg tree score                         # recompute scores and candidates now
```

## Looking at sessions

None of these call a model or change anything.

```bash
lbg sessions --since 7d [--agent pi,claude] [--settle 30m]   # sessions across agents
lbg show claude:27b8 [--user-only]                            # one session as lbg sees it (id prefix ok)
lbg scan [--since all]                                        # what the next run would read
lbg scan --session pi:01a19be3 --excerpt                      # the exact text the model would see for one session
lbg scan --session pi:01a19be3 --fresh --excerpt              # … as if lbg had never read it
```

## Shell prompt

lbg keeps `~/.local/state/laobaigan/prompt` up to date with the number of proposals waiting (empty when none). Your prompt only reads that file, so it costs a few milliseconds. `lbg prompt` shows the current count and prints the snippets below.

With [starship](https://starship.rs):

```toml
# ~/.config/starship.toml
[custom.lbg]
description = "laobaigan proposals waiting for review"
when = "test -s ~/.local/state/laobaigan/prompt"
command = "cat ~/.local/state/laobaigan/prompt"
shell = ["sh"]
format = "[🍶 $output]($style) "
style = "bold yellow"
```

Without starship (zsh):

```zsh
_lbg_prompt() { local f=~/.local/state/laobaigan/prompt; [[ -s $f ]] && RPROMPT="%F{yellow}🍶 $(<$f)%f" || RPROMPT=""; }
precmd_functions+=(_lbg_prompt)
```

## Background service

`lbg service install` sets up a systemd user timer that runs `lbg run` every hour.

```bash
lbg service install [--path <dir>[:<dir>…]]       # write and enable the units for this lbg
lbg service status                               # what the timer runs, next/last run
lbg service uninstall                            # remove (your data is kept)
systemctl --user start laobaigan.service         # run now
journalctl --user -u laobaigan -f                # follow the logs
systemctl --user disable --now laobaigan.timer   # pause
```

- **Credentials:** systemd doesn't load your shell profile. If your model provider's credentials need a tool that isn't on the default `PATH` (for example a `credential_process` helper in `~/.aws/config`), pass its directory with `--path`. Re-installing keeps the previous `--path` unless you give a new one. Extra environment variables (e.g. `AWS_PROFILE=…`) go in `~/.config/laobaigan/env`, one `KEY=value` per line.
- **Expired credentials:** after 3 failed model calls in a row the run stops making model calls (exit code 3). Nothing is lost; the next run after you refresh your credentials picks up where it left off.
- **Failed drafts:** a skill whose draft failed isn't retried for `render.retryAfterHours` (24). `lbg run --only <id>` retries it now.
- **Logged out:** user timers only run while you're logged in (an SSH session or tmux counts). To run from boot: `loginctl enable-linger $USER`.
- **Overlapping runs:** a second run while one is going exits with 75, which the service treats as success.

## Configuration

`~/.config/laobaigan/config.json` (written by `lbg init`; everything is optional; `LBG_CONFIG` points elsewhere):

```jsonc
{
  // The skills directory your agents load (detected by lbg init).
  "skillsDir": "~/.config/opencode/skills",

  // Models follow pi (defaultModel / defaultThinkingLevel in ~/.pi/agent/settings.json).
  // Override a stage with "provider/id", or an id of pi's default provider:
  // "models": { "extract": "…", "distill": "…" },

  // Skip sessions changed in the last N minutes (they may still be going).
  "settleMinutes": 30,

  // Per-run budgets.
  "extract": { "maxCallsPerRun": 50 },
  "insert": { "maxCallsPerRun": 20 },
  "render": { "maxPerRun": 2, "retryAfterHours": 24, "maxSkillLines": 300 },
  "rejections": { "maxCallsPerRun": 10, "expireDays": 90 },

  // Secrets specific to your environment, redacted before anything reaches a model
  // (in addition to the built-in rules: keys, tokens, JWTs, passwords, cookies, …).
  "redact": { "extraPatterns": [{ "pattern": "(corp_sso=)[^\\s;]+", "replace": "$1[REDACTED]", "name": "corp-sso" }] },

  // Optional steering: skills you want to exist, and a policy for how knowledge is grouped.
  "topics": [{ "name": "dotfiles-management", "description": "zsh, tmux, and agent configs in my dotfiles repo" }],
  "clustering": { "guidance": "Prefer one umbrella skill per ecosystem, with reference files per tool." },

  // What `lbg proposal accept <id> --commit` runs after writing the files (lbg never runs git itself).
  // One command for everything, or { "global": "…", "repo": "…" } per target.
  "commitCommand": {
    "global": "git --git-dir=~/.cfg --work-tree=~ add ${updated_files} && git --git-dir=~/.cfg --work-tree=~ commit -m ${draft_note}",
    "repo": "git -C ${target_root} add -- ${updated_files} && git -C ${target_root} commit -m ${draft_note} -- ${updated_files}"
  }
}
```

| Setting | Meaning |
|---|---|
| `extract.maxCallsPerRun` | sessions read per run |
| `insert.maxCallsPerRun` | routing calls per run |
| `render.maxPerRun` | proposals drafted per run |
| `render.retryAfterHours` | wait after a failed draft before the timer tries that skill again |
| `render.maxSkillLines` | a drafted `SKILL.md` longer than this fails its check (detail belongs in `references/`) |
| `rejections.maxCallsPerRun` | rejections classified per run |
| `rejections.expireDays` | when `not-useful` memories expire (0 = never) |

### commitCommand

`commitCommand` runs with `sh -c` in the target directory. Placeholders are replaced with shell-quoted values, so don't quote them yourself:

| Placeholder | Value |
|---|---|
| `${updated_files}` | every written or deleted file (absolute paths, each quoted) |
| `${draft_note}` | the suggested commit message (summary + evidence) |
| `${target_root}` | the skills directory, or the repository |
| `${skill}`, `${proposal_id}` | the skill name, the proposal id |

`~` in the command means your home directory, including after `=` (as in `--git-dir=~/.cfg`), which `sh` itself wouldn't expand.

## Troubleshooting

- **`warning: opencode: … uses the opencode 1.x schema`:** your opencode database predates opencode 2.x. Upgrade opencode and start it once to migrate it; until then lbg skips opencode and still reads the other agents.
- **Runs fail with credential errors:** refresh your provider's credentials. For the background service, check `--path` and `~/.config/laobaigan/env`.
- **`lbg: command not found` after a Node upgrade:** see the note on version managers under [Setup](#setup).
- **A proposal says another process is working on it:** a revise or edit is still open somewhere. Finish it, or wait: lbg notices when that process has ended.
- **Starting over:** stop the timer, delete `~/.local/state/laobaigan/state.db`, and run `lbg run` again. All history is processed again, which costs model calls.

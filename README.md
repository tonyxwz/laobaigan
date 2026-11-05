# Laobaigan (老白干)

*老白干 (lǎo bái gān) is a classic northern Chinese baijiu, a strong clear spirit made by distillation. This tool does the same with conversations: it boils the explanations you keep repeating to your coding agents down into skills.*

You keep telling your agents the same things in new sessions: how a project is built, where the logs live, which command to use instead of the obvious one. **lbg** reads your Claude Code, pi and opencode sessions in the background, notices what you've explained more than once, and drafts it as a [skill](https://pi.dev/docs/latest/skills), or as a section of a repository's `AGENTS.md`. Nothing changes until you review a proposal and accept it.

- Global knowledge goes to your shared skills directory; knowledge about one repository goes to that repository.
- Every change is a **proposal** you review. lbg never runs git: accepting writes the files, and you commit them if you want.
- All model calls go through [pi](https://pi.dev), with the provider, model and credentials pi is configured with.

Docs: [architecture](docs/architecture.md) · [glossary](docs/glossary.md) · [development](docs/development.md)

## Install

You need Node ≥ 24 and pi configured with a default model (`~/.pi/agent/settings.json`). The interactive `lbg proposal revise` also needs the `pi` CLI on `PATH`.

```bash
npm install -g laobaigan       # puts `lbg` on PATH
lbg init                       # finds your agents' sessions, skills dir and pi's model; writes ~/.config/laobaigan/config.json
lbg run                        # first pass over all your history (takes a while; uses the model)
lbg service install            # then run hourly in the background (systemd user timer)
```

**Node version managers (mise, nvm, fnm, volta):** `npm install -g` installs into the current Node version's own directory. After you switch or upgrade Node, `lbg` disappears from `PATH` and the timer points at the old install. Either reinstall and run `lbg service install` again (it warns you about this), or install outside the versioned directory once with `npm config set prefix ~/.local` (with `~/.local/bin` on `PATH`).

**Upgrading:** `npm install -g laobaigan@latest`, then `lbg service install` again.

**Uninstalling:** `lbg service uninstall`, then `npm uninstall -g laobaigan`. Your data stays in `~/.local/state/laobaigan` until you delete it.

## Reviewing proposals

```bash
lbg proposals                          # what's waiting: skill, kind, target, sessions, cost
lbg proposal show <id>                 # summary, evidence (which sessions, your quotes), diff against the live files
lbg proposal diff <id>                 # only the diff (pipe it into delta etc.)
lbg proposal revise <id>               # chat with pi about the draft, in your own pi TUI
lbg proposal revise <id> "feedback"    # or one shot: pi redrafts with your feedback
lbg proposal edit <id>                 # edit the drafted files in $VISUAL / $EDITOR
lbg proposal accept <id>               # write the files
lbg proposal accept <id> --commit      # write the files, then run your commitCommand (see Configuration)
lbg proposal reject <id> --reason "…"
```

A draft doesn't change by itself. If you explain the same topic again while a proposal waits, the new evidence still lands on that skill: `lbg proposals` shows it as `+N new since draft`, `lbg proposal show` lists it, and `lbg proposal revise` adds it to the draft. If you accept without revising, nothing is lost: the new evidence still counts, and can lead to an `update` proposal later.

There are three kinds of proposal:

| Kind | When | What it changes |
|---|---|---|
| `new` | something you explained in ≥ 3 sessions (or ≥ 2 with different agents) has no skill yet | a new skill folder (`SKILL.md` + `references/`), or a new `AGENTS.md` section / `.agents/skills/<name>` in a repo |
| `update` | a skill you have got new knowledge from ≥ 2 sessions | that skill's files |
| `fix-description` | you explained something a skill already says | the skill's `description`, so agents load it when they should |

- **Revise and edit** only touch the draft. pi can write nothing but the proposal's files, and has no shell.
- **Accepting** refuses if the live files changed since the draft was made: revise it, or use `--force`. After accepting, lbg prints the paths and a suggested commit message. For example, for skills kept in a dotfiles repo:

  ```bash
  git add ~/.config/opencode/skills/<skill> && git commit -m "skills: add <skill>"
  ```
- **Rejecting** keeps the files out. The skill is only proposed again if the topic comes up in new sessions.

## See waiting proposals in your shell prompt

lbg keeps `~/.local/state/laobaigan/prompt` up to date with the number of proposals waiting (empty when none). Your prompt only reads that file, so it costs a few milliseconds. With [starship](https://starship.rs):

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

`lbg prompt` shows the current count and prints both snippets.

## The background service

`lbg service install` sets up a systemd user timer that runs `lbg run` every hour. Each run:
1. reads your skill files
2. extracts new or changed sessions
3. files what you taught the agents into its knowledge tree
4. drafts the top candidates as proposals

With nothing new, a run makes no model calls. Work over the per-run budgets waits for the next run.

```bash
lbg service status                      # what the timer runs, next/last run
systemctl --user start laobaigan.service # run now
journalctl --user -u laobaigan -f        # follow the logs (one line per stage, one per new proposal)
lbg status                              # run history: calls and cost per stage
systemctl --user disable --now laobaigan.timer   # pause
lbg service uninstall                   # remove (your data is kept)
```

- **Credentials in the background:** systemd doesn't load your shell profile. If your model provider's credentials need a tool that isn't on the default `PATH`, install the service with those directories first on its `PATH`: `lbg service install --path <dir>[:<dir>…]`. An example is a `credential_process` helper in `~/.aws/config`. Extra environment variables (e.g. `AWS_PROFILE=…`) go in `~/.config/laobaigan/env`, one `KEY=value` per line.
- **Expired credentials:** after 3 failed model calls in a row the run stops making model calls (exit code 3). Nothing is lost; the next run after you refresh your credentials picks up where it left off.
- **Logged out:** user timers only run while you're logged in (an SSH session or tmux counts). To run from boot, use `loginctl enable-linger $USER`.
- **Exit codes:** 0 ok, 2 a stage failed, 3 stopped after repeated model errors, 75 another run was still going.

## Configuration

`~/.config/laobaigan/config.json` (written by `lbg init`; everything is optional):

```jsonc
{
  // The skills directory your agents load (detected by lbg init).
  "skillsDir": "~/.config/opencode/skills",

  // Models follow pi (defaultModel / defaultThinkingLevel in ~/.pi/agent/settings.json).
  // Override a stage with "provider/id", or an id of pi's default provider:
  // "models": { "extract": "…", "distill": "…" },

  // Per-run budgets.
  "extract": { "maxCallsPerRun": 50 },
  "insert": { "maxCallsPerRun": 20 },
  "render": { "maxPerRun": 2, "retryAfterHours": 24, "maxSkillLines": 300 },

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

`commitCommand` runs with `sh -c` in the target directory. Placeholders are replaced with shell-quoted values, so don't quote them yourself:

| Placeholder | Value |
|---|---|
| `${updated_files}` | every written or deleted file (absolute paths, each quoted) |
| `${draft_note}` | the suggested commit message (summary + evidence) |
| `${target_root}` | the skills directory, or the repo |
| `${skill}`, `${proposal_id}` | the skill name, the proposal id |

`~` in the command means your home directory, including after `=` (as in `--git-dir=~/.cfg`), which `sh` itself wouldn't expand. If the command fails, the proposal is still accepted and its files written; commit them yourself.

## Shaping what lbg learns

lbg keeps what it has learned in a knowledge tree of skills and sections. You can look at it and adjust it by hand. Hand edits are locked, so automation never undoes them; your own skill files only change through proposals.

```bash
lbg tree                               # skills per scope: live (your files), declared, latent (grown by lbg)
lbg tree --status candidate            # what will be drafted next
lbg tree show <id>                     # one skill or section: summary, evidence
lbg draft [<id>]                       # draft candidates now instead of waiting for the timer

lbg tree merge <into> <from>…          # fold skills into one
lbg tree split <skill> <section>…      # move sections out into a new skill
lbg tree move <node> <parent>          # re-home a section or skill
lbg tree rename <id> --title "…" --name skill-name
lbg nuggets move <nugget> <node>       # re-file one piece of evidence
```

`lbg --help` lists every command.

## Troubleshooting

- **`warning: opencode: … uses the opencode 1.x schema`:** your opencode database predates opencode 2.x. Upgrade opencode and start it once to migrate it; until then lbg skips opencode and still reads the other agents.
- **Runs fail with credential errors:** refresh your provider's credentials. For the background service, check `--path` and `~/.config/laobaigan/env` (see above).
- **`lbg: command not found` after a Node upgrade:** see the note on version managers under [Install](#install).
- **Starting over:** stop the timer, delete `~/.local/state/laobaigan/state.db`, and run `lbg run` again. All history is processed again, which costs model calls.

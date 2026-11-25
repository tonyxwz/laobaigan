# Laobaigan (老白干)

_老白干 (lǎo bái gān) is a classic northern Chinese baijiu, a strong clear spirit made by distillation. This tool does the same with conversations: it boils the explanations you keep repeating to your coding agents down into skills._

You keep telling your agents the same things in new sessions: how a project is built, where the logs live, which command to use instead of the obvious one. **lbg** reads your Claude Code, pi and opencode sessions in the background, notices what you've explained more than once, and drafts it as a [skill](https://pi.dev/docs/latest/skills), or as a section of a repository's `AGENTS.md`.

Nothing changes until you review a **proposal** and accept it. Model calls go through [pi](https://pi.dev), with the provider, model and credentials pi is configured with, or optionally through Claude Code ([see below](#use-claude-code)).

## Install

You need Node ≥ 24 and pi configured with a default model.

```bash
npm install -g laobaigan       # puts `lbg` on PATH
lbg init                       # finds your agents' sessions, skills dir and model; writes a starter config
lbg run                        # first pass over your history (takes a while; uses the model)
lbg service install            # then run hourly in the background
```

## Use Claude Code

lbg runs everything through one agent: reading sessions, placing knowledge in the tree, drafting, and revising. By default that's pi, with pi's default model. To use Claude Code instead (its [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), with your Claude Code login and billing), set it in `~/.config/laobaigan/config.json`:

```jsonc
{
  "agent": "claude-code",
  // Each agent has its own section. All optional.
  // model: unset for Claude Code's default model. thinking: off, minimal, low, medium or high.
  // executable: a path or a name on PATH (default: the claude bundled with the SDK).
  // settingSources: Claude Code settings to load (default ["user"], for your login / Bedrock settings).
  // settings: extra Claude Code settings for lbg's sessions only, e.g. plugins off.
  "claudeCode": {
    "model": "sonnet",
    "thinking": "medium",
    "executable": "~/.local/bin/claude",
    "settingSources": ["user"],
    "settings": { "enabledPlugins": { "some-plugin@marketplace": false } }
  }
}
```

Calls aren't saved to `~/.claude/projects`, and skills and MCP servers are off. Extraction gets no tools. Drafting and revising get Claude Code's built-in `Read`, `Glob`, `Grep`, `Write` and `Edit`, and lbg checks every call before it runs: reads stay inside the draft's worktree, writes only go to the proposal's paths. `lbg proposal revise <id>` opens your `claude` with the same check. Details: [Usage](docs/usage.md#claude-code).

## Review proposals

When lbg has drafted something, it waits for you:

```bash
lbg proposals                          # what's waiting
lbg proposal show <id>                 # what it would change, and the sessions it learned it from
lbg proposal revise <id>               # not quite right? talk it through with pi
lbg proposal accept <id>               # write the files
lbg proposal reject <id> --reason "…"  # no: say why, and lbg stops proposing things like it
```

To see in your shell prompt when something is waiting, run `lbg prompt` for a starship or zsh snippet.

## Learn more

- [Usage](docs/usage.md): every command and option, configuration, the background service, troubleshooting
- [Glossary](docs/glossary.md): the terms lbg uses
- [Architecture](docs/architecture.md): how it works inside
- [Development](docs/development.md): working on lbg itself

## License

[Apache 2.0](LICENSE)

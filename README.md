# Laobaigan (老白干)

*老白干 (lǎo bái gān) is a classic northern Chinese baijiu, a strong clear spirit made by distillation. This tool does the same with conversations: it boils the explanations you keep repeating to your coding agents down into skills.*

You keep telling your agents the same things in new sessions: how a project is built, where the logs live, which command to use instead of the obvious one. **lbg** reads your Claude Code, pi and opencode sessions in the background, notices what you've explained more than once, and drafts it as a [skill](https://pi.dev/docs/latest/skills), or as a section of a repository's `AGENTS.md`.

Nothing changes until you review a **proposal** and accept it. Model calls go through [pi](https://pi.dev), with the provider, model and credentials pi is configured with, or optionally through Claude Code for extraction ([see below](#use-claude-code-for-extraction)).

## Install

You need Node ≥ 24 and pi configured with a default model.

```bash
npm install -g laobaigan       # puts `lbg` on PATH
lbg init                       # finds your agents' sessions, skills dir and model; writes a starter config
lbg run                        # first pass over your history (takes a while; uses the model)
lbg service install            # then run hourly in the background
```

## Use Claude Code for extraction

Reading sessions for knowledge (extraction, plus classifying rejections and placing knowledge in the tree) can run on Claude Code through its [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), with your Claude Code login and billing. In `~/.config/laobaigan/config.json`:

```jsonc
{
  "models": { "extract": "claude-code/sonnet" },  // or "claude-code" for Claude Code's default model
  // Optional. executable: a path or a name on PATH (default: the claude bundled with the SDK).
  // settingSources: Claude Code settings to load (default ["user"], for your login / Bedrock settings).
  "claudeCode": { "executable": "claude", "settingSources": ["user"] }
}
```

Each call is isolated (no tools, skills, hooks or MCP servers) and isn't saved to `~/.claude/projects`. Drafting skills stays on pi, because it needs pi's file tools. Details: [Usage](docs/usage.md#claude-code-as-the-extractor).

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

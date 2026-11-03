# Laobaigan (老白干)

*老白干 (lǎo bái gān) is a classic northern Chinese baijiu, a strong clear spirit made by distillation. This project does the same with conversations: it boils the repeated explanations in my agent sessions down into skills.*

CLI: **`lbg`**. Package: `laobaigan`. State: `~/.local/state/laobaigan/`. Config: `~/.config/laobaigan/config.json`. Env overrides: `LBG_*`. Proposal branches: `laobaigan/<slug>-<date>`.

A background service that periodically scans chat sessions from all my AI coding agents, finds the knowledge **I keep explaining over and over**, and distills it into reusable [skills](https://pi.dev/docs/latest/skills). Every change is proposed on its **own git branch + worktree**, and I review and merge it myself.

> Status: **M0 + M1 done** (session inventory; change detection, fingerprint dedup, prefilter, redaction, extraction via pi/Bedrock). The git branch + worktree module for M3 is built and tested. **Next: M2** (cluster + score).

## Development

Requires Node ≥ 24 (runs `.ts` directly via native type stripping; uses built-in `node:sqlite`, so there are no native deps).

### Install the `lbg` CLI

```bash
scripts/install-cli.sh             # symlinks ~/.local/bin/lbg -> src/cli.ts
scripts/install-cli.sh uninstall
```

It's a symlink, not `npm link`. `npm link` would put it in mise's per-version Node prefix, where it disappears on the next Node upgrade. With the symlink, the command always runs the current code in this repo, with no build step. It needs `node` ≥ 24 on `PATH`. Set `BIN_DIR=...` to install somewhere other than `~/.local/bin`.

The examples below use `node src/cli.ts`; `lbg` is the same thing.

```bash
npm install
npm run check                                   # tsc --noEmit + vitest

node src/cli.ts sessions --since 7d             # list sessions across agents
node src/cli.ts sessions --agent pi,claude --settle 30m --json
node src/cli.ts show claude:27b8 --user-only    # one normalized transcript (id prefix ok)

node src/cli.ts scan                            # what extract would do: no model calls, no writes
node src/cli.ts scan --session pi:01a19be3 --fresh --excerpt   # exact text the model would see
node src/cli.ts extract                         # extract + persist (backfills everything on first run)
node src/cli.ts extract --session pi:01a19be3 --dry-run --fresh  # prompt tuning on one session
node src/cli.ts nuggets                         # stored nuggets
node src/cli.ts cluster [--dry-run]             # group nuggets into clusters, score topics
node src/cli.ts topics [show <id>]              # topics (future skills) by score
node src/cli.ts status                          # db counts + run log (tokens, cost)
```

State lives in `~/.local/state/laobaigan/state.db`. Delete it to re-run the backfill from scratch.

First backfill on this host: 24 sessions → 19 extracted, 5 skipped (empty or greetings only), 15 nuggets, 19 model calls, **≈ $0.17**, about 2 minutes.

Storage locations can be overridden with `LBG_CLAUDE_PROJECTS`, `LBG_PI_SESSIONS`, `LBG_OPENCODE_DB`, `LBG_SKILLS_DIR`, `LBG_STATE_DIR`.

## Running as a background service

A systemd **user** timer runs `node src/cli.ts run` hourly. Each run is a one-shot process: it takes a lock, processes new/changed sessions, logs a summary to the journal, and exits.

```bash
scripts/install-service.sh              # install/update units, enable + start the timer
loginctl enable-linger $USER            # optional: keep running while logged out (see below)
scripts/install-service.sh uninstall    # stop and remove (state is kept)
```

Day to day:

```bash
systemctl --user list-timers laobaigan.timer     # next/last run
systemctl --user start laobaigan.service          # run now
journalctl --user -u laobaigan -f                 # follow the logs
journalctl --user -u laobaigan --since today      # what happened today
systemctl --user disable --now laobaigan.timer    # pause
node src/cli.ts status                                  # run history with tokens + cost
```

How it's wired:

- **Units:** `systemd/laobaigan.service.in` (template) and `systemd/laobaigan.timer`. The install script fills in the absolute `node` path (mise shims are resolved, since they don't work without a shell) and the repo path, and writes them to `~/.config/systemd/user/`. To change the units, edit the files in this repo and re-run the script.
- **Schedule:** `OnCalendar=hourly` with up to 5 min random delay. `Persistent=true` catches up on missed runs, so the first install starts a run right away.
- **Credentials:** systemd doesn't load your shell profile. If your provider's credentials need a tool that isn't on the default `PATH` (e.g. a `credential_process` helper in `~/.aws/config`), install with `EXTRA_PATH=<dir>[:<dir>…] scripts/install-service.sh` and the unit puts those directories first on its `PATH`. Put extra variables (e.g. `AWS_PROFILE=...`) in `~/.config/laobaigan/env`, one `KEY=value` per line.
- **Expired credentials:** when your provider's credentials expire, model calls fail. After 3 consecutive model errors the run **aborts** (exit 3) instead of marking every session failed. Failed sessions are retried on the next run, so after you refresh the credentials nothing is lost.
- **Overlap:** a pid lock file (`~/.local/state/laobaigan/run.lock`) makes a second concurrent run exit with 75, which the unit treats as success. Stale locks from crashed runs are taken over.
- **Exit codes:** 0 ok, 2 some sessions failed (unit shows *failed*), 3 aborted, 75 locked.
- **Lingering:** without `loginctl enable-linger`, user timers only fire while you have a session (an SSH login or tmux counts). With linger they run from boot. Since every run is incremental, either works; with linger off the backlog is just processed at your next login.
- **Footprint:** `Nice=10`, idle IO priority, ~180 MB RSS while running, typically 0–2 model calls per hourly run.

TypeScript conventions: only erasable syntax (`erasableSyntaxOnly`: no enums, namespaces, or constructor parameter properties), and relative imports use `.ts` extensions.

## Problem

I use several agents on this host: **Claude Code, pi, opencode** (daily), plus **Kiro CLI** and **Codex** (occasionally). Every agent has its own session history, but they all load the same skills, via symlinks:

```
~/.config/opencode/skills          <- the real directory (tracked in my dotfiles bare repo ~/.cfg)
~/.claude/skills    -> ../.config/opencode/skills
~/.pi/agent/skills  -> ../../.config/opencode/skills
```

I keep re-explaining the same things in new sessions, often across different agents: how a project is built, where the logs for service X live, "use a worktree, not a second clone", how to get credentials for account Y. Each explanation gets lost when the session ends. A skill would capture it once and every agent would pick it up.

## Goals

1. **Incremental scanning.** Process all history once, then only sessions that are new or changed, including **resumed** sessions.
2. **Detect repeated explanations.** Find the facts and procedures that *I* gave the agent and that the agent didn't already know, then keep the ones that show up in **multiple sessions**.
3. **Distill into the right place:**
   - knowledge that applies everywhere → a **global skill** in the shared skills directory
   - knowledge about one repo → that **repo's own** `AGENTS.md` or `.agents/skills/<name>/SKILL.md`
4. **Never update skills automatically.** Every proposal is a commit on a fresh branch in a fresh git worktree. I review it and merge it into main myself.
5. **All AI reasoning goes through the pi SDK** (`@earendil-works/pi-coding-agent`), using the **Amazon Bedrock provider only**. This repo has no direct LLM API clients.

## Non-goals (for now)

- Summarizing or searching sessions in general.
- Syncing skills across machines.
- Changing the agents' own configuration.
- Auto-merging anything.

## Decisions

| Topic | Decision |
|---|---|
| Repo-specific knowledge | Goes into the repo: `<repo>/AGENTS.md` for short rules/facts, `<repo>/.agents/skills/<name>/SKILL.md` for procedures. Never a global skill. |
| History | Backfill **all** history on the first run. Dedup state lives in SQLite, so re-runs are cheap. |
| Resumed sessions | Detected via a per-session change token. Already-processed user turns are tracked by **content fingerprint**, so only new turns are re-extracted, even when an agent copies old history into a new session file. |
| Provider | `amazon-bedrock` only. Enforced in code: a model that doesn't resolve to that provider is a hard error. |
| Models | Extract: `global.openai.gpt-6.1-sol`. Draft: `global.anthropic.claude-opus-5-5`. Both configurable. |
| Skill granularity | **Few** global skills, each about one coherent topic (e.g. "Gradle builds", not "Gradle release flags"). Laobaigan prefers extending an existing skill over creating a new one. |
| Apply | No auto-update. One branch + worktree per proposal; the git dir / work tree / base branch are configurable (supports the `~/.cfg` bare dotfiles repo). |

### Should extraction use a cheaper model?

Not now. On this host the whole history is **27 sessions, ~343K tokens** of normalized transcript (tool output already truncated), and the prefilter cuts that further. At `gpt-6.1-sol` prices ($2 / M input, $10 / M output) the full backfill costs **well under $1**, and incremental runs cost cents. Extraction is also the step where quality matters most: a missed nugget never reaches the drafting step.

If volume grows (say, more agents or heavier use), the switch is one config value. The candidates on Bedrock, by price:

| Model | $/M in / out | Notes |
|---|---|---|
| `global.openai.gpt-6.1-sol` | 2 / 10 | current choice |
| `global.anthropic.claude-sonnet-5-5` | 2 / 10 | same price; use it for a same-family A/B against `sol` |
| `global.openai.gpt-6-luna` | 0.1 / 0.5 | ~20× cheaper; first thing to try for a cheap tier |
| `global.anthropic.claude-haiku-5-5` | 0.1 / 0.5 | same price as `luna`; 5× more expensive above 100K input tokens |

If we need the savings later, the plan is a **two-tier extract**: a cheap model (`luna` or `haiku-5-5`) answers "does this chunk contain anything I taught the agent? yes/no", and only the "yes" chunks go to `sol`. The run log records token usage per stage, so we'll know when it's worth it.

---

## Architecture

```
                ┌──────────────────────── scheduler (systemd user timer) ───────────────────────┐
                │                                                                                │
  ┌──────────┐  │  ┌───────────┐   ┌────────────┐   ┌─────────────┐   ┌───────────┐   ┌─────────┐ │
  │ Claude   │──┼─▶│           │   │            │   │             │   │           │   │         │ │
  │ pi       │──┼─▶│  Source   │──▶│ Normalize  │──▶│  Extract    │──▶│ Aggregate │──▶│ Distill │─┼─▶ git branch +
  │ opencode │──┼─▶│ adapters  │   │ + prefilter│   │ (pi, per    │   │ (cluster, │   │ (pi, in │ │   worktree per
  │ codex    │──┼─▶│           │   │ + redact   │   │  session)   │   │  score)   │   │ worktree│ │   proposal
  │ kiro     │──┼─▶│           │   │            │   │             │   │           │   │         │ │      │
  └──────────┘  │  └───────────┘   └────────────┘   └─────────────┘   └───────────┘   └─────────┘ │      ▼
                │        ▲                                  │               │                     │  I review +
                │        └────────── state store (SQLite: sessions, fingerprints, nuggets, …) ◀───┘  merge to main
                └────────────────────────────────────────────────────────────────────────────────┘
```

### 1. Source adapters

Each agent stores sessions differently. An adapter turns one agent's storage into a common `Transcript`.

| Agent | Location on this host | Format | Change token |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` | JSONL, one event per line (`user`, `assistant`, plus meta lines such as `mode` and `file-history-snapshot`), tree via `uuid` / `parentUuid` | `mtimeMs:size` |
| pi | `~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl` | JSONL tree of entries linked by `parentId` (see pi `docs/session-format.md`) | `mtimeMs:size` |
| opencode | `~/.local/share/opencode/opencode.db` | SQLite (`session_v2`, `session_message`) | `session_v2.time_updated` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (*not installed yet, to verify*) | JSONL | `mtimeMs:size` |
| Kiro CLI | *to verify* (probably a SQLite db under `~/.local/share/kiro-cli/`) | ? | ? |

```ts
interface SourceAdapter {
  readonly agent: AgentId;                       // "claude" | "pi" | "opencode" | "codex" | "kiro"
  available(): Promise<boolean>;
  list(opts?: { since?: Date }): AsyncIterable<SessionRef>;   // cheap: stat / one SQL query
  load(ref: SessionRef): Promise<Transcript>;
}

interface SessionRef { agent; sessionId; location; cwd?; title?; updatedAt: Date; version: string }

interface Transcript {
  agent: AgentId;
  sessionId: string;
  cwd: string;                                   // project / workspace the session ran in
  startedAt: Date;
  updatedAt: Date;
  turns: Turn[];                                 // all branches, chronological; off-branch turns flagged
}

interface Turn {
  role: "user" | "assistant" | "tool";
  text: string;                                  // tool results truncated
  toolCalls?: { name: string; input: string }[];
  origin?: "prompt" | "command" | "interrupt";   // user turns
  offBranch?: boolean;                           // rewound / edited away
  ts?: Date;
}
```

**Branches:** Claude (rewind / edited prompt) and pi (`/tree`) sessions are trees. We emit *every* branch in chronological order and set `offBranch: true` on turns that aren't on the active leaf→root path. A rewound prompt followed by a rephrased one is often a correction, which is exactly the signal we want.

**Noise filtered at the adapter level:** thinking blocks, system/meta messages, skill-body injections, `<local-command-stdout>`, `<task-notification>`, sub-agent sidechains. Slash commands are normalized to `/cmd args` with `origin: "command"`.

**Quiescence rule:** skip any session modified within the last *N* minutes (default 30) so we don't process a conversation that's still running. The next run picks it up.

### 2. Change detection and dedup

The first run processes everything. After that, the expensive work only happens for what actually changed:

1. **Listing is cheap.** `list()` is one `stat` per JSONL file, or one SQL query for opencode. It produces a `version` token per session.
2. **Unchanged sessions are skipped** without being parsed: if `(agent, sessionId, version)` matches the `session` table, the session is done.
3. **Changed sessions are parsed**, and each user turn gets a **fingerprint**: `sha256(normalized text + timestamp)`. A session counts as "new work" only if it has user turns whose fingerprints aren't in the `turn_seen` table. This handles:
   - **resume in place** (pi, opencode, and Claude when it appends to the same file): only the new tail is extracted
   - **resume into a new file** (agents that copy old history into a new session id): the copied turns are already fingerprinted, so they aren't extracted or counted twice
   - **metadata-only changes** (title updated, file touched): no new fingerprints, so no LLM call
4. **The previous turns stay as context.** When a resumed session is re-extracted, the earlier part of the conversation is sent as condensed context, so the model understands what the new turns refer to. Only the new turns can be cited as evidence.
5. Fingerprints are written **only after** extraction for that session succeeds, so a crash or a Bedrock error means the session is retried next run.

### 3. Prefilter and redact (deterministic, no LLM)

- **Condense** each session into an *excerpt*: every human prompt in full, the assistant text just before and after it (truncated), tool-call names, and tool **errors** (truncated). Ordinary tool output is dropped. Each human turn gets a stable label (`U1`, `U2`, …) that the model cites as evidence.
- **Drop trivial sessions:** no human prompts, or only greetings / one-word acks.
- **Score signals** (stored for ranking and debugging, not used to drop sessions during the backfill):
  - long explanatory user messages (as opposed to short commands)
  - correction phrases: "no,", "actually", "as I said", "I told you", "again", "don't", "always", "never", "should be"
  - rewinds (`offBranch` prompts)
  - the agent hitting a tool error, then me stepping in
- **Chunk** long sessions so each extract call stays within a token budget.
- **Redact** secrets before anything leaves the process: AWS access keys, `aws_secret_access_key`, bearer tokens, JWTs, private-key blocks, `password=` / `token=` / `apiKey:` style assignments.
- **Exclude our own sessions.** Laobaigan's pi sessions use `SessionManager.inMemory()`, so they're never written to disk and never feed back into the scan.

### 4. Extract "knowledge nuggets" (pi SDK, one call per session chunk)

A headless pi session reads one excerpt and reports **nuggets**: things *I* taught the agent.

```ts
interface Nugget {
  kind: "procedure" | "fact" | "preference" | "correction" | "location";
  title: string;             // one line, canonical phrasing
  knowledge: string;         // the actual content: commands, paths, rules (markdown)
  triggers: string[];        // when would an agent need this? ("building a Gradle project")
  scope: "global" | "repo";
  repo?: string;             // absolute repo path when scope = "repo"
  evidence: string[];        // turn labels, e.g. ["U3", "U7"]
  coveredBySkill?: string;   // an existing skill that already contains this
  confidence: number;        // 0..1
}
```

- The model reports results **only** through a custom tool (`report_knowledge`), whose result sets `terminate: true` so the run ends right after. That gives us schema-validated output (TypeBox) instead of parsing JSON out of free text.
- No built-in tools (`noTools: "all"`). Everything the model needs is in the prompt.
- The prompt includes the **existing skill index** (global skills + the session repo's `.agents/skills` and `AGENTS.md` headings), so the model can set `coveredBySkill`.
- `scope` rule of thumb: "would this help in a *different* repo?" If not, it's `repo`. The repo is the git top-level of the session's `cwd`, or a path the evidence refers to.

### 5. Aggregate and score (deterministic + light pi)

Two levels:

```
topic    = one skill (or one AGENTS.md section)      e.g. "Dotfiles management"
└ cluster = a subtopic: a section or references/x.md  e.g. "tmux", "zsh profiles", "pi config"
  └ nugget = one thing I taught an agent, with evidence
```

Recurrence is counted at the **topic** level, so an umbrella topic surfaces even when each subtopic came up only once.

1. **Cluster** nuggets that say the same thing.
   - v1: ask pi to assign each new nugget to an existing cluster or start a new one, using compact cluster summaries.
   - A new cluster gets its own topic until it's grouped under a broader one (declared topics, curation, or the consolidation pass).
2. **Score** each topic on the union of its clusters' nuggets:
   ```
   score = distinct_sessions × w1
         + distinct_agents   × w2     // explained to Claude AND pi → strong signal
         + distinct_days     × w3
         + correction_bonus           // "I told you…", rewinds
         − already_covered_penalty    // an existing skill already covers it
   ```
3. **Promote** a cluster to a candidate when `distinct_sessions ≥ 3`, or `≥ 2` across different agents (configurable). Fingerprint dedup means a resumed copy of a session doesn't inflate the count.
4. **Pick the target:**
   - `global:new`: no existing global skill fits **and** the topic is coherent enough to stand on its own. Otherwise prefer:
   - `global:update:<skill>`: extend the closest existing skill.
   - `global:fix-description:<skill>`: the skill already has the content, but I still had to explain it, so its `description` probably doesn't trigger when it should.
   - `repo:agents-md:<repo>`: short repo facts/rules → the repo's `AGENTS.md`.
   - `repo:skill:<repo>/<name>`: a repo-specific procedure → `<repo>/.agents/skills/<name>/SKILL.md`.

### 6. Distill (pi SDK, agentic, inside a git worktree)

For each candidate:

1. **Create a branch and a worktree** in the target repository (see [Git workflow](#git-workflow)).
2. Run a pi session with `cwd` = the worktree and tools `read`, `edit`, `write`, `ls`, `find`, `grep` (no `bash`), with model `claude-opus-5-5`. It writes or edits the skill / `AGENTS.md` in the worktree, following our house rules:
   - `description` is specific about *when* to trigger
   - real commands and paths instead of vague prose
   - no secrets, no session-specific trivia
   - stay under a size budget; prefer extending a skill over adding one
3. **Verify** the result deterministically: only allowed paths changed, the frontmatter has `name` and `description`, no redaction patterns match.
4. **Commit** on the branch with a message that includes the cluster summary and evidence (agent, session id, date, short quotes).
5. Record the proposal (`branch`, `worktree`, target, status `open`) in the state db.

### 7. Review (me)

```
lbg proposals                  # list open proposals: branch, worktree, target, evidence
lbg proposal show <id>         # diff vs. base + evidence
lbg proposal done <id>         # after I merged or rejected: remove worktree, delete branch if merged
lbg proposal reject <id>       # suppress the cluster until enough new evidence appears
```

I review the diff in the worktree, edit it if I want, and merge into the base branch myself, e.g. `cfg merge skills/make-20261103`. Laobaigan never pushes, merges, or touches the base branch. If I merge a branch outside the CLI, the next run notices (the branch is reachable from base) and marks the proposal `merged`.

### Git workflow

Targets are described in config, so the git commands work for normal repos and for the bare dotfiles repo:

```jsonc
// ~/.config/laobaigan/config.json
{
  "skillsRepo": {
    "gitDir": "~/.cfg",                     // --git-dir; omit for a normal repo
    "workTree": "~",                        // --work-tree of the main checkout
    "skillsPath": ".config/opencode/skills",// skills dir, relative to workTree
    "baseBranch": "main"
  },
  "worktreesDir": "~/.local/state/laobaigan/worktrees",
  "branchPrefix": "laobaigan/",
  "models": {
    "extract": "global.openai.gpt-6.1-sol",
    "distill": "global.anthropic.claude-opus-5-5"
  }
}
```

Steering the grouping (optional):

```jsonc
{
  // Topics I want to exist. Always offered as homes, even with no nuggets yet.
  "topics": [
    {
      "name": "dotfiles-management",          // becomes the skill name
      "description": "~/.cfg bare repo (ddd alias), zsh profiles, tmux, mise/Homebrew, agent configs for pi/opencode/Claude Code"
    },
    { "name": "run-evals", "scope": "repo", "repo": "~/code/my-service", "description": "..." }
  ],
  // Free-text policy appended to the grouping prompt.
  "clustering": { "guidance": "Prefer one umbrella skill per ecosystem, with reference files per tool." }
}
```

Per proposal:

```bash
git --git-dir=~/.cfg worktree add -b laobaigan/<slug>-<date> <worktreesDir>/<slug>-<date> main
# pi edits <worktree>/.config/opencode/skills/...
git --git-dir=~/.cfg --work-tree=<worktree> commit ...   # commit happens in the worktree only
```

- For **repo-scoped** targets the repo is detected from the session `cwd` (`git rev-parse --show-toplevel`), and the base branch is the repo's current default branch. Same branch + worktree flow.
- A worktree of the dotfiles repo checks out all tracked dotfiles, not just skills. That's fine (they're small) and keeps the commit a normal commit on the real history.
- One proposal = one branch = one worktree, so proposals never conflict with each other, and rejecting one is just deleting its branch.

### Scheduling

- A **systemd user timer** (`~/.config/systemd/user/laobaigan.{service,timer}`), running hourly by default. Each run is one process that does its work and exits. Simple, observable (`journalctl --user -u laobaigan`), and there's no daemon to babysit.
- A lock file prevents overlapping runs.
- Per-run budgets: max extract calls, max distill calls, max tokens. Whatever's left over is processed in the next run, so the backfill spreads over a few runs if needed.
- `lbg run --dry-run` runs the pipeline by hand while developing.

### State (SQLite, `~/.local/state/laobaigan/state.db`)

| Table | Purpose |
|---|---|
| `session` | `(agent, session_id)` → `version`, location, cwd, timestamps, prefilter signals, last status |
| `turn_seen` | user-turn fingerprint → first `(agent, session_id)` it was seen in; drives dedup across resumes |
| `nugget` | extracted nuggets + evidence (agent, session, turn label, quote) |
| `topic` | one future skill / AGENTS.md section: title, declared name/description, score, status (`open` / `candidate` / `proposed` / `merged` / `rejected`), target, locks |
| `cluster` | a subtopic under a topic: title, merged summary, member nuggets |
| `proposal` | cluster, target, repo, branch, worktree, commit, status |
| `run` | run log: counts, token usage and cost per stage, errors |

---

## pi SDK usage

All LLM work goes through one wrapper (`src/pi/run-pi.ts`) so we can enforce Bedrock, budget calls, and test against fakes:

```ts
const { session } = await createAgentSession({
  cwd,
  model,                                   // resolved via ModelRuntime.getModel("amazon-bedrock", id)
  thinkingLevel,
  modelRuntime,
  resourceLoader: minimalLoader(systemPrompt),  // no extensions/skills/AGENTS.md: reproducible runs
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }),
  sessionManager: SessionManager.inMemory(cwd), // never write lbg sessions to disk
  tools,                                   // [] for extract, file tools for distill
  customTools: [resultTool],               // returns { terminate: true } once the model reports
});
await session.prompt(prompt);
const stats = session.getSessionStats();   // token usage / cost for the run log
```

Answered SDK questions:
- **Stopping after the result tool:** the tool result sets `terminate: true`, and the agent stops after that tool batch.
- **Reproducibility:** a custom `ResourceLoader` loads no extensions, skills, or context files. The skill index is passed explicitly in the prompt.
- **Token usage:** `session.getSessionStats()`.

---

## Repo layout

```
src/
  cli.ts                    # sessions | show | scan | run | proposals | ...
  config.ts                 # defaults + ~/.config/laobaigan/config.json
  sources/                  # one adapter per agent
  state/db.ts               # node:sqlite schema + queries
  pipeline/
    fingerprint.ts
    prefilter.ts            # excerpt, signals, chunking
    redact.ts
    extract.ts              # pi
    cluster.ts              # pi (v1)
    score.ts
    distill.ts              # pi, in a worktree
  skills/index.ts           # global + repo-local skill index
  git/worktree.ts           # branch + worktree per proposal, bare-repo aware
  pi/run-pi.ts              # Bedrock-only SDK wrapper
  pi/models.ts
test/
systemd/
```

## Milestones

1. **M0: Read-only inventory.** Adapters for Claude, pi, and opencode; `sessions` and `show` commands. ✅
2. **M1: State + prefilter + extract.** Change detection, fingerprint dedup, redaction, nuggets in SQLite; `scan` and `extract --dry-run`. Tune the prompt on real sessions. ✅
3. **M2: Cluster + score.** A `status` view of the top recurring clusters. This is the first point where we can see whether the idea works.
4. **M3: Distill + git workflow.** Branch + worktree per proposal, `proposals` CLI. (`src/git/worktree.ts` is done and tested against a bare dotfiles-style repo and a normal repo.)
5. **M4: systemd timer**, budgets, run log, notifications. (Timer, lock, run log, error-abort done; notifications pending.)
6. **M5:** Codex and Kiro adapters.

## Open questions

- **Skill quality feedback.** Track whether a merged skill actually reduces repeat explanations, and propose a `fix-description` when it doesn't.
- **Dotfiles worktree size.** If checking out the whole dotfiles repo per proposal becomes slow, switch to a sparse checkout limited to `skillsPath`.

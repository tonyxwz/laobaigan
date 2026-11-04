# Laobaigan (老白干)

*老白干 (lǎo bái gān) is a classic northern Chinese baijiu, a strong clear spirit made by distillation. This project does the same with conversations: it boils the repeated explanations in my agent sessions down into skills.*

CLI: **`lbg`**. Package: `laobaigan`. State: `~/.local/state/laobaigan/`. Config: `~/.config/laobaigan/config.json`. Env overrides: `LBG_*`.

A background service that periodically scans chat sessions from all my AI coding agents, finds the knowledge **I keep explaining over and over**, and distills it into reusable [skills](https://pi.dev/docs/latest/skills). Every change is a **proposal** stored in its database; I review it with `lbg proposal` and accept or reject it. lbg never runs git: accepting writes the files, and I commit them myself if I want.

> Progress, milestones and open work are tracked in beads, not here: run `bd list --type epic` for the milestones, `bd ready` for what's next, and `bd show <id>` for details.

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
node src/cli.ts tree [--status candidate]       # the knowledge tree: roots → skills → sections
node src/cli.ts tree show <id>                  # one node: path, summary, sections, evidence
node src/cli.ts tree insert [--all] [--dry-run] # sync skill files, route new nuggets into the tree, score
                                                #   (lbg cluster is the same command)
node src/cli.ts tree merge|split|move|rename|unlock ...   # curate by hand (locked; live files only change via proposals)
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
4. **Never update skills automatically.** Every change is a proposal (drafted files kept in lbg's database). I review it with `lbg proposal show` and accept or reject it. **lbg doesn't use git**: accepting only writes the target files; committing is up to me.
5. **All AI reasoning goes through the pi SDK** (`@earendil-works/pi-coding-agent`), using **whatever model pi is configured with** (`~/.pi/agent/settings.json`). This repo has no direct LLM API clients.

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
| Provider | Whatever pi uses: its `defaultProvider` (today `amazon-bedrock`). lbg has no provider policy of its own; pi's settings are the single place to choose. |
| Models | pi's default (`defaultModel` / `defaultThinkingLevel`; today `global.anthropic.claude-opus-5-5`), for every stage, including the interactive `revise` chat. `models.*` in lbg's config can override a stage (`provider/id`, or an id of pi's default provider). |
| Skill granularity | **Few** global skills, each about one coherent topic (e.g. "Gradle builds", not "Gradle release flags"). Laobaigan prefers extending an existing skill over creating a new one. |
| Apply | No auto-update, and no git. A proposal is a snapshot of drafted files (with hashes of the originals) in SQLite; `lbg proposal accept` writes them into the skills dir or repo, refusing if the files changed since. I commit with git myself (e.g. in the `~/.cfg` bare dotfiles repo). |

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
  │ pi       │──┼─▶│  Source   │──▶│ Normalize  │──▶│  Extract    │──▶│ Aggregate │──▶│ Distill │─┼─▶ proposal in
  │ opencode │──┼─▶│ adapters  │   │ + prefilter│   │ (pi, per    │   │ (cluster, │   │ (pi, in │ │   the db; I   
  │ codex    │──┼─▶│           │   │ + redact   │   │  session)   │   │  score)   │   │ scratch)│ │   accept it
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
- `scope` rule of thumb: "would this help in a *different* repo?" If not, it's `repo`. The repo is the nearest ancestor with a `.git` entry of the session's `cwd`, or a path the evidence refers to.

### 5. The knowledge tree (insert, score, rebalance)

The skills directory is already a tree with progressive disclosure, so lbg keeps one **knowledge tree per scope** and mirrors it 1:1 onto files:

```
depth 0  root            global: the skill list every agent loads   repo: <repo>/AGENTS.md (always loaded in that repo)
depth 1  skill           name + description (always loaded)          repo: an AGENTS.md section, or .agents/skills/<name>
depth 2  section         a SKILL.md section or references/<x>.md (loaded on demand)
leaves   nuggets         things I taught an agent, with evidence (never shown to agents)
```

Depth is capped at 2 below the root. Agents don't reliably follow deeper "see references/x.md" chains, and the cap bounds the cost: every operation looks at one node's children, never the whole tree.

**Budgets** (`config.tree`): at most `maxSkills` depth-1 nodes in the global tree (the always-loaded cost every agent pays), at most `maxSections` children per skill, and size limits per node. Breaking a limit triggers a rebalance of *that node only*.

**Where nodes come from**
- **Parsed from files (`live`).** Every run starts by parsing `~/.config/opencode/skills` (each skill becomes a depth-1 node; its `##` sections and `references/*.md` become depth-2 nodes) and each known repo's `AGENTS.md` and `.agents/skills`. Files are the source of truth: my hand edits and accepted proposals are picked up with no sync logic, and new knowledge is routed into my existing skills.
- **Declared (`config.topics`).** Pinned depth-1 nodes that exist before they have any nuggets.
- **Grown by lbg (`latent`).** Created while inserting; invisible to agents until promoted and accepted.

**Operations**, the same at every level:

```
insert(batch):            route new nuggets top-down, one batched model call per level:
                          root → which skill (or "new skill")? → which section (or "new section" / skill body)?
                          A call is skipped when only one child could fit.
score(node):              recurrence = distinct sessions / agents / days over the node's subtree.
                          A latent skill is promoted (candidate) at ≥ 3 sessions, or ≥ 2 across agents.
                          A live skill gets an update proposal when *new* evidence since its last render passes the threshold.
rebalance(node):          only when a budget is clearly exceeded (hysteresis):
                          too many sections → group into a reference / split the skill;
                          root over maxSkills → propose merging the two closest skills.
                          Locked and declared nodes are never moved; changes at depth 1 are always their own proposal.
render(subtree) → files:  the drafting step (below). Only changed subtrees are rendered, so each proposal is a small, local diff.
```

Summaries are **lazy**: routing needs only names and one-line descriptions, so a node's full summary is rewritten only when its subtree is about to be rendered.

**Curation** works on nodes: `merge`, `split`, `move`, `rename`, `unlock`, and moving a single nugget. Every hand edit is locked, so automation never undoes it.

**Scoring weights** (unchanged):
```
score = distinct_sessions × w1 + extra_agents × w2 + extra_days × w3 + corrections × w4 − already_covered × w5
```
"Already covered" has a special meaning in the tree: if a nugget is routed to a live section that already contains it, I still had to explain it, so the skill's description isn't triggering. The proposal for that skill fixes its `description`, not its content.

Repo trees use the same model. Short facts at depth 1 render as `AGENTS.md` sections, longer procedures as `.agents/skills/<name>/SKILL.md`. Multi-package workspace roots (a `packageInfo` file and per-package repos under `src/`) are mapped to the package the evidence names.

### 6. Render a subtree (pi SDK, agentic, in a scratch copy)

For each candidate (a promoted latent skill, or a live skill with enough new evidence), `lbg draft`:

1. **Resolves the target**: the global skills dir (`skillsDir`) → `<name>/`, or the repo (nearest ancestor with `.git`) → `AGENTS.md` and/or `.agents/skills/<name>/`. Evidence filed under a multi-package workspace root is skipped for now.
2. **Copies only those paths** into a scratch dir and runs a pi session there with guarded file tools (read the copy, write only the target paths, no bash) and model `claude-opus-5-5`. It writes the skill **folder**: `SKILL.md` with the routing description and the shared workflow, plus `references/<section>.md` for subtopics agents only need sometimes. House rules:
   - `description` is specific about *when* to trigger
   - real commands and paths instead of vague prose
   - no secrets, no session-specific trivia
   - `SKILL.md` within `render.maxSkillLines`
3. **Verifies** deterministically: only the target paths changed; frontmatter `name` = folder name (lowercase-hyphen, ≤ 64 chars) and `description` ≤ 1024; for `AGENTS.md`, every other section and the preamble are unchanged; no secrets or `[REDACTED]` placeholders.
4. **Stores the changed files** on the proposal (path, hash of the original, new content), deletes the scratch dir, and marks the proposal `open`. Nothing live has changed yet.

### 7. Review (me)

```
lbg proposals                          # open proposals: skill, kind, target, sessions, cost
lbg proposal show <id>                 # summary, evidence, diff against the live files (warns if they changed since)
lbg proposal revise <id>               # chat with pi about the draft (your pi TUI; it can write only the draft's files)
lbg proposal revise <id> "feedback"    # one shot: pi redrafts with the feedback
lbg proposal edit <id>                 # edit the drafted files in $VISUAL / $EDITOR
lbg proposal accept <id> [--force]     # write the files; refuses if the live files changed since the draft
lbg proposal reject <id> --reason ...  # the skill comes back only with evidence from new sessions
```

`revise` and `edit` work on a scratch copy of the draft and store the result on the proposal after the same checks as drafting; if the checks fail you can go back in or keep the previous draft. They start from the live files *now*, so they also rebase a stale draft. The interactive chat is your local `pi` (the one on `PATH`) with lbg's guard extension (`--no-approve --no-extensions --no-skills --no-context-files`, so nothing in the draft folder is loaded as a project resource and there's no trust prompt; tools `read,ls,find,grep,write,edit`, no bash), on pi's own model settings; its session is kept in a temp dir, not in `~/.pi/agent/sessions`, so lbg never learns from its own drafting chats.

Accepting writes the files and syncs the tree, so the skill is live immediately (its evidence counts as absorbed). lbg prints the paths and a suggested commit message; committing is up to me, e.g. in the dotfiles repo:

```bash
git --git-dir=$HOME/.cfg --work-tree=$HOME add .config/opencode/skills/dotfiles-management
git --git-dir=$HOME/.cfg --work-tree=$HOME commit -m "skills: add dotfiles-management"
```

### Configuration

```jsonc
// ~/.config/laobaigan/config.json (all optional)
{
  "skillsDir": "~/.config/opencode/skills",   // the global skills every agent loads
  // Models follow pi: defaultModel / defaultThinkingLevel in ~/.pi/agent/settings.json.
  // Optional per-stage overrides ("provider/id", or an id of pi's default provider):
  // "models": { "extract": "amazon-bedrock/global.openai.gpt-6.1-sol", "distill": "...", "extractThinking": "medium" },
  "render": { "maxPerRun": 2, "maxSkillLines": 300 }
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
| `proposal` | one drafted change per skill: node, kind (`new` / `update` / `fix-description`), status (`drafting` → `open` → `accepted` / `rejected`, or `failed`), target root + writable paths, drafted files (path, hash of the original, content), summary, evidence, cost |
| `node` | the knowledge tree: parent, depth, scope/repo, name, description, summary (lazy), origin (`file` / `declared` / `latent`), status, score, locks, source path |
| `run` | run log: counts, token usage and cost per stage, errors |

---

## pi SDK usage

All LLM work goes through one wrapper (`src/pi/run-pi.ts`) so model choice comes from pi's settings, calls are budgeted, and tests run against pi's faux provider:

```ts
const { session } = await createAgentSession({
  cwd,
  model,                                   // pi's defaultProvider/defaultModel, or a models.* override
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
  cli.ts                    # sessions | show | scan | extract | run | tree | draft | proposals | ...
  config.ts                 # defaults + ~/.config/laobaigan/config.json
  sources/                  # one adapter per agent
  state/db.ts               # node:sqlite schema, migrations, nuggets
  state/tree.ts             # the knowledge tree (nodes)
  state/proposals.ts        # proposals and their lifecycle
  pipeline/
    fingerprint.ts prefilter.ts redact.ts
    extract.ts              # pi: nuggets from sessions
    sync.ts                 # skill files → live tree nodes
    insert.ts               # pi: route nuggets top-down into the tree
    treescore.ts stats.ts   # recursive scoring
    curate.ts               # hand edits (locked)
    render.ts               # pi: draft a skill in a scratch copy → proposal
    accept.ts               # diff, accept (write files), reject
  skills/                   # parse SKILL.md / AGENTS.md, repo resolution
  pi/run-pi.ts              # SDK wrapper; model from pi's settings
  pi/guard-extension.ts     # guarded tools for the interactive revise chat
  pi/guard.ts               # guarded file tools for drafting
test/
systemd/
```

## Milestones and open work

Tracked with [beads](https://github.com/gastownhall/beads) (`bd`) in this repo:

```bash
bd list --type epic          # milestones
bd ready                     # what can be worked on now
bd ready --label mvp         # the path to a usable product
bd show <id>                 # details, dependencies, acceptance criteria
```

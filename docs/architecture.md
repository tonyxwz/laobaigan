# Architecture

How lbg (laobaigan) works inside. For using it, see the [README](../README.md); for the terms, the [glossary](glossary.md); for working on the code, [development.md](development.md).

## The problem

People who use several coding agents (Claude Code, pi, opencode, …) keep re-explaining the same things in new sessions, often to different agents: how a project is built, where a service's logs live, "use a worktree, not a second clone", which credentials go with which account. Each explanation is lost when the session ends. A skill would capture it once, and every agent loading that skill would pick it up.

## Goals

1. **Incremental.** Process all history once, then only sessions that are new or changed, including resumed sessions.
2. **Find repeated explanations.** Keep facts and procedures that *the user* gave the agent, and propose them once they recur across sessions.
3. **Put knowledge in the right place.** Knowledge that applies everywhere goes to a global skill in the shared skills directory. Knowledge about one repository goes to that repository's `AGENTS.md` or `.agents/skills/<name>/`.
4. **Never change skills on its own.** Every change is a proposal the user reviews and accepts. lbg doesn't use git; committing is up to the user.
5. **All model calls go through pi** (`@earendil-works/pi-coding-agent`), with whatever provider and model pi is configured with. lbg has no LLM API clients of its own.

Non-goals: searching or summarizing sessions in general, syncing skills across machines, changing the agents' own configuration, auto-merging anything.

## Pipeline

```
 Claude Code ─┐                                                        skills dir / repo
 pi ──────────┼─▶ adapters ─▶ prefilter ─▶ extract ─▶ insert ─▶ score ─▶ draft ─▶ proposal ─▶ accept ─┐
 opencode ────┘   (sessions)  + redact    (nuggets)   (tree)              (pi, scratch)  (db)   (you)  │
                                                         ▲                                             │
                                                         └──────────────── sync (files → tree) ◀──────┘
```

One `lbg run` (hourly, systemd user timer) runs the stages in order: **sync → extract → insert → score → draft** (`src/pipeline/run.ts`). Each stage has its own budget, a failing stage doesn't stop the others, and with nothing new a run makes no model calls. Repeated model errors (e.g. expired credentials) stop extraction and skip the remaining model stages. At the end the run writes the prompt file and one run-log row with calls and cost per stage.

## 1. Source adapters

Each agent stores sessions differently. An adapter (`src/sources/`) lists sessions cheaply and turns one into a common `Transcript`:

| Agent | Storage | Format | Change token |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` | JSONL events; a tree via `uuid` / `parentUuid` | `mtimeMs:size` |
| pi | `~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl` | JSONL entries; a tree via `parentId` | `mtimeMs:size` |
| opencode | `~/.local/share/opencode/opencode.db` | SQLite 2.x schema (`session_v2`, `session_message`) | `session_v2.time_updated` |

```ts
interface SourceAdapter {
  readonly agent: AgentId;
  available(): Promise<boolean>;
  list(opts?: { since?: Date }): AsyncIterable<SessionRef>;  // cheap: stat / one SQL query
  load(ref: SessionRef): Promise<Transcript>;
}

interface Transcript { agent; sessionId; cwd; startedAt; updatedAt; turns: Turn[] }
interface Turn {
  role: "user" | "assistant" | "tool";
  text: string;                                  // tool results truncated
  toolCalls?: { name: string; input: string }[];
  origin?: "prompt" | "command" | "interrupt";   // user turns
  offBranch?: boolean;                           // rewound / edited away
  ts?: Date;
}
```

- **Branches:** Claude Code (rewinds, edited prompts) and pi (`/tree`) sessions are trees. Every branch is emitted in chronological order, and turns off the active leaf-to-root path are flagged `offBranch`. A rewound prompt followed by a rephrased one is often a correction.
- **Noise filtered by the adapters:** thinking blocks, system and meta messages, skill-body injections, local command output, task notifications, sub-agent sidechains. Slash commands become `/cmd args` with origin `command`.
- **Isolation:** an adapter that can't read its storage (e.g. an opencode 1.x database) raises `SourceUnavailable`. That agent is skipped with a warning, and the others still run.

## 2. Change detection and dedup

1. **Listing is cheap:** one `stat` per JSONL file, or one SQL query, giving a change token per session.
2. **Unchanged sessions are skipped** without parsing, when `(agent, sessionId, token)` matches the `session` table.
3. **Changed sessions** get a fingerprint per human turn (hash of the normalized text and timestamp). Only turns with fingerprints not yet in `turn_seen` count as new. This handles:
   - resuming in place, where only the new tail is extracted
   - resuming into a new file, where the copied turns are already known
   - metadata-only changes, which cost no model call
4. **Earlier turns stay as context.** They are sent condensed and labelled `C`, and can't be cited.
5. **Fingerprints are written only after extraction succeeds,** so a crash or model error means the session is retried next run.
6. **Settle time:** sessions modified in the last `settleMinutes` (30) wait for the next run.
7. **lbg's own sessions are excluded:**
   - SDK sessions are in-memory and never written to disk.
   - The interactive revise chat stores its session in a temp dir.
   - Any session whose working directory is an `lbg-draft-*` or `lbg-chat-*` scratch dir is skipped.

## 3. Prefilter and redact (no model)

- **Excerpt:** every new human turn in full; the assistant text just before and after it, truncated; tool names and tool errors. New turns are labelled `U1`, `U2`, … for citation.
- **Trivial sessions are skipped:** no human prompts, or only greetings and acknowledgements.
- **Signals** are stored for ranking and debugging: long explanatory messages, correction phrases ("no,", "actually", "as I said", "don't", "always", …), rewinds, and the user stepping in after a tool error.
- **Chunking** keeps each extract call within `extract.chunkTokens`.
- **Redaction** (`src/pipeline/redact.ts`) runs before any text leaves the process. It covers AWS keys and secrets, bearer tokens, JWTs, private keys, `password=` / `token=` / `apiKey:` assignments and cookie headers, plus `redact.extraPatterns` from the config.

## 4. Extract nuggets (pi, one call per chunk)

A headless pi session reads one excerpt and reports **nuggets**, the knowledge the user taught the agent (`src/pipeline/extract.ts`):

```ts
interface Nugget {
  kind: "procedure" | "fact" | "preference" | "correction" | "location";
  title: string;             // one line
  knowledge: string;         // self-contained markdown: commands, paths, rules
  triggers: string[];        // when an agent would need it
  scope: "global" | "repo";
  repo?: string;             // repo root when scope = "repo"
  evidence: { label: string; quote: string }[];   // U-labels only
  coveredBySkill?: string;   // an existing skill that already says this
  confidence: number;        // 0..1; < 0.5 is dropped
}
```

- The model answers only through a result tool (`report_knowledge`) whose result ends the run (`terminate: true`), so the output is schema-validated (TypeBox) instead of parsed from free text.
- No built-in tools: everything is in the prompt, including an index of existing skills (global ones, plus the session repo's `.agents/skills` and `AGENTS.md` headings).
- Scope rule of thumb: "would this help in a different repository?" A repo is the nearest ancestor of the session's working directory that has a `.git` entry, or the session's working directory itself as a fallback.

## 5. The knowledge tree

Skill files already form a tree with progressive disclosure, so lbg keeps **one tree per scope** that mirrors them (`src/state/tree.ts`):

```
depth 0  root     global: the skill list every agent loads   repo: <repo>/AGENTS.md preamble (always loaded there)
depth 1  skill    a skill folder (name + description)        repo: an AGENTS.md "##" section, or .agents/skills/<name>
depth 2  section  a SKILL.md "##" section or references/*.md  repo: an AGENTS.md "###" subsection
         nuggets  attach to skills and sections, never to roots
```

Depth is capped at 2 below the root. Agents don't reliably follow deeper chains of references, and the cap bounds cost: every operation looks at one node's children, never the whole tree.

**Where nodes come from (origin):**
- **live** (`file`): parsed from files at the start of every run. Files are the source of truth: hand edits and accepted proposals show up with no extra sync logic, and new knowledge is routed into existing skills.
- **declared:** skills asked for in `config.topics`, which exist before they have evidence.
- **latent:** grown by lbg while inserting; invisible to agents until proposed and accepted.

**Sync** (`src/pipeline/sync.ts`) parses:
- each skill folder in the global skills dir: `SKILL.md` frontmatter, `##` sections, `references/*.md`, with symlinked folders followed
- for every repo the tree knows, its `AGENTS.md` (`##` → depth 1, `###` → depth 2; a `CLAUDE.md` that only points at `AGENTS.md` is ignored) and `.agents/skills`

Nodes are matched first by source path, then by name or title, which is how a latent node becomes live once its proposal is accepted. Removing a file never drops evidence: a section's nuggets move up to its skill, and a skill that still holds nuggets turns latent.

**Insert** (`src/pipeline/insert.ts`) routes new nuggets down the tree, one batched model call per level:
- **Level 1**, per scope root: the prompt lists the root's skills (id, live/declared/latent, name, title, description, section titles), never their full content. Each nugget goes to a skill, or to a new latent skill.
- **Level 2**, per touched skill that has sections (or is a non-file skill receiving several nuggets): each nugget goes to a section, a new section, or the skill body. Nuggets whose content the live text already states are flagged **covered**.
- Calls are skipped when there's nothing to decide, and invalid model output is repaired, so every nugget is placed exactly once.
- Summaries are lazy: only marked stale, and rewritten when the subtree is drafted. The stable part of the prompt (the skill list) comes first so the provider can cache it.

**Score** (`src/pipeline/treescore.ts`): each skill is scored over its whole subtree.

| Skill | Evidence that counts | Earns |
|---|---|---|
| latent or declared | all of it | `new` at ≥ 3 sessions, or ≥ 2 across agents |
| live | attached after the skill's last render (**fresh**) | `update` at ≥ 2 sessions |
| live | fresh, and already stated in the file (**covered**) | `fix-description` at ≥ 2 sessions: it was explained again, so the skill didn't trigger |

The numeric score (sessions, extra agents, extra days, corrections, minus coverage) only orders candidates; the thresholds above decide them. Status rules:
- A candidate falls back to open when it stops qualifying.
- A proposed skill is left to the proposal lifecycle.
- A rejected skill returns only after evidence from new sessions.

**Curation** (`src/pipeline/curate.ts`): `merge`, `split`, `move`, `rename`, `unlock` on nodes, and moving a nugget.
- Every hand edit is locked, so automation never undoes it.
- A live skill's own structure changes only through proposals.
- A node with an active proposal can't be reshaped.

**Not built yet:** rebalancing nodes that grow over a budget (too many skills or sections), and re-inserting small latent skills so they merge into better homes. Both are tracked in beads.

## 6. Draft a proposal (pi, in a scratch copy)

For each candidate, `lbg draft` (also the draft stage of `lbg run`, at most `render.maxPerRun` per run) does the following (`src/pipeline/render.ts`):

1. **Resolves the target.**
   - Global: the skills dir → `<name>/`.
   - Repo: a live `AGENTS.md` section → `AGENTS.md`; a live repo skill → `.agents/skills/<name>/`; otherwise either of those, chosen by the model by size.
   - Evidence filed under a multi-package workspace root (not a repo) is skipped for now.
2. **Copies only the target paths** into a scratch dir (`lbg-draft-*`) and runs pi there with the **guarded tools** (`src/pi/guard.ts`).
   - `read`, `ls`, `find`, `grep`, `write`, `edit`, under pi's built-in names; a custom tool replaces the built-in of the same name.
   - Every path is resolved through symlinks; reads are confined to the scratch dir, writes to the target paths. `.git` is never writable, and there is no bash.
   - The prompt carries the house rules: the description says *when* to use the skill, exact commands and paths, no secrets or session trivia, detail in `references/`. It also includes the evidence (marked NEW / already absorbed / ALREADY IN THE FILE for updates) and the other skills' descriptions to avoid duplicates.
3. **Verifies the result:**
   - only target paths changed
   - frontmatter `name` equals the folder name (lowercase, hyphens, ≤ 64 chars) and the description is ≤ 1024 chars
   - `SKILL.md` is within `render.maxSkillLines`
   - for `AGENTS.md`, the preamble and every section other than the target are unchanged
   - no secrets and no `[REDACTED]` placeholders
4. **Stores the changed files on the proposal** (path, hash of the original, new content), deletes the scratch dir, and marks the proposal `open`. The live files are untouched.

A failed draft becomes a `failed` proposal and the skill stays a candidate. `lbg run` waits `render.retryAfterHours` before trying it again; `lbg draft <id>` retries right away.

## 7. Review (`src/pipeline/accept.ts`, `revise.ts`, `interactive.ts`)

- **Who is working on a proposal:** each proposal records the pid of the lbg process drafting it, or running a `revise` / `edit` session on it (a chat can last hours; the proposal stays `open`). While that process is alive, other lbg commands refuse to accept, reject, revise or edit it. When it has died (crash, Ctrl-C, timer timeout), the next `lbg draft`, `lbg run` or `lbg proposals` recovers it: a `drafting` proposal becomes `failed` and its skill a candidate again; an `open` one is just released, its stored draft intact. lbg's state is per host, so pids are too.
- **Evidence while a proposal is open:** insert keeps routing nuggets into the proposed skill; the draft isn't redrafted automatically. Each proposal records `drafted_at`, when its evidence was taken (the draft, or the last AI revise; a hand `edit` doesn't change it). Nuggets attached after it are **new since the draft**: `lbg proposals` shows the count, `show` lists them, and revise marks them `(NEW SINCE THE DRAFT)` for pi and then adds them to the proposal's evidence.
- **show / diff:** the stored files against what's on disk now, plus the evidence. A draft whose targets changed since drafting is **stale**.
- **accept:** refuses a stale draft unless `--force`. Otherwise it writes the files into the target, marks the proposal accepted, and syncs, so the skill is live immediately. The live skill is dated to `drafted_at`, not to the accept: evidence the files contain counts as absorbed, and evidence that arrived while the proposal waited still counts as new (and can earn an `update`). It prints the paths and a suggested commit message; lbg never runs git.
- **reject:** the skill becomes `rejected` and records its session count; it returns only with evidence from new sessions.
- **revise "feedback":** pi redrafts in a scratch copy that starts from the live files plus the stored draft, which also rebases a stale draft. The result passes the same checks before replacing the stored files.
- **revise (interactive):** starts the user's own `pi` CLI from `PATH` in the scratch dir:

  ```
  pi --session-dir <temp> --no-approve --no-extensions --no-skills --no-context-files
     --no-prompt-templates --no-mcp -e <guard-extension> --tools read,ls,find,grep,write,edit
     --append-system-prompt <rules + evidence + current draft> --name ...
  ```

  The guard extension (`src/pi/guard-extension.ts`) registers the same guarded tools from `LBG_GUARD`. `--no-approve` skips pi's trust prompt for the scratch dir, and the temp session dir keeps the chat out of `~/.pi/agent/sessions`. When the user exits, the result is verified and stored. If verification fails, the user can go back in or keep the previous draft.
- **edit:** opens the drafted files in `$VISUAL` / `$EDITOR`, with the same verification loop.

## 8. Models (`src/pi/run-pi.ts`)

All model work goes through one wrapper:

```ts
const { session } = await createAgentSession({
  cwd, model, thinkingLevel, modelRuntime,
  resourceLoader: minimalLoader(systemPrompt),   // no extensions, skills or AGENTS.md: reproducible
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3 } }),
  sessionManager: SessionManager.inMemory(cwd),  // lbg's sessions are never written to disk
  tools,                                         // none for extract/insert; guarded file tools for drafting
  customTools: [resultTool],                     // terminate: true once the model reports
});
await session.prompt(prompt);
session.getSessionStats();                       // tokens and cost for the run log
```

- **Model:** pi's `defaultProvider` / `defaultModel` / `defaultThinkingLevel` from `~/.pi/agent/settings.json`, read through `SettingsManager`. `models.*` in lbg's config can override a stage. lbg has no provider policy of its own.
- **Credentials** are pi's own.
- **Missing result:** if the model doesn't call the result tool, it's asked once more; then the call fails.
- **Tests** run real pi sessions on pi's faux provider, through the same `SdkPiRunner`.

## 9. Running unattended

- **Units:** `lbg service install` writes `~/.config/systemd/user/laobaigan.{service,timer}` from `systemd/laobaigan.service.in`.
  - `ExecStart` is the node running lbg (with mise, its major-version alias) plus the `lbg` entry point it was invoked as.
  - `WorkingDirectory=%h`.
  - Optional extra `PATH` directories (for credential helpers) and `~/.config/laobaigan/env` for extra variables.
  - `Nice=10` and idle IO priority.
- **Schedule:** hourly, up to 5 minutes random delay, `Persistent=true` to catch up on missed runs.
- **Lock:** a pid lock file (`run.lock`) makes a concurrent run exit 75; stale locks from crashed runs are taken over.
- **Exit codes:** 0 ok, 2 a stage failed, 3 aborted after repeated model errors, 75 locked.
- **Prompt file:** `<stateDir>/prompt` holds the number of open proposals, written atomically after every run and after `lbg draft` / `lbg proposal …`. The shell prompt only reads it.

## 10. State (`~/.local/state/laobaigan/state.db`, `node:sqlite`)

| Table | Holds |
|---|---|
| `session` | `(agent, session_id)` → change token, location, cwd, timestamps, prefilter signals, last status |
| `turn_seen` | human-turn fingerprint → the session it was first seen in (dedup across resumes) |
| `nugget` | extracted nuggets, evidence, the tree node they're attached to, when they were attached, the live node that already covered them, hand-placement lock |
| `node` | the knowledge tree: parent, depth, scope/repo, name, title, description, summary (lazy), origin, status, proposal kind, score and stats, locks, source path and hash, render time |
| `proposal` | node, kind, status (`drafting` → `open` → `accepted` / `rejected`, or `failed`), target root and writable paths, drafted files (path, original hash, content), summary, evidence, cost |
| `run` | one row per run: calls, tokens and cost per stage |

Migrations are numbered SQL in `src/state/db.ts` and applied on open (`PRAGMA user_version`).

## 11. Code layout

```
bin/lbg.js                   launcher: src/cli.ts in a checkout, dist/cli.js when installed
src/
  cli.ts                     commands
  config.ts                  defaults, ~/.config/laobaigan/config.json, skills dir detection
  init.ts service.ts         lbg init, lbg service
  sources/                   one adapter per agent
  state/db.ts tree.ts proposals.ts
  pipeline/
    fingerprint.ts prefilter.ts redact.ts process.ts extract.ts
    sync.ts insert.ts treescore.ts stats.ts curate.ts
    render.ts accept.ts revise.ts interactive.ts
    run.ts                   the lbg run pass
  skills/                    parse SKILL.md / AGENTS.md, repo resolution
  pi/run-pi.ts guard.ts guard-extension.ts
  notify/prompt.ts           the shell prompt file
systemd/                     unit templates
test/
```

## Decisions

| Topic | Decision |
|---|---|
| Repo knowledge | Goes into the repo (`AGENTS.md` for short rules, `.agents/skills/<name>/` for procedures), never into a global skill. |
| History | Backfill all history on the first run; dedup state makes re-runs cheap. |
| Resumed sessions | Change tokens plus per-turn fingerprints: only new turns are extracted, even when an agent copies old history into a new file. |
| Models and provider | Whatever pi uses (`~/.pi/agent/settings.json`), so pi's settings are the single place to choose. `models.*` can override a stage. |
| Skill granularity | Few skills, each about one coherent topic, with details in sections and references; prefer extending an existing skill. |
| Applying changes | Never automatic, and no git. A proposal is a snapshot of drafted files with hashes of the originals; accepting writes them and refuses stale ones. Committing is up to the user. |
| Interactive revise | The user's own `pi` TUI with lbg's guard extension, rather than a chat UI inside lbg. |

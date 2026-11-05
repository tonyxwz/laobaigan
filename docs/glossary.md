# Glossary

The terms lbg (laobaigan) uses, in the order data flows through it:

```
sessions ─extract─▶ nuggets ─insert─▶ knowledge tree ─score─▶ candidates ─draft─▶ proposals ─accept─▶ skill files
   ▲                                       │                                                          │
   └──────────────── agents load skills ◀──┴──────────────────── sync ◀───────────────────────────────┘
```

## Sessions

**Agent**
: A coding assistant whose history lbg reads: Claude Code, pi, opencode (Kiro and Codex later).

**Session**
: One conversation with an agent, as the agent stored it (a JSONL file for Claude Code and pi, rows in opencode's SQLite db). Identified by `agent:sessionId`.

**Source adapter**
: The code that reads one agent's storage and turns its sessions into transcripts (`src/sources/`). If an agent's storage can't be read (e.g. the opencode 1.x schema), that agent is skipped with a warning.

**Transcript**
: A session normalized into a common shape: working directory, timestamps, and a list of turns. Thinking blocks, injected system text and tool noise are dropped.

**Turn**
: One message in a transcript: `user`, `assistant`, or `tool`. A **human turn** is a user turn you typed (a prompt or a slash command), as opposed to tool results or interrupts.

**Off-branch turn**
: A turn you rewound past or edited away (Claude Code rewinds, pi `/tree`). Kept and flagged, because a rewound prompt followed by a rephrased one is often a correction.

**Settle time**
: Sessions modified in the last `settleMinutes` (30) are skipped, because they may still be in progress.

**Change token**
: A cheap per-session version (file mtime + size, or opencode's `time_updated`). Sessions whose token didn't change since the last run aren't read at all.

**Fingerprint**
: A hash of a human turn's text and time. Used for dedup: only turns with new fingerprints are extracted, so a resumed session (or one copied into a new file) doesn't count twice.

## Extraction

**Excerpt**
: The condensed, redacted text the extraction model reads for one session: your turns in full, the assistant replies around them (truncated), tool names and tool errors. Long sessions are split into chunks.

**Label (`U1`, `C`)**
: Each new human turn in an excerpt is labelled `U1`, `U2`, …; the model cites these as evidence. Turns already processed in an earlier run appear as `C` (context): readable, but not citable.

**Redaction**
: Secrets (keys, tokens, passwords, cookies) are replaced by `[REDACTED…]` before any text reaches a model.

**Extract**
: The model call that reads an excerpt and reports nuggets (`src/pipeline/extract.ts`).

**Nugget**
: One piece of knowledge **you taught an agent** in a session, written so a future agent can act on it without that session. The unit everything else is built from. Fields:
  - **kind**: `procedure` (how to do something), `fact` (what/where something is), `preference` (a convention you insist on), `correction` ("no, do Y, not X"), `location` (where things live)
  - **title** and **knowledge**: one line, then the self-contained content with exact commands and paths
  - **triggers**: situations where an agent would need it
  - **scope**: `global` (useful in any repo) or `repo` (one repository, with its path)
  - **evidence**: the turn labels it came from, with short quotes, timestamps, agent and session
  - **confidence**: 0–1; below 0.5 it's dropped
  - **covered**: set when it was routed to a live skill that already says this

  Example: *"Use `rg` rather than `grep -r` to search code"*: a `correction`, `global`, from a pi session on 2026-11-02.

**Evidence**
: The sessions behind a nugget or a skill. Counting distinct evidence (sessions, agents, days) is how lbg tells a repeated explanation from a one-off.

## The knowledge tree

**Knowledge tree**
: How lbg organizes nuggets: one tree per scope, shaped like the skill files it produces (`src/state/tree.ts`).

```
depth 0  root     the always-loaded layer: the global skill list, or a repo's AGENTS.md
depth 1  skill    one skill folder (name + description), or an AGENTS.md "##" section
depth 2  section  a "##" section of SKILL.md, a references/*.md file, or an AGENTS.md "###" subsection
         nuggets  attached to skills or sections, never to roots
```

**Scope**
: Either `global` (the shared skills directory every agent loads) or `repo` (one repository: its `AGENTS.md` and `.agents/skills`). Nuggets, skills and proposals never cross scopes.

**Root**
: The top node of one scope's tree. A repo root holds that repo's `AGENTS.md` preamble (the text before the first `##`). Roots never hold nuggets and are never proposed.

**Skill (node)**
: A depth-1 node: one future or existing skill. What gets scored and proposed.

**Section (node)**
: A depth-2 node: a subtopic of a skill. Rendered as a section of `SKILL.md` or as `references/<section>.md`, which agents read only when needed.

**Origin**: where a node came from:
  - **live** (`file`): parsed from an existing skill file or `AGENTS.md` section. Files are the source of truth for these.
  - **declared**: a skill you asked for in `config.topics`, existing before it has evidence.
  - **latent**: grown by lbg from evidence; invisible to agents until proposed and accepted.

**Status** (of a skill):
  - **open**: nothing to do
  - **candidate**: has earned a proposal, of kind `new`, `update` or `fix-description`
  - **proposed**: has a drafting or open proposal; frozen against curation and re-scoring
  - **rejected**: you rejected its proposal; returns only with evidence from new sessions

**Sync**
: Reading the skill files back into the tree at the start of every run (`src/pipeline/sync.ts`). Your hand edits and accepted proposals show up as live nodes; removed files never drop evidence.

**Insert**
: Routing new nuggets down the tree, one batched model call per level: root → which skill (or a new latent one) → which section (or the skill body) (`src/pipeline/insert.ts`).

**Render time** (`renderedAt`)
: When a live skill's files last changed (your edit, or an accepted proposal). Evidence attached before it counts as already absorbed into the file.

**Fresh evidence**
: For a live skill: evidence attached after its render time, which the file doesn't say yet.

**Covered evidence**
: For a live skill: something you explained even though the skill already says it. A sign the skill's description doesn't trigger.

**Score**
: A number that orders skills (sessions, extra agents, extra days, corrections, minus coverage). It only ranks candidates; promotion is decided by readable session thresholds (`src/pipeline/treescore.ts`).

**Promotion**
: A skill becoming a candidate:
  - **new**: a latent or declared skill with evidence from ≥ 3 sessions, or ≥ 2 across different agents
  - **update**: a live skill with fresh evidence from ≥ 2 sessions
  - **fix-description**: a live skill with covered evidence from ≥ 2 sessions

**Curation**
: Your hand edits to the tree: `lbg tree merge | split | move | rename | unlock` and `lbg nuggets move`. Every edit is **locked**, so automation never undoes it. Live skills change only through proposals.

## Proposals

**Draft**
: pi writing one candidate skill's files (`src/pipeline/render.ts`), in a **scratch dir**: a temporary copy of only that skill's target paths. Your real files are never touched while drafting.

**Guarded tools**
: The file tools the drafting model gets (`read`, `ls`, `find`, `grep`, `write`, `edit`), confined to the scratch dir, with writes allowed only to the skill's paths. No bash (`src/pi/guard.ts`).

**Verification**
: Checks on a draft before it's stored: only the target paths changed, frontmatter `name` matches the folder, the description fits, `SKILL.md` isn't too long, other `AGENTS.md` sections are untouched, no secrets.

**Proposal**
: One drafted change to one skill, stored in lbg's database: the changed files (path, hash of the original, new content), a summary for you, the evidence, and the cost. lbg doesn't use git.
  - **kind**: `new`, `update`, or `fix-description`
  - **status**: `drafting` → `open` → `accepted` or `rejected`, or `failed`

**Off-topic evidence (excluded)**
: A nugget the drafter left out of a skill because it's only adjacent to the skill's topic. It's re-filed in a better skill (or a new latent one), never routed back to that skill, and no longer counts toward it. `lbg proposal show` lists it with the reason.

**Stale proposal**
: One whose target files changed on disk since it was drafted. `accept` refuses it unless `--force`; `revise` rebases it onto the current files.

**Accept / reject / revise / edit**
: How you review a proposal:
  - **accept**: write its files into the skills dir or repo, then sync. You commit them yourself.
  - **reject**: drop it, with a reason.
  - **revise**: change it with pi, as a chat or one-shot feedback.
  - **edit**: change it in your editor.

## Running

**Run**
: One `lbg run` pass, which the hourly systemd timer starts: **sync → extract → insert → score → draft**, then the prompt file and the run log. With nothing new it makes no model calls.

**Stage**
: One step of a run. Each has its own budget (`extract.maxCallsPerRun`, `insert.maxCallsPerRun`, `render.maxPerRun`); work over budget waits for the next run. A failing stage doesn't stop the others.

**Run log**
: One row per run in the state db, with calls and cost per stage (`lbg status`).

**Prompt file**
: `~/.local/state/laobaigan/prompt`: the number of proposals waiting for review, read by your shell prompt (`🍶 N`).

**State db**
: `~/.local/state/laobaigan/state.db` (SQLite): sessions seen, fingerprints, nuggets, the tree, proposals, runs.

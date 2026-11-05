# Development

Working on lbg itself. For how it works inside, see [architecture.md](architecture.md); for the terms, the [glossary](glossary.md).

## Setup

Requires Node ≥ 24. In a checkout, lbg runs its `.ts` sources directly (native type stripping), so there's no build step while developing.

```bash
npm install
npm run check          # tsc --noEmit + vitest
```

Put the checkout's `lbg` on your PATH:

```bash
scripts/install-cli.sh             # npm link into ~/.local: ~/.local/bin/lbg -> this checkout
scripts/install-cli.sh uninstall
```

This runs `npm link` with the prefix set to `~/.local` for that one command; your npm config is unchanged. `lbg` runs `bin/lbg.js`, which runs `src/cli.ts` when the sources are there, so edits take effect immediately. The published package ships only `dist/`, and the same launcher runs that instead.

- **Why `~/.local`:** unlike mise's per-version Node prefix, it survives Node upgrades.
- **Other prefix:** set `LBG_PREFIX=...`.
- **Requirement:** `node` ≥ 24 on `PATH`.
- **Plain `npm link`** also works, but puts `lbg` in your global npm prefix (with mise, the current Node version's directory, which a Node upgrade replaces).

`scripts/install-service.sh` (or `lbg service install` run through the linked `lbg`) makes the hourly timer run through the same command. So the timer runs the checkout's code, and a broken edit can break the hourly run.

## Debugging commands

These need no service and are safe to run anytime. `node src/cli.ts` is the same as `lbg`.

```bash
lbg sessions --since 7d                          # sessions across agents
lbg sessions --agent pi,claude --settle 30m --json
lbg show claude:27b8 --user-only                 # one normalized transcript (id prefix ok)

lbg scan                                         # what extract would do: no model calls, no writes
lbg scan --session pi:01a19be3 --fresh --excerpt # the exact text the model would see
lbg extract --session pi:01a19be3 --dry-run --fresh   # prompt tuning on one session (calls the model, persists nothing)

lbg nuggets                                      # stored nuggets
lbg tree [--status candidate] / lbg tree show <id>
lbg tree insert --all --dry-run                  # re-route everything on a temporary copy of the db
lbg run --stages sync,extract                    # run only some stages
lbg status                                       # db counts and recent runs
```

State lives in `~/.local/state/laobaigan/state.db`. Back it up before experiments; deleting it re-runs the backfill from scratch. To try something against a copy:

```bash
T=$(mktemp -d); sqlite3 ~/.local/state/laobaigan/state.db "VACUUM INTO '$T/state.db'"
LBG_STATE_DIR=$T lbg ...
```

Environment overrides:
- `LBG_CONFIG`: the config file
- `LBG_STATE_DIR`: the state dir
- `LBG_SKILLS_DIR`: the skills dir
- `LBG_CLAUDE_PROJECTS`, `LBG_PI_SESSIONS`, `LBG_OPENCODE_DB`: where each agent's sessions are read from

## Tests

`npm test` runs vitest. Tests never call a real model:
- Pipeline stages take a `PiRunner`; tests pass scripted runners.
- End-to-end drafting tests run real pi sessions on pi's faux provider (`test/helpers/faux.ts`).
- File system effects use temp dirs; the editor and the interactive pi chat use injectable launchers.

## Conventions

- **TypeScript, erasable syntax only** (`erasableSyntaxOnly`): no enums, namespaces or constructor parameter properties, so Node can strip the types.
- **Imports:** relative imports use `.ts` extensions; `tsconfig.build.json` rewrites them to `.js` in `dist/`.
- **Database changes** are new numbered migrations in `src/state/db.ts`, never edits to old ones. Back up the real db before running a migration on it.
- **Model calls** go through `PiRunner` (`src/pi/run-pi.ts`) and return results through a result tool, never parsed free text.

## Task tracking

Work is tracked with [beads](https://github.com/gastownhall/beads) (`bd`) in this repo:

```bash
bd list --type epic          # milestones
bd ready                     # what can be worked on now
bd show <id>                 # details, dependencies, acceptance criteria
```

## Packaging

```bash
npm run build                # dist/ (tsc -p tsconfig.build.json)
npm pack                     # builds, then laobaigan-<version>.tgz
npm install -g ./laobaigan-<version>.tgz
```

`prepack` builds `dist/` and `prepublishOnly` runs the checks. The package contains `bin/`, `dist/` (without source maps), `systemd/`, the README and the license.

`npm install -g` warns about install scripts in some of pi's dependencies (`protobufjs`, `@google/genai`). lbg works without them running.

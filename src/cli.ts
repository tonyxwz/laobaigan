#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { PiConfigRunner, piDefaults } from "./pi/run-pi.ts";
import * as curate from "./pipeline/curate.ts";
import { processSessions, type ProcessOptions, type SessionOutcome } from "./pipeline/process.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ALL_AGENTS, defaultAdapters, scan, type AgentId, type Transcript } from "./sources/index.ts";
import { StateDb } from "./state/db.ts";
import { acquireLock } from "./util/lock.ts";
import { truncate } from "./util/text.ts";
import { subtreeNuggets, Tree, type TreeNode } from "./state/tree.ts";
import { syncTree, type SyncReport } from "./pipeline/sync.ts";
import { detachLatent, insertNuggets } from "./pipeline/insert.ts";
import { scoreTree, type TreeScoreResult } from "./pipeline/treescore.ts";
import { draftCandidates } from "./pipeline/render.ts";
import { exitCode, runPipeline, STAGES, type Stage } from "./pipeline/run.ts";
import { promptFile, promptSnippets, writePromptStatus } from "./notify/prompt.ts";
import { init, renderInit } from "./init.ts";
import { installedExecStart, installedExtraPath, installService, invokedEntry, uninstallService } from "./service.ts";
import { acceptProposal, conflicts, proposalDiff, rejectProposal } from "./pipeline/accept.ts";
import { reviseProposal } from "./pipeline/revise.ts";
import { chatRevise, editProposal, type InteractiveResult } from "./pipeline/interactive.ts";
import { createInterface } from "node:readline/promises";
import { PROPOSAL_STATUSES, Proposals, type ProposalRow, type ProposalStatus } from "./state/proposals.ts";
import { parseDuration, parseSince } from "./util/time.ts";

const USAGE = `lbg (laobaigan 老白干) — distill repeated explanations from agent sessions into skills

Inspect sessions (read-only, no state):
  lbg sessions [--since 7d] [--agent claude,pi,opencode] [--settle 30m] [--json]
  lbg show <agent>:<sessionId> [--user-only] [--json]        <sessionId> may be a unique prefix

Pipeline:
  lbg scan    [--since all] [--agent ...] [--session <agent>:<id> [--excerpt]] [--fresh] [--json]
      What the next extract would do (change detection + prefilter). No model calls, no writes.
      --excerpt  print the exact text the model would see (with --session)
  lbg extract [--since all] [--agent ...] [--session <agent>:<id>] [--dry-run] [--fresh] [--max-calls N] [--json]
      Extract knowledge nuggets with pi and store them.
      --dry-run  call the model but persist nothing
      --fresh    ignore dedup state (prompt tuning; use with --dry-run)
  lbg run     [--stages sync,extract,insert,score,draft] [--max-calls N] [--json]
      One unattended pass (what the systemd timer runs): sync skill files, extract new sessions,
      place nuggets in the tree, score, draft the top candidates into proposals. Budgets:
      extract.maxCallsPerRun, insert.maxCallsPerRun, render.maxPerRun (--max-calls: extract only).
      Exit 0 ok, 2 a stage failed, 3 aborted (repeated model errors), 75 another run holds the lock.
  lbg cluster [--all] [--dry-run] [--max-calls N]       Same as: lbg tree insert

Knowledge tree (one per scope: root → skills → sections → nuggets):
  lbg tree [--status candidate,...] [--json]            The tree (live skills' own sections collapsed)
  lbg tree show <id> [--json]                          One node: path, summary, sections, evidence
  lbg tree sync [--dry-run]                            Mirror skill files (global + known repos) and declared topics
  lbg tree insert [--all] [--dry-run] [--max-calls N]  Sync, route unplaced nuggets into skills/sections (pi), score
      --all      first take the nuggets out of latent skills and insert them again
      --dry-run  run against a temporary copy of the state db, then discard it
  lbg tree score                                       Recompute scores; promote skills that earned a proposal

Curating the tree (hand edits are locked so automation never undoes them; live skill
files change only through proposals; every edit re-scores right away):
  lbg tree merge <into> <from>...                      Fold skills into one (their sections and nuggets move)
  lbg tree split <skill> <section>... [--title T]      Move sections out into a new skill
  lbg tree move <node> <parent>                        Section → other skill, section → root (new skill), skill → section
  lbg tree rename <id> [--title T] [--name skill-name]
  lbg tree unlock <id>                                 Let automation reorganize it again
  lbg nuggets move <nugget> <node>

  lbg nuggets [--json]                                       List stored nuggets

Proposals (lbg never runs git: accept writes the files; commit them yourself if you like):
  lbg draft [<skill-id>...] [--max N]          Draft candidate skills with pi into proposals (default: top candidates)
  lbg proposals [--status open,accepted,...]  List proposals (default: open)
  lbg proposal show <id> [--no-pager]          Summary, evidence, and the diff against the live files
  lbg proposal diff <id> [--no-pager]          Only the diff (git format; pipe it into delta etc.)
      On a terminal both page through $LBG_PAGER, else delta if installed, else less -R.
  lbg proposal accept <id> [--force]           Write the files into the skills dir / repo (--force: even if they changed since)
  lbg proposal revise <id>                     Chat with pi about the draft (your pi TUI; writes only the draft's files)
  lbg proposal revise <id> "feedback"          One shot: pi redrafts with your feedback
  lbg proposal edit <id>                       Edit the drafted files in $VISUAL / $EDITOR
  lbg proposal reject <id> [--reason "..."]
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

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      agent: { type: "string" },
      settle: { type: "string" },
      session: { type: "string" },
      json: { type: "boolean", default: false },
      "user-only": { type: "boolean", default: false },
      "no-pager": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      excerpt: { type: "boolean", default: false },
      regroup: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "max-calls": { type: "string" },
      status: { type: "string" },
      max: { type: "string" },
      stages: { type: "string" },
      path: { type: "string" },
      force: { type: "boolean", default: false },
      reason: { type: "string" },
      title: { type: "string" },
      name: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return cmd || values.help ? 0 : 1;
  }

  if (cmd === "cluster") return main(["tree", "insert", ...argv.slice(argv.indexOf("cluster") + 1)]);
  if (cmd === "topics" || cmd === "clusters") {
    process.stderr.write(`\`lbg ${cmd}\` is gone: topics and clusters became the knowledge tree. Use \`lbg tree\` (see lbg --help).\n`);
    return 1;
  }
  const agents = values.agent ? parseAgents(values.agent) : undefined;
  const adapters = defaultAdapters();
  const out = (s: string) => process.stdout.write(s);
  const json = (v: unknown) => out(`${JSON.stringify(v, null, 2)}\n`);

  switch (cmd) {
    case "sessions": {
      const found = await scan(adapters, {
        since: parseSince(values.since ?? "7d"),
        settleMs: parseDuration(values.settle ?? "0m"),
        ...(agents ? { agents } : {}),
      });
      const rows = [];
      for (const { ref, adapter } of found) {
        try {
          rows.push(summarize(await adapter.load(ref)));
        } catch (err) {
          process.stderr.write(`warn: failed to load ${ref.agent}:${ref.sessionId}: ${String(err)}\n`);
        }
      }
      rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      if (values.json) return json(rows), 0;
      for (const r of rows) {
        out(
          `${r.updatedAt.slice(0, 16).replace("T", " ")}  ${r.agent.padEnd(8)} ${r.sessionId.slice(0, 12).padEnd(12)}  ` +
            `user=${String(r.userTurns).padStart(3)} turns=${String(r.turns).padStart(4)}  ${r.cwd}\n` +
            `    ${r.title ?? r.firstPrompt}\n`,
        );
      }
      out(`\n${rows.length} session(s)\n`);
      return 0;
    }

    case "show": {
      const target = parseSessionTarget(rest[0]);
      const found = (await scan(adapters, { agents: [target.agent] })).filter(({ ref }) =>
        ref.sessionId.startsWith(target.idPrefix),
      );
      if (found.length !== 1) throw new Error(`${found.length} sessions match ${rest[0]}`);
      const { ref, adapter } = found[0]!;
      const t = await adapter.load(ref);
      if (values["user-only"]) t.turns = t.turns.filter((x) => x.role === "user");
      out(values.json ? `${JSON.stringify(t, null, 2)}\n` : renderTranscript(t));
      return 0;
    }

    case "scan":
    case "extract": {
      const cfg = loadConfig();
      const db = new StateDb(join(cfg.stateDir, "state.db"));
      try {
        const opts: ProcessOptions = {
          plan: cmd === "scan",
          dryRun: values["dry-run"],
          fresh: values.fresh,
          ...(values.since && values.since !== "all" ? { since: parseSince(values.since) } : {}),
          ...(agents ? { agents } : {}),
          ...(values.session ? { only: parseSessionTarget(values.session) } : {}),
          ...(values["max-calls"] ? { maxCalls: Number(values["max-calls"]) } : {}),
          ...(values.settle ? { settleMinutes: parseDuration(values.settle) / 60e3 } : {}),
          log: (m) => process.stderr.write(`${m}\n`),
        };
        if (opts.fresh && !opts.dryRun && !opts.plan) throw new Error("--fresh requires --dry-run");
        const res = await processSessions(adapters, db, new PiConfigRunner(), cfg, opts);
        if (values.json) return json(res), 0;
        renderOutcomes(res.outcomes, out);
        if (values.excerpt) {
          for (const o of res.outcomes) {
            o.excerptText?.forEach((c, i) => out(`\n===== excerpt chunk ${i + 1}/${o.excerptText!.length} =====\n${c}`));
          }
        }
        if (cmd === "extract") {
          out(
            `\n${res.calls} model call(s), tokens in=${res.usage.input} out=${res.usage.output} ` +
              `cacheRead=${res.usage.cacheRead}, cost≈$${res.usage.cost.toFixed(4)}` +
              `${opts.dryRun ? "  (dry run: nothing persisted)" : ""}\n`,
          );
        }
        return res.outcomes.some((o) => o.status === "error") ? 2 : 0;
      } finally {
        db.close();
      }
    }

    case "run": {
      const cfg = loadConfig();
      const release = acquireLock(join(cfg.stateDir, "run.lock"));
      if (!release) {
        process.stderr.write("another run is in progress; skipping\n");
        return 75; // EX_TEMPFAIL
      }
      const db = new StateDb(join(cfg.stateDir, "state.db"));
      try {
        const stages = values.stages?.split(",").map((x) => x.trim()) as Stage[] | undefined;
        for (const st of stages ?? []) if (!STAGES.includes(st)) throw new Error(`Unknown stage ${st} (expected ${STAGES.join(", ")})`);
        const r = await runPipeline(
          { adapters, db, runner: new PiConfigRunner(), cfg, log: (m) => out(`  ${m}\n`) },
          { ...(stages ? { stages } : {}), ...(values["max-calls"] ? { maxExtractCalls: Number(values["max-calls"]) } : {}) },
        );
        if (values.json) return json(r), exitCode(r);
        if (r.waiting) out(`${r.waiting} proposal(s) waiting for review — lbg proposals\n`);
        // One line per stage, then one per new proposal: journald-friendly.
        for (const st of r.stages) {
          out(`${st.stage.padEnd(7)} ${st.status === "ok" ? "" : `[${st.status}] `}${st.summary}${st.calls ? ` (${st.calls} call(s), $${st.usage.cost.toFixed(4)})` : ""}\n`);
        }
        for (const p of r.proposals) out(`new proposal #${p.id}: ${p.skill} (${p.files} file(s)) — review with: lbg proposal show ${p.id}\n`);
        out(`run #${r.runId} finished in ${Math.round(r.ms / 1000)}s: ${r.calls} model call(s), cost≈$${r.usage.cost.toFixed(4)}\n`);
        if (r.abortedReason) process.stderr.write(`run aborted: ${r.abortedReason}\n(if this is a credentials error, refresh your model provider's credentials)\n`);
        return exitCode(r);
      } finally {
        db.close();
        release();
      }
    }

    case "tree": {
      const cfg = loadConfig();
      const real = new StateDb(join(cfg.stateDir, "state.db"));
      const tmp = values["dry-run"] ? mkdtempSync(join(tmpdir(), "lbg-dry-")) : undefined;
      const db = tmp ? real.snapshotTo(join(tmp, "state.db")) : real;
      try {
        const tree = new Tree(db);
        const num = (x: string | undefined, what: string) => {
          const n = Number((x ?? "").replace(/^#/, ""));
          if (!Number.isInteger(n) || n <= 0) throw new Error(`Expected ${what} id, got ${JSON.stringify(x)}`);
          return n;
        };
        /** After a hand edit: re-score (no model calls) and show the affected skill. */
        const after = (id: number | undefined, msg: string) => {
          const scored = scoreTree(tree, cfg.score);
          out(`${msg}${tmp ? "  (dry run: nothing persisted)" : ""}\n`);
          renderScore(scored, out);
          const skill = id !== undefined ? tree.path(id).find((p) => p.depth === 1) : undefined;
          const s = skill && tree.subtree(skill.id);
          if (s) renderSkill(s, out);
          return 0;
        };
        switch (rest[0]) {
          case "merge": {
            const into = num(rest[1], "skill");
            const from = rest.slice(2).map((x) => num(x, "skill"));
            if (!from.length) throw new Error("tree merge expects <into> <from>...");
            const r = curate.mergeSkills(tree, into, from);
            return after(into, `merged ${from.map((x) => `#${x}`).join(", ")} into #${into}: ${r.sections} section(s), ${r.nuggets} nugget(s) moved`);
          }
          case "split": {
            const skill = num(rest[1], "skill");
            const sections = rest.slice(2).map((x) => num(x, "section"));
            if (!sections.length) throw new Error("tree split expects <skill> <section>...");
            const created = curate.splitSkill(tree, skill, sections, values.title);
            after(skill, `split ${sections.map((x) => `#${x}`).join(", ")} out of #${skill} into new skill #${created}`);
            renderSkill(tree.subtree(created)!, out);
            return 0;
          }
          case "move": {
            const id = num(rest[1], "node");
            const parent = num(rest[2], "parent");
            curate.moveNode(tree, id, parent);
            return after(id, `moved #${id} under #${parent}`);
          }
          case "rename": {
            const id = num(rest[1], "node");
            if (!values.title && !values.name) throw new Error("tree rename expects --title and/or --name");
            curate.renameNode(tree, id, { ...(values.title ? { title: values.title } : {}), ...(values.name ? { name: values.name } : {}) });
            return after(id, `renamed #${id}`);
          }
          case "unlock": {
            const id = num(rest[1], "node");
            curate.unlockNode(tree, id);
            return after(id, `unlocked #${id}`);
          }
        }
        if (rest[0] === "insert") {
          await syncTree(tree, { skillsDir: cfg.skillsDir, declared: cfg.topics });
          if (values.all) out(`re-inserting ${detachLatent(tree).length} nugget(s) from latent skills\n`);
          const r = await insertNuggets(tree, new PiConfigRunner(), cfg, {
            ...(values["max-calls"] ? { maxCalls: Number(values["max-calls"]) } : {}),
            log: (m) => process.stderr.write(`${m}\n`),
          });
          const scored = scoreTree(tree, cfg.score);
          if (values.json) return json({ ...r, scored, trees: tree.trees() }), 0;
          for (const t of tree.trees()) if (subtreeNuggets(t).length) renderTree(t, out, { onlyWithEvidence: true });
          renderScore(scored, out);
          out(
            `\nplaced ${r.placed} nugget(s)${r.deferred ? `, ${r.deferred} deferred` : ""}; ` +
              `new skills: ${r.skillsCreated.join(", ") || "none"}; new sections: ${r.sectionsCreated.length}; ` +
              `already covered by live text: ${r.covered}; ${r.calls} model call(s), cost≈$${r.usage.cost.toFixed(4)}` +
              `${tmp ? "  (dry run: nothing persisted)" : ""}\n`,
          );
          return 0;
        }
        if (rest[0] === "score") {
          const scored = scoreTree(tree, cfg.score);
          if (values.json) return json(scored), 0;
          renderScore(scored, out);
          out(`${scored.scored} skill(s) scored${tmp ? "  (dry run: nothing persisted)" : ""}\n`);
          return 0;
        }
        if (rest[0] === "sync") {
          const r = await syncTree(tree, {
            skillsDir: cfg.skillsDir,
            declared: cfg.topics,
          });
          if (values.json) return json(r), 0;
          const line = (label: string, x: SyncReport) => {
            const parts = [
              x.created.length && `created ${x.created.length} (${x.created.join(", ")})`,
              x.updated.length && `updated ${x.updated.join(", ")}`,
              x.adopted.length && `adopted ${x.adopted.join(", ")}`,
              x.removed.length && `removed ${x.removed.join(", ")}`,
              x.unchanged && `${x.unchanged} unchanged`,
            ].filter(Boolean);
            out(`${label}: ${parts.join("; ") || "nothing"}\n`);
          };
          line("global skills", r.global);
          for (const [repo, x] of Object.entries(r.repos)) line(`repo ${shortPath(repo)}`, x);
          line("declared topics", r.declared);
          if (tmp) out("(dry run: nothing persisted)\n");
          return 0;
        }
        if (rest[0] === "show") {
          const n = tree.subtree(Number(rest[1]));
          if (!n) throw new Error(`No node ${rest[1]}`);
          if (values.json) return json(n), 0;
          out(renderNodeDetail(n, tree.path(n.id).map((p) => p.title)));
          return 0;
        }
        if (rest[0]) throw new Error(`Unknown tree subcommand: ${rest[0]} (show)`);
        const roots = tree.trees();
        if (values.json) return json(roots), 0;
        const statuses = values.status?.split(",");
        for (const r of roots) {
          if (statuses && !r.children.some((c) => statuses.includes(c.status))) continue;
          renderTree(r, out, statuses ? { statuses } : {});
        }
        const unplaced = tree.unplacedNuggets().length;
        out(`\n${unplaced ? `${unplaced} nugget(s) not placed yet. ` : ""}s=sessions n=nuggets. Details: lbg tree show <id>\n`);
        return 0;
      } finally {
        if (tmp) {
          db.close();
          rmSync(tmp, { recursive: true, force: true });
        }
        real.close();
      }
    }

    case "draft": {
      const cfg = loadConfig();
      const db = new StateDb(join(cfg.stateDir, "state.db"));
      try {
        const tree = new Tree(db);
        await syncTree(tree, { skillsDir: cfg.skillsDir, declared: cfg.topics });
        scoreTree(tree, cfg.score);
        const ids = rest.map((x) => Number(x.replace(/^#/, "")));
        if (ids.some((x) => !Number.isInteger(x))) throw new Error("draft expects skill ids");
        const outcomes = await draftCandidates(tree, new PiConfigRunner(), cfg, {
          ...(ids.length ? { nodeIds: ids } : {}),
          ...(values.max ? { max: Number(values.max) } : {}),
          log: (m) => process.stderr.write(`${m}\n`),
        });
        if (values.json) return json(outcomes), 0;
        if (!outcomes.length) out("no candidates to draft (see: lbg tree --status candidate)\n");
        for (const o of outcomes) {
          const t = tree.getNode(o.nodeId);
          const label = `#${o.nodeId} ${t?.name ?? t?.title ?? ""}`;
          if (o.status === "open") out(`proposal #${o.proposalId} ${label}: ${o.files.length} file(s), cost≈$${o.usage.cost.toFixed(4)} — lbg proposal show ${o.proposalId}\n`);
          else if (o.status === "failed") out(`failed ${label}: ${o.reason}\n`);
          else out(`skipped ${label}: ${o.reason}\n`);
        }
        return outcomes.some((o) => o.status === "failed") ? 2 : 0;
      } finally {
        try {
          writePromptStatus(db, cfg.stateDir); // keep the prompt segment current
        } catch {
          // the prompt is a convenience; never fail the command over it
        }
        db.close();
      }
    }

    case "init": {
      const configured = existsSync(CONFIG_PATH) ? { skillsDir: loadConfig().skillsDir } : {};
      const r = await init({ adapters, piDefaults, ...configured });
      if (values.json) return json(r), 0;
      out(renderInit(r));
      return 0;
    }

    case "service": {
      const sub = rest[0] ?? "status";
      if (sub === "install") {
        const extraPath = values.path ?? installedExtraPath();
        // Run the timer through the same `lbg` I invoked (npm link / npm install -g), if that's how I ran it.
        const r = installService({ cli: invokedEntry(process.argv[1]), ...(extraPath !== undefined ? { extraPath } : {}) });
        out(`installed ${r.servicePath}\n          ${r.timerPath}\nruns: ${r.node} ${r.cli} run (hourly)\n`);
        if (extraPath) out(`extra PATH: ${extraPath}\n`);
        for (const w of r.warnings) out(`\nwarning: ${w}\n`);
        if (r.lingerOff) out(`\nnote: lingering is off, so the timer only runs while you're logged in. Enable with: loginctl enable-linger ${process.env.USER ?? "$USER"}\n`);
        return 0;
      }
      if (sub === "uninstall") {
        const removed = uninstallService();
        out(removed.length ? `removed ${removed.join(", ")}\nstate is kept in ${loadConfig().stateDir}\n` : "not installed\n");
        return 0;
      }
      if (sub === "status") {
        const exec = installedExecStart();
        if (!exec) return out("not installed (lbg service install)\n"), 0;
        out(`runs: ${exec}\n`);
        try {
          out(execFileSync("systemctl", ["--user", "list-timers", "laobaigan.timer", "--no-pager"], { encoding: "utf8" }));
        } catch {
          // systemctl unavailable
        }
        return 0;
      }
      throw new Error(`Unknown service subcommand: ${sub} (install | uninstall | status)`);
    }

    case "prompt": {
      const cfg = loadConfig();
      const db = new StateDb(join(cfg.stateDir, "state.db"));
      try {
        const n = writePromptStatus(db, cfg.stateDir);
        const path = promptFile(cfg.stateDir);
        if (values.json) return json({ waiting: n, path }), 0;
        const { starship, zsh } = promptSnippets(path);
        out(`${n ? `${n} proposal(s) waiting for review` : "nothing waiting"} (${path})\n\n`);
        out(`Show it in your prompt (lbg never edits your dotfiles):\n\n${starship}\n\n${zsh}\n`);
        return 0;
      } finally {
        db.close();
      }
    }

    case "proposals":
    case "proposal": {
      const cfg = loadConfig();
      const db = new StateDb(join(cfg.stateDir, "state.db"));
      try {
        const tree = new Tree(db);
        const props = new Proposals(db);
        const sub = cmd === "proposals" ? "list" : (rest[0] ?? "list");
        const id = Number((cmd === "proposals" ? "" : (rest[1] ?? "")).replace(/^#/, ""));
        if (sub === "list") {
          const statuses = (values.status?.split(",") ?? ["open", "drafting"]) as ProposalStatus[];
          for (const st of statuses) if (!PROPOSAL_STATUSES.includes(st)) throw new Error(`Bad status ${st}`);
          const list = props.list(statuses);
          if (values.json) return json(list), 0;
          for (const p of list) out(renderProposalLine(p, tree));
          out(`\n${list.length} proposal(s). Details: lbg proposal show <id>\n`);
          return 0;
        }
        if (!Number.isInteger(id) || id <= 0) throw new Error(`proposal ${sub} expects <id>`);
        if (sub === "diff") {
          // Just the git-style diff: pipe it into delta, diff-so-fancy, etc.
          const diff = await proposalDiff(props.mustGet(id));
          return (await page(diff, values["no-pager"])), 0;
        }
        if (sub === "show") {
          const p = props.mustGet(id);
          if (values.json) return json(p), 0;
          const buf: string[] = [];
          const out = (s: string) => void buf.push(s);
          out(renderProposalLine(p, tree));
          out(`target: ${p.targetRoot}   writable: ${p.writable.join(", ")}\n`);
          if (p.summary) out(`\n${p.summary}\n`);
          if (p.detail) out(`\n${p.status === "failed" ? "error" : "note"}: ${p.detail}\n`);
          const evidence = db.nuggets().filter((n) => p.nuggetIds.includes(n.id));
          if (evidence.length) {
            out(`\nEvidence (${evidence.length}):\n`);
            for (const n of evidence) {
              const e = n.evidence[0];
              out(`  - ${n.agent}:${n.sessionId.slice(0, 8)}${e?.ts ? ` ${e.ts.slice(0, 10)}` : ""} ${n.title}${e ? `\n      "${truncate(e.quote, 160)}"` : ""}\n`);
            }
          }
          if (p.files.length) {
            const stale = await conflicts(p);
            if (stale.length && p.status === "open") out(`\n⚠ stale: ${stale.map((c) => `${c.path} ${c.reason}`).join("; ")}\n`);
            out(`\n${await proposalDiff(p)}`);
          }
          return (await page(buf.join(""), values["no-pager"])), 0;
        }
        if (sub === "accept") {
          const r = await acceptProposal(tree, cfg, id, { force: values.force });
          scoreTree(tree, cfg.score);
          out(`accepted #${id}: wrote ${r.written.length} file(s)${r.deleted.length ? `, deleted ${r.deleted.length}` : ""}\n`);
          for (const p of r.paths) out(`  ${p}\n`);
          out(`\nlbg doesn't run git. To commit, for example:\n  git add -- <paths above> && git commit -F - <<'MSG'\n${r.commitMessage}\nMSG\n`);
          return 0;
        }
        if (sub === "revise" || sub === "edit") {
          const feedback = rest.slice(2).join(" ").trim();
          // With problems nothing was stored: one-shot verification failed, or I chose to keep the previous draft.
          const report = (r: Pick<InteractiveResult, "problems" | "changed" | "files">) => {
            if (r.problems.length) {
              out(`not stored; the previous draft is kept:\n${r.problems.map((p) => `  - ${p}`).join("\n")}\n`);
              return 2;
            }
            out(r.changed ? `proposal #${id} updated (${r.files.length} file(s)). Review: lbg proposal show ${id}\n` : `no changes to proposal #${id}\n`);
            return 0;
          };
          if (sub === "revise" && feedback) {
            const r = await reviseProposal(tree, new PiConfigRunner(), cfg, id, feedback);
            if (!r.problems.length) out(`${r.summary}\n`);
            out(`cost≈$${r.usage.cost.toFixed(4)}\n`);
            return report(r);
          }
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new Error(sub === "edit" ? "lbg proposal edit needs a terminal" : `interactive revise needs a terminal; for a one-shot revise: lbg proposal revise ${id} "feedback"`);
          }
          const ask = async (q: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return !/^n/i.test((await rl.question(`${q} [Y/n] `)).trim());
            } finally {
              rl.close();
            }
          };
          const log = (m: string) => out(`${m}\n`);
          const r = sub === "edit" ? await editProposal(tree, cfg, id, { ask, log }) : await chatRevise(tree, cfg, id, { ask, log });
          return report(r);
        }
        if (sub === "reject") {
          rejectProposal(tree, id, values.reason);
          out(`rejected #${id}${values.reason ? `: ${values.reason}` : ""}. The skill comes back only with evidence from new sessions.\n`);
          return 0;
        }
        throw new Error(`Unknown proposal subcommand: ${sub} (show | accept | revise | edit | reject)`);
      } finally {
        try {
          writePromptStatus(db, cfg.stateDir); // keep the prompt segment current
        } catch {
          // the prompt is a convenience; never fail the command over it
        }
        db.close();
      }
    }

    case "nuggets": {
      const cfg = loadConfig();
      const db = new StateDb(join(cfg.stateDir, "state.db"));
      try {
        const tree = new Tree(db);
        if (rest[0] === "move") {
          const [n, node] = rest.slice(1, 3).map((x) => Number((x ?? "").replace(/^#/, "")));
          if (!Number.isInteger(n) || !Number.isInteger(node)) throw new Error("nuggets move expects <nugget> <node>");
          curate.moveNugget(tree, n!, node!);
          renderScore(scoreTree(tree, cfg.score), out);
          out(`nugget #${n} → ${tree.path(node!).slice(1).map((p) => `#${p.id} ${p.title}`).join(" › ")}\n`);
          return 0;
        }
        if (rest[0]) throw new Error(`Unknown nuggets subcommand: ${rest[0]} (move)`);
        const rows = db.nuggets();
        if (values.json) return json(rows), 0;
        for (const r of rows) {
          const where = r.nodeId !== undefined ? tree.path(r.nodeId).slice(1).map((p) => p.name ?? p.title).join(" › ") : "(not placed)";
          out(
            `#${r.id} [${r.kind}/${r.scope}] ${r.title}  (${r.agent}:${r.sessionId.slice(0, 12)}, conf ${r.confidence})\n` +
              `    in: ${where}${r.coveredNodeId !== undefined ? "  (already covered by the live text)" : ""}\n${indent(r.knowledge)}\n\n`,
          );
        }
        out(`${rows.length} nugget(s)\n`);
        return 0;
      } finally {
        db.close();
      }
    }

    case "status": {
      const cfg = loadConfig();
      const db = new StateDb(join(cfg.stateDir, "state.db"));
      try {
        out(`state: ${join(cfg.stateDir, "state.db")}\n`);
        out(`${JSON.stringify(db.counts())}\n\nrecent runs:\n`);
        const runs = db.db.prepare("SELECT * FROM run ORDER BY id DESC LIMIT 5").all() as Record<string, unknown>[];
        for (const r of runs) out(`  #${r.id} ${new Date(Number(r.started_at)).toISOString()} ${r.kind} ${r.stats ?? "(unfinished)"}\n`);
        return 0;
      } finally {
        db.close();
      }
    }

    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

function parseAgents(s: string): AgentId[] {
  return s.split(",").map((a) => {
    const id = a.trim() as AgentId;
    if (!ALL_AGENTS.includes(id)) throw new Error(`Unknown agent: ${a} (expected ${ALL_AGENTS.join(", ")})`);
    return id;
  });
}

function parseSessionTarget(s: string | undefined): { agent: AgentId; idPrefix: string } {
  const m = s && /^([a-z]+):(.+)$/.exec(s);
  if (!m) throw new Error("expected <agent>:<sessionId>");
  return { agent: parseAgents(m[1]!)[0]!, idPrefix: m[2]! };
}

function renderOutcomes(outcomes: SessionOutcome[], out: (s: string) => void): void {
  const counts: Record<string, number> = {};
  for (const o of outcomes) {
    counts[o.status] = (counts[o.status] ?? 0) + 1;
    if (o.status === "up-to-date") continue;
    const e = o.excerpt;
    out(
      `${o.status.padEnd(9)} ${o.ref.agent.padEnd(8)} ${o.ref.sessionId.slice(0, 12).padEnd(12)} ` +
        (e
          ? `new=${String(e.signals.newHumanTurns).padStart(3)} score=${String(e.signals.score).padStart(3)} chunks=${e.chunks} ~${e.approxTokens}tok`
          : "") +
        `${o.detail ? `  ${o.detail}` : ""}${e && Object.keys(e.redactions).length ? `  redacted=${JSON.stringify(e.redactions)}` : ""}\n`,
    );
    for (const n of o.nuggets ?? []) {
      out(
        `    • [${n.kind}/${n.scope}${n.repo ? `:${n.repo}` : ""}] ${n.title} (conf ${n.confidence}${
          n.coveredBySkill ? `, covered by ${n.coveredBySkill}` : ""
        }; ${n.evidence.map((x) => x.label).join(",")})\n`,
      );
    }
  }
  out(`\n${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
}

function shortPath(p: string | undefined): string {
  if (!p) return "?";
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p.replace(/^\/local\/home\/[^/]+/, "~");
}

function sessionsOf(n: TreeNode): number {
  return new Set(subtreeNuggets(n).map((m) => `${m.agent}:${m.sessionId}`)).size;
}

/** Page `text` on a terminal ($LBG_PAGER → delta → less -R); plain stdout when piped. */
async function page(text: string, noPager: boolean): Promise<void> {
  const write = () => void process.stdout.write(text);
  if (noPager || !process.stdout.isTTY) return write();
  const { spawn, spawnSync } = await import("node:child_process");
  const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
  const cmd = process.env.LBG_PAGER ?? (has("delta") ? "delta" : has("less") ? "less -R" : "");
  if (!cmd) return write();
  await new Promise<void>((resolve) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => (write(), resolve()));
    child.on("close", () => resolve());
    child.stdin.on("error", () => {}); // pager quit early
    child.stdin.end(text);
  });
}

function renderProposalLine(p: ProposalRow, tree: Tree): string {
  const node = tree.getNode(p.nodeId);
  const where = p.scope === "global" ? "global" : `repo ${shortPath(p.repo)}`;
  const cost = (p.usage as { cost?: number } | undefined)?.cost;
  return (
    `#${String(p.id).padEnd(3)} ${p.status.padEnd(8)} ${p.kind.padEnd(15)} ${p.skillName ?? node?.title ?? `node ${p.nodeId}`}  ` +
    `[${where}] ${p.files.length} file(s), ${p.sessions} session(s)${cost !== undefined ? `, $${cost.toFixed(2)}` : ""}  ${p.createdAt.toISOString().slice(0, 16).replace("T", " ")}\n`
  );
}

function renderScore(r: TreeScoreResult, out: (s: string) => void): void {
  for (const p of r.promoted) out(`candidate: #${p.id} ${p.title} → ${p.kind} (score ${p.score})\n`);
  for (const d of r.demoted) out(`no longer a candidate: #${d.id} ${d.title}\n`);
}

/** One skill line plus its sections (a live skill's own sections only when they hold evidence). */
function renderSkill(s: TreeNode, out: (s: string) => void): void {
  out(
    `  #${String(s.id).padEnd(4)} ${s.origin.padEnd(8)} ${(s.status + (s.proposalKind ? `:${s.proposalKind}` : "")).padEnd(25)} score=${String(s.score).padStart(3)} ` +
      `s=${sessionsOf(s)} n=${subtreeNuggets(s).length}  ${s.name ? `${s.name} — ` : ""}${s.title}${s.locked ? " (locked)" : ""}` +
      `${s.origin === "file" && s.children.length ? `  [${s.children.length} section(s)]` : ""}\n`,
  );
  for (const c of s.children) {
    if (s.origin === "file" && c.origin === "file" && subtreeNuggets(c).length === 0) continue;
    out(`        · #${c.id} ${c.origin === "file" ? "" : `${c.origin} `}${c.title} (n=${subtreeNuggets(c).length})${c.locked ? " (locked)" : ""}\n`);
  }
}

function renderTree(root: TreeNode, out: (s: string) => void, opts: { onlyWithEvidence?: boolean; statuses?: string[] } = {}): void {
  out(`\n${root.scope === "global" ? "Global skills" : `repo ${shortPath(root.repo)}`}  (root #${root.id}, ${root.children.length} skill(s))\n`);
  const skills = [...root.children]
    .filter((s) => !opts.onlyWithEvidence || subtreeNuggets(s).length > 0)
    .filter((s) => !opts.statuses || opts.statuses.includes(s.status))
    .sort((a, b) => sessionsOf(b) - sessionsOf(a) || b.score - a.score || a.id - b.id);
  for (const s of skills) renderSkill(s, out);
}

function renderNodeDetail(n: TreeNode, path: string[]): string {
  const lines = [
    `#${n.id} ${n.title}${n.name ? `  [${n.name}]` : ""}`,
    `path: ${path.join(" › ")}`,
    `depth: ${n.depth}   origin: ${n.origin}   status: ${n.status}   score: ${n.score}${n.locked ? "   (locked)" : ""}${n.summaryDirty ? "   (summary stale)" : ""}`,
  ];
  if (n.description) lines.push(`description: ${n.description}`);
  if (n.sourcePath) lines.push(`source: ${n.sourcePath}`);
  if (n.summary) lines.push("", "## Summary", n.summary);
  const nuggetLines = (ns: TreeNode["nuggets"], pad: string) => {
    for (const m of ns) {
      lines.push("", `${pad}#${m.id} [${m.kind}] ${m.title}  (${m.agent}:${m.sessionId.slice(0, 12)}, conf ${m.confidence}${m.coveredBy ? `, covered by ${m.coveredBy}` : ""})`);
      for (const e of m.evidence) lines.push(`${pad}    ${e.label}${e.ts ? ` ${e.ts.slice(0, 16).replace("T", " ")}` : ""}: "${e.quote}"`);
    }
  };
  if (n.nuggets.length) {
    lines.push("", `## Nuggets (${n.nuggets.length})`);
    nuggetLines(n.nuggets, "");
  }
  for (const c of n.children) {
    lines.push("", `## #${c.id} ${c.title}  (n=${subtreeNuggets(c).length})`);
    if (c.summary) lines.push(c.summary);
    nuggetLines(c.nuggets, "  ");
  }
  return `${lines.join("\n")}\n`;
}

function summarize(t: Transcript) {
  const user = t.turns.filter((x) => x.role === "user" && x.origin !== "command");
  return {
    agent: t.agent,
    sessionId: t.sessionId,
    cwd: t.cwd,
    title: t.title,
    firstPrompt: truncate((user[0]?.text ?? "").replace(/\s+/g, " "), 100),
    startedAt: t.startedAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    userTurns: user.length,
    turns: t.turns.length,
    ...(t.parentSessionId ? { parentSessionId: t.parentSessionId } : {}),
  };
}

function renderTranscript(t: Transcript): string {
  const lines = [
    `# ${t.agent}:${t.sessionId}${t.title ? ` — ${t.title}` : ""}`,
    `cwd: ${t.cwd}`,
    `time: ${t.startedAt.toISOString()} → ${t.updatedAt.toISOString()}`,
    "",
  ];
  for (const turn of t.turns) {
    const ts = `${turn.ts ? turn.ts.toISOString().slice(11, 19) : "--:--:--"}${turn.offBranch ? " off-branch" : ""}`;
    if (turn.role === "user") {
      lines.push(`[${ts}] USER${turn.origin && turn.origin !== "prompt" ? ` (${turn.origin})` : ""}:`, indent(turn.text), "");
    } else if (turn.role === "assistant") {
      lines.push(`[${ts}] ASSISTANT:`);
      if (turn.text) lines.push(indent(turn.text));
      for (const c of turn.toolCalls ?? []) lines.push(`    → ${c.name} ${c.input}`);
      lines.push("");
    } else {
      lines.push(`[${ts}] TOOL ${turn.toolName}${turn.isError ? " (error)" : ""}:`, indent(truncate(turn.text, 400)), "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
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
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);

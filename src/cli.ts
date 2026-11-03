#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { addUsage, BedrockPiRunner } from "./pi/run-pi.ts";
import { clusterNuggets } from "./pipeline/cluster.ts";
import * as curate from "./pipeline/curate.ts";
import { regroup } from "./pipeline/regroup.ts";
import { parseTarget, resolveRepoTargets, scoreTopics, type TopicStats } from "./pipeline/score.ts";
import { TOPIC_STATUSES, type TopicStatus, type TopicWithClusters } from "./state/db.ts";
import { loadSkillsDir } from "./skills/index.ts";
import { processSessions, type ProcessOptions, type SessionOutcome } from "./pipeline/process.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ALL_AGENTS, defaultAdapters, scan, type AgentId, type Transcript } from "./sources/index.ts";
import { StateDb } from "./state/db.ts";
import { acquireLock } from "./util/lock.ts";
import { truncate } from "./util/text.ts";
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
      Extract knowledge nuggets with pi (Bedrock) and store them.
      --dry-run  call the model but persist nothing
      --fresh    ignore dedup state (prompt tuning; use with --dry-run)
  lbg run     [--max-calls N]
      One unattended pipeline pass (what the systemd timer runs): takes a lock, processes
      new/changed sessions, logs a summary. Exit 0 ok, 2 some sessions failed, 3 aborted, 75 locked.
  lbg cluster [--regroup] [--dry-run] [--max-calls N] [--json]
      Group unclustered nuggets into clusters (subtopics) with pi (Bedrock), then score
      topics on the union of their clusters and promote recurring ones with a target.
      --regroup  also re-place existing (unlocked) clusters under declared / umbrella topics
      --dry-run  run against a temporary copy of the state db, then discard it
  lbg topics [--status candidate,open,...] [--json]    Topics (future skills) by score, with their clusters
  lbg topics show <id> [--json]                         Summary, clusters, members, evidence
  lbg topics retarget <id> <target>                     Set the target by hand, e.g.
      global:new:<name> | global:update:<skill> | global:fix-description:<skill> |
      repo:agents-md:<repo> | repo:skill:<repo>:<name>

Curating topics (every edit is locked, so automation never undoes it; re-scores right away):
  lbg topics merge <into> <from>...                     Move all clusters of <from> topics under <into>
  lbg topics split <topic> <cluster>... [--title T]     Move clusters out into a new topic
  lbg topics rename <id> [--title T] [--name skill-name]
  lbg topics unlock <id>                                Let automation reorganize the topic again
  lbg clusters move <cluster> <topic>                   Put a cluster (subtopic) under another topic
  lbg clusters merge <into> <from>...                   Fold clusters into one
  lbg clusters rename <id> <title>
  lbg nuggets move <nugget> <cluster>

  lbg nuggets [--json]                                       List stored nuggets
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
      "dry-run": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      excerpt: { type: "boolean", default: false },
      regroup: { type: "boolean", default: false },
      "max-calls": { type: "string" },
      status: { type: "string" },
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
        const res = await processSessions(adapters, db, new BedrockPiRunner(), cfg, opts);
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
      const started = Date.now();
      try {
        const res = await processSessions(adapters, db, new BedrockPiRunner(), cfg, {
          ...(values["max-calls"] ? { maxCalls: Number(values["max-calls"]) } : {}),
          log: (m) => out(`${m}\n`),
        });
        // Journald-friendly: only report sessions that did something.
        renderOutcomes(res.outcomes.filter((o) => o.status !== "aborted"), out);
        const nuggets = res.outcomes.reduce((a, o) => a + (o.nuggets?.length ?? 0), 0);
        out(
          `run finished in ${Math.round((Date.now() - started) / 1000)}s: ${res.calls} model call(s), ` +
            `${nuggets} new nugget(s), cost≈$${res.usage.cost.toFixed(4)}\n`,
        );
        if (res.abortedReason) {
          process.stderr.write(`run aborted: ${res.abortedReason}\n(if this is a credentials error, refresh your model provider's credentials)\n`);
          return 3;
        }
        return res.outcomes.some((o) => o.status === "error") ? 2 : 0;
      } finally {
        db.close();
        release();
      }
    }

    case "cluster": {
      const cfg = loadConfig();
      const real = new StateDb(join(cfg.stateDir, "state.db"));
      const tmp = values["dry-run"] ? mkdtempSync(join(tmpdir(), "lbg-dry-")) : undefined;
      const db = tmp ? real.snapshotTo(join(tmp, "state.db")) : real;
      try {
        const res = await clusterNuggets(db, new BedrockPiRunner(), cfg, {
          ...(values["max-calls"] ? { maxCalls: Number(values["max-calls"]) } : {}),
          log: (m) => process.stderr.write(`${m}\n`),
        });
        if (values.regroup) {
          const rg = await regroup(db, new BedrockPiRunner(), cfg, { log: (m) => process.stderr.write(`${m}\n`) });
          res.calls += rg.calls;
          res.usage = addUsage(res.usage, rg.usage);
          for (const p of rg.plans) {
            for (const n of p.newTopics) out(`regroup: new topic "${n.title}" ← cluster(s) ${n.clusterIds.join(", ")}\n`);
            for (const m of p.moves) out(`regroup: cluster ${m.clusterId} → topic #${m.topicId}\n`);
          }
        }
        const skills = await loadSkillsDir(join(cfg.skillsRepo.workTree, cfg.skillsRepo.skillsPath), "global");
        const scored = scoreTopics(db, skills, cfg.score);
        const retargeted = await resolveRepoTargets(db);
        if (values.json) return json({ ...res, scored, retargeted, topics: db.topics() }), 0;
        if (tmp) renderTopicList(db.topics(), out);
        for (const p of scored.promoted) out(`promoted topic #${p.id} ${p.title} → ${p.target}\n`);
        for (const r of retargeted) {
          out(`retargeted topic #${r.id}: ${r.from} → ${r.to}${r.reason ? `  (${r.reason})` : ""}\n`);
          for (const c of r.candidates ?? []) out(`    candidate: ${c}\n`);
        }
        out(
          `${res.calls} model call(s), ${res.created} cluster(s) created, ${res.assigned} nugget(s) assigned, ` +
            `cost≈$${res.usage.cost.toFixed(4)}${tmp ? "  (dry run: nothing persisted)" : "  — see: lbg topics"}\n`,
        );
        return 0;
      } finally {
        if (tmp) {
          db.close();
          rmSync(tmp, { recursive: true, force: true });
        }
        real.close();
      }
    }

    case "clusters":
    case "topics": {
      const cfg = loadConfig();
      const db = new StateDb(join(cfg.stateDir, "state.db"));
      try {
        const [sub, idArg, targetArg] = rest;
        const ids = (xs: string[]) =>
          xs.map((x) => {
            const n = Number(x.replace(/^#/, ""));
            if (!Number.isInteger(n)) throw new Error(`Not an id: ${x}`);
            return n;
          });
        /** After a curation edit: re-score (no model calls) and show the affected topic. */
        const after = async (topicId: number | undefined, msg: string) => {
          const skills = await loadSkillsDir(join(cfg.skillsRepo.workTree, cfg.skillsRepo.skillsPath), "global");
          const scored = scoreTopics(db, skills, cfg.score);
          await resolveRepoTargets(db);
          out(`${msg}\n`);
          for (const p of scored.promoted) out(`promoted topic #${p.id} ${p.title} → ${p.target}\n`);
          const t = topicId !== undefined ? db.getTopic(topicId) : undefined;
          if (t) renderTopicList([t], out);
        };

        if (cmd === "clusters") {
          if (sub === "move") {
            const [c, t] = ids(rest.slice(1, 3));
            curate.moveCluster(db, c!, t!);
            return await after(t, `cluster ${c} → topic #${t}`), 0;
          }
          if (sub === "merge") {
            const [into, ...from] = ids(rest.slice(1));
            if (!from.length) throw new Error("clusters merge expects <into> <from>...");
            curate.mergeClusters(db, into!, from);
            return await after(db.getCluster(into!)?.topicId, `merged cluster(s) ${from.join(", ")} into ${into}`), 0;
          }
          if (sub === "rename") {
            const [c] = ids([idArg ?? ""]);
            const title = rest.slice(2).join(" ");
            if (!title) throw new Error("clusters rename expects <id> <title>");
            curate.renameCluster(db, c!, title);
            return await after(db.getCluster(c!)?.topicId, `cluster ${c} renamed`), 0;
          }
          if (sub) throw new Error(`Unknown clusters subcommand: ${sub} (move | merge | rename)`);
          process.stderr.write("note: to list, use `lbg topics`\n");
        }

        if (sub === "merge") {
          const [into, ...from] = ids(rest.slice(1));
          if (!from.length) throw new Error("topics merge expects <into> <from>...");
          const r = curate.mergeTopics(db, into!, from);
          return await after(into, `merged topic(s) ${from.join(", ")} into #${into}: ${r.moved.length} cluster(s) moved`), 0;
        }
        if (sub === "split") {
          const [t, ...clusters] = ids(rest.slice(1));
          if (!clusters.length) throw new Error("topics split expects <topic> <cluster>...");
          const created = curate.splitTopic(db, t!, clusters, values.title);
          await after(t, `split cluster(s) ${clusters.join(", ")} out of #${t} into new topic #${created}`);
          const n = db.getTopic(created);
          if (n) renderTopicList([n], out);
          return 0;
        }
        if (sub === "rename") {
          const [t] = ids([idArg ?? ""]);
          if (!values.title && !values.name) throw new Error("topics rename expects --title and/or --name");
          curate.renameTopic(db, t!, { ...(values.title ? { title: values.title } : {}), ...(values.name ? { name: values.name } : {}) });
          return await after(t, `topic #${t} renamed`), 0;
        }
        if (sub === "unlock") {
          const [t] = ids([idArg ?? ""]);
          curate.unlockTopic(db, t!);
          return await after(t, `topic #${t} unlocked`), 0;
        }
        if (sub === "show") {
          const t = db.getTopic(Number(idArg));
          if (!t) throw new Error(`No topic ${idArg}`);
          if (values.json) return json(t), 0;
          out(renderTopicDetail(t));
          return 0;
        }
        if (sub === "retarget") {
          const t = db.getTopic(Number(idArg));
          if (!t) throw new Error(`No topic ${idArg}`);
          if (!targetArg) throw new Error("retarget expects <id> <target>");
          const parsed = parseTarget(targetArg); // validates
          if (parsed.kind.startsWith("global") !== (t.scope === "global")) throw new Error(`Target ${targetArg} doesn't match topic scope ${t.scope}`);
          db.updateTopic(t.id, { target: targetArg, targetLocked: true, ...(t.status === "open" ? { status: "candidate" as const } : {}) });
          out(`topic #${t.id} → ${targetArg}${t.status === "open" ? " (promoted to candidate)" : ""}\n`);
          return 0;
        }
        if (sub) throw new Error(`Unknown topics subcommand: ${sub}`);
        const statuses = values.status ? (values.status.split(",") as TopicStatus[]) : undefined;
        for (const st of statuses ?? []) if (!TOPIC_STATUSES.includes(st)) throw new Error(`Bad status ${st}`);
        const list = db.topics(statuses);
        if (values.json) return json(list), 0;
        renderTopicList(list, out);
        return 0;
      } finally {
        db.close();
      }
    }

    case "nuggets": {
      const cfg = loadConfig();
      const db = new StateDb(join(cfg.stateDir, "state.db"));
      try {
        if (rest[0] === "move") {
          const [n, c] = rest.slice(1, 3).map((x) => Number(x.replace(/^#/, "")));
          if (!Number.isInteger(n) || !Number.isInteger(c)) throw new Error("nuggets move expects <nugget> <cluster>");
          curate.moveNugget(db, n!, c!);
          const skills = await loadSkillsDir(join(cfg.skillsRepo.workTree, cfg.skillsRepo.skillsPath), "global");
          scoreTopics(db, skills, cfg.score);
          await resolveRepoTargets(db);
          out(`nugget #${n} → cluster ${c} (topic #${db.getCluster(c!)?.topicId})\n`);
          return 0;
        }
        if (rest[0]) throw new Error(`Unknown nuggets subcommand: ${rest[0]} (move)`);
        const rows = db.db
          .prepare(
            "SELECT id, agent, session_id, kind, scope, repo, title, knowledge, triggers, covered_by, confidence, evidence FROM nugget ORDER BY id",
          )
          .all() as Record<string, unknown>[];
        if (values.json) return json(rows), 0;
        for (const r of rows) {
          out(
            `#${r.id} [${r.kind}/${r.scope}${r.repo ? `:${r.repo}` : ""}] ${r.title}  (${r.agent}:${String(r.session_id).slice(0, 12)}, conf ${r.confidence}${
              r.covered_by ? `, covered by ${r.covered_by}` : ""
            })\n${indent(String(r.knowledge))}\n\n`,
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

function renderTopicList(list: TopicWithClusters[], out: (s: string) => void): void {
  const sorted = [...list].sort((a, b) => b.score - a.score || a.id - b.id);
  for (const t of sorted) {
    const st = t.stats as TopicStats | undefined;
    out(
      `#${String(t.id).padEnd(3)} ${t.status.padEnd(9)} score=${String(t.score).padStart(3)} ` +
        `s=${st?.sessions ?? "?"} a=${st?.agents.length ?? "?"} d=${st?.days ?? "?"} n=${t.members.length}  ` +
        `[${t.scope === "global" ? "global" : `repo ${shortPath(t.repo)}`}] ${t.title}${t.declared ? " (declared)" : ""}${t.locked ? " (locked)" : ""}` +
        `${t.clusters.length === 1 && t.clusters[0]!.title === t.title ? `  [cluster ${t.clusters[0]!.id}]` : ""}\n` +
        (t.target ? `      → ${t.target}${t.targetLocked ? " (set by hand)" : ""}\n` : ""),
    );
    if (t.clusters.length > 1 || (t.clusters[0] && t.clusters[0].title !== t.title)) {
      for (const c of t.clusters) out(`      · cluster ${c.id}: ${c.title} (${c.members.length})\n`);
    }
  }
  out(`\n${list.length} topic(s). s=sessions a=agents d=days n=nuggets. Details: lbg topics show <id>\n`);
}

function renderTopicDetail(t: TopicWithClusters): string {
  const st = t.stats as TopicStats | undefined;
  const lines = [
    `#${t.id} ${t.title}${t.name ? `  [${t.name}]` : ""}${t.declared ? "  (declared)" : ""}${t.locked ? "  (locked)" : ""}`,
    `status: ${t.status}   score: ${t.score}   scope: ${t.scope}${t.repo ? ` (${t.repo})` : ""}`,
    `target: ${t.target ?? "(none yet)"}${t.targetLocked ? "  (set by hand)" : ""}`,
  ];
  if (t.description) lines.push(`description: ${t.description}`);
  if (st) {
    lines.push(
      `seen in ${st.sessions} session(s), ${st.agents.length} agent(s) [${st.agents.join(", ")}], ${st.days} day(s)` +
        `${st.firstSeen ? `, ${st.firstSeen.slice(0, 10)} → ${st.lastSeen!.slice(0, 10)}` : ""}` +
        `${st.corrections ? `, ${st.corrections} correction(s)` : ""}${st.coveredBy.length ? `, covered by: ${st.coveredBy.join(", ")}` : ""}`,
    );
  }
  for (const c of t.clusters) {
    lines.push("", `## Cluster ${c.id}: ${c.title}  (${c.members.length} nugget(s))`, c.summary);
    for (const m of c.members) {
      lines.push(
        "",
        `  #${m.id} [${m.kind}] ${m.title}  (${m.agent}:${m.sessionId.slice(0, 12)}, conf ${m.confidence}${m.coveredBy ? `, covered by ${m.coveredBy}` : ""})`,
      );
      for (const e of m.evidence) lines.push(`      ${e.label}${e.ts ? ` ${e.ts.slice(0, 16).replace("T", " ")}` : ""}: "${e.quote}"`);
    }
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

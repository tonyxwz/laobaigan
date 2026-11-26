import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_PATH, type Config, loadConfig } from "../config.ts";
import { writePromptStatus } from "../notify/prompt.ts";
import { modelRunner } from "../pi/run-claude.ts";
import {
  acceptProposal,
  newSinceDraft,
  privateHitsFor,
} from "../pipeline/accept.ts";
import {
  commitTargetFor,
  commitTemplate,
  renderCommit,
  runCommit,
} from "../pipeline/commit.ts";
import { dropEvidence } from "../pipeline/drop.ts";
import {
  chatRevise,
  editProposal,
  type InteractiveResult,
} from "../pipeline/interactive.ts";
import { privateProblems } from "../pipeline/privacy.ts";
import { proposalDiff, proposalView } from "../pipeline/proposal-view.ts";
import { rejectProposal } from "../pipeline/reject.ts";
import type { Rebased } from "../pipeline/revise.ts";
import { reviseProposal } from "../pipeline/revise.ts";
import { scoreTree } from "../pipeline/treescore.ts";
import { StateDb } from "../state/db.ts";
import { Feedback } from "../state/feedback.ts";
import {
  PROPOSAL_STATUSES,
  type ProposalStatus,
  Proposals,
} from "../state/proposals.ts";
import { assertKind } from "../state/rejections.ts";
import { Tree } from "../state/tree.ts";
import { truncate } from "../util/text.ts";
import type { Context } from "./context.ts";
import { page, renderProposalLine } from "./format.ts";

/** What every `lbg proposal` subcommand works with. */
interface ProposalContext extends Context {
  cfg: Config;
  db: StateDb;
  tree: Tree;
  props: Proposals;
  /** The proposal id from the command line (not checked for `list`). */
  id: number;
  sub: string;
}

/** `lbg proposal list`. */
async function listSub(pc: ProposalContext): Promise<number> {
  const { tree, props, id, values, out, json } = pc;
  const statuses = (values.status?.split(",") ?? [
    "open",
    "drafting",
  ]) as ProposalStatus[];
  for (const st of statuses)
    if (!PROPOSAL_STATUSES.includes(st)) throw new Error(`Bad status ${st}`);
  const list = props.list(statuses);
  if (values.json) return (json(list), 0);
  for (const p of list) out(renderProposalLine(p, tree));
  out(`\n${list.length} proposal(s). Details: lbg proposal show <id>\n`);
  return 0;
}

/** `lbg proposal diff`. */
async function diffSub(pc: ProposalContext): Promise<number> {
  const { props, id, values } = pc;
  // Just the git-style diff: pipe it into delta, diff-so-fancy, etc.
  const diff = await proposalDiff(props.mustGet(id));
  return (await page(diff, values["no-pager"]), 0);
}

/** `lbg proposal show`. */
async function showSub(pc: ProposalContext): Promise<number> {
  const { cfg, db, tree, props, id, values, json } = pc;
  const p = props.mustGet(id);
  if (values.json) return (json(p), 0);
  const buf: string[] = [];
  const out = (s: string) => void buf.push(s);
  out(renderProposalLine(p, tree));
  out(
    `target: ${p.targetRoot}   writes: ${p.primary.join(", ")}${p.writable.length > p.primary.length ? `   (may also change the repo's other agent files and docs)` : ""}\n`,
  );
  if (p.summary) out(`\n${p.summary}\n`);
  if (p.detail)
    out(`\n${p.status === "failed" ? "error" : "note"}: ${p.detail}\n`);
  if (p.excluded.length) {
    out(`\nLeft out as off-topic (${p.excluded.length}):\n`);
    for (const e of p.excluded) {
      const n = db.getNugget(e.nuggetId);
      const now =
        n?.nodeId !== undefined
          ? tree
              .path(n.nodeId)
              .slice(1)
              .map((x) => x.name ?? x.title)
              .join(" › ")
          : "unplaced (the next run files it)";
      out(
        `  - #${e.nuggetId} ${n?.title ?? "?"}  (${e.by}: ${e.reason})\n      now in: ${now}\n`,
      );
    }
  }
  const evidence = db.nuggets().filter((n) => p.nuggetIds.includes(n.id));
  const fresh = p.status === "open" ? newSinceDraft(tree, p) : [];
  if (fresh.length) {
    out(
      `\nNew since this draft (${fresh.length}; not in the files yet — lbg proposal revise ${p.id} to add them):\n`,
    );
    for (const n of fresh) {
      const e = n.evidence[0];
      out(
        `  + ${n.agent}:${n.sessionId.slice(0, 8)}${e?.ts ? ` ${e.ts.slice(0, 10)}` : ""} ${n.title}${e ? `\n      "${truncate(e.quote, 160)}"` : ""}\n`,
      );
    }
  }
  if (evidence.length) {
    out(`\nEvidence (${evidence.length}):\n`);
    for (const n of evidence) {
      const e = n.evidence[0];
      out(
        `  - #${n.id} ${n.agent}:${n.sessionId.slice(0, 8)}${e?.ts ? ` ${e.ts.slice(0, 10)}` : ""} ${n.title}${n.forgottenAt ? `  (forgotten: ${n.forgottenReason ?? ""})` : ""}${e ? `\n      "${truncate(e.quote, 160)}"` : ""}\n`,
      );
    }
  }
  const feedback = new Feedback(db).forNode(p.nodeId);
  if (feedback.length) {
    out(
      `\nYour review feedback on this skill (${feedback.length}; drafting sees it):\n`,
    );
    for (const f of feedback) {
      const where =
        f.proposalId === p.id
          ? "this proposal"
          : `proposal #${f.proposalId} (${f.proposalStatus})`;
      const what =
        f.kind === "reject"
          ? `rejected${f.text ? `: "${truncate(f.text, 160)}"` : " (no reason)"}`
          : f.kind === "chat"
            ? `revise chat, ${(f.turns ?? []).filter((t) => t.role === "user").length} message(s): "${truncate(f.text.replace(/\s+/g, " "), 160)}"`
            : f.kind === "edit"
              ? f.text
              : `revise: "${truncate(f.text, 160)}"`;
      out(
        `  - ${f.createdAt.toISOString().slice(0, 16).replace("T", " ")} ${where}: ${what}\n`,
      );
    }
  }
  if (p.files.length) {
    const view = await proposalView(p);
    const stale = p.status === "open" ? view.files.filter((f) => f.stale) : [];
    if (stale.length) {
      const own = stale.filter((f) => f.against === "draft-base");
      out(
        `\n⚠ stale: ${stale.map((f) => f.path).join(", ")} changed on disk since this draft.\n`,
      );
      if (own.length)
        out(
          `  The diff below is the draft's own change, against the version it was drafted from (not a revert of your newer edits).\n`,
        );
      if (own.length < stale.length)
        out(
          `  (${stale
            .filter((f) => f.against === "current")
            .map((f) => f.path)
            .join(
              ", ",
            )}: drafted before lbg kept originals, so this diff is against the file as it is now and shows your newer edits as removed.)\n`,
        );
      out(
        `  lbg proposal revise ${id} rebases it onto the current files; accept refuses it until then (or use --force).\n`,
      );
    }
    const priv = p.status === "open" ? await privateHitsFor(p, cfg) : [];
    if (priv.length)
      out(
        `\n⚠ private terms: accept will refuse this draft until they are gone (lbg proposal revise ${id} / edit ${id}):\n${privateProblems(
          priv,
        )
          .map((x) => `  - ${x}`)
          .join("\n")}\n`,
      );
    const dropped = p.status === "open" ? props.droppedSinceDraft(p) : [];
    if (dropped.length)
      out(
        `\n⚠ evidence dropped after this draft (${dropped.map((e) => `#${e.nuggetId}`).join(", ")}): the files may still contain it. Run: lbg proposal revise ${id}\n`,
      );
    out(`\n${view.diff}`);
    const disk = stale.filter((f) => f.onDisk);
    if (disk.length)
      out(
        `\n── changed on disk since the draft (not part of the proposal) ──\n${disk.map((f) => f.onDisk).join("")}`,
      );
  }
  return (await page(buf.join(""), values["no-pager"]), 0);
}

/** `lbg proposal accept`. */
async function acceptSub(pc: ProposalContext): Promise<number> {
  const { cfg, tree, props, id, values, out } = pc;
  // --commit: check the command before writing anything.
  const before = props.mustGet(id);
  const template = values.commit
    ? commitTemplate(cfg, before.scope)
    : undefined;
  if (values.commit) {
    if (!template) {
      throw new Error(
        `--commit needs commitCommand${typeof cfg.commitCommand === "object" ? `.${before.scope}` : ""} in ${CONFIG_PATH}, e.g.\n` +
          `  "commitCommand": "git -C \${target_root} add -- \${updated_files} && git -C \${target_root} commit -m \${draft_note} -- \${updated_files}"`,
      );
    }
    renderCommit(template, {
      updatedFiles: [],
      draftNote: "",
      targetRoot: "",
      skill: "",
      proposalId: id,
    }); // validates placeholders
  }
  let r: { paths: string[]; commitMessage: string };
  if (before.status === "accepted" && template) {
    // Accepted earlier without --commit: just commit its files now.
    const t = await commitTargetFor(tree, before, cfg);
    if (t.changedSince.length) {
      out(
        `note: changed since #${id} was accepted (your edits are committed as they are now): ${t.changedSince.join(", ")}\n`,
      );
    }
    out(`#${id} was already accepted; committing its files\n`);
    r = t;
  } else {
    const dropped = props.droppedSinceDraft(before);
    if (dropped.length) {
      out(
        `⚠ evidence was dropped after this draft (${dropped.map((e) => `#${e.nuggetId}`).join(", ")}); the files may still contain it (lbg proposal revise ${id} would take it out)\n`,
      );
    }
    const a = await acceptProposal(tree, cfg, id, {
      force: values.force,
    });
    scoreTree(tree, cfg.score);
    out(
      `accepted #${id}: wrote ${a.written.length} file(s)${a.deleted.length ? `, deleted ${a.deleted.length}` : ""}\n`,
    );
    for (const p of a.paths) out(`  ${p}\n`);
    r = a;
  }
  if (!template) {
    out(
      `\nlbg doesn't run git. To commit, for example:\n  git add -- <paths above> && git commit -F - <<'MSG'\n${r.commitMessage}\nMSG\n`,
    );
    out(`(or set commitCommand in ${CONFIG_PATH} and use --commit)\n`);
    return 0;
  }
  const p = props.mustGet(id);
  const command = renderCommit(template, {
    updatedFiles: r.paths,
    draftNote: r.commitMessage,
    targetRoot: p.targetRoot,
    skill: p.skillName ?? `node-${p.nodeId}`,
    proposalId: id,
  });
  out(`\n$ ${command}\n`);
  const c = runCommit(command, p.targetRoot);
  if (c.status !== 0) {
    process.stderr.write(
      `commit command failed (exit ${c.status}). The proposal is accepted and its files are written; commit them yourself.\n`,
    );
    return 2;
  }
  return 0;
}

/** `lbg proposal revise`. */
async function reviseSub(pc: ProposalContext): Promise<number> {
  const { cfg, tree, id, sub, rest, out } = pc;
  const feedback = rest.slice(2).join(" ").trim();
  // With problems nothing was stored: one-shot verification failed, or I chose to keep the previous draft.
  const report = (
    r: Pick<InteractiveResult, "problems" | "changed" | "files"> & {
      warnings?: string[];
      rebased?: Rebased[];
    },
  ) => {
    if (r.problems.length) {
      out(
        `not stored; the previous draft is kept:\n${r.problems.map((p) => `  - ${p}`).join("\n")}\n`,
      );
      return 2;
    }
    for (const w of r.warnings ?? []) out(`⚠ ${w}\n`);
    for (const b of r.rebased ?? []) {
      out(
        b.how === "merged"
          ? `rebased ${b.path}: the draft's change was merged onto your newer edits\n`
          : `rebased ${b.path}: your newer edits were kept and the draft's change re-applied by hand${b.how === "legacy" ? " (old draft)" : ""}; check it in lbg proposal show ${id}\n`,
      );
    }
    out(
      r.changed
        ? `proposal #${id} updated (${r.files.length} file(s)). Review: lbg proposal show ${id}\n`
        : `no changes to proposal #${id}\n`,
    );
    return 0;
  };
  if (sub === "revise" && feedback) {
    const r = await reviseProposal(tree, modelRunner(cfg), cfg, id, feedback);
    if (!r.problems.length) out(`${r.summary}\n`);
    for (const e of r.excluded)
      out(
        `left out (off-topic): #${e.nuggetId} ${e.title} → ${e.now?.path ?? "unplaced, next run files it"}\n`,
      );
    out(`cost≈$${r.usage.cost.toFixed(4)}\n`);
    return report(r);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      sub === "edit"
        ? "lbg proposal edit needs a terminal"
        : `interactive revise needs a terminal; for a one-shot revise: lbg proposal revise ${id} "feedback"`,
    );
  }
  const ask = async (q: string) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return !/^n/i.test((await rl.question(`${q} [Y/n] `)).trim());
    } finally {
      rl.close();
    }
  };
  const log = (m: string) => out(`${m}\n`);
  const r =
    sub === "edit"
      ? await editProposal(tree, cfg, id, { ask, log })
      : await chatRevise(tree, cfg, id, { ask, log });
  return report(r);
}

/** `lbg proposal drop`. */
async function dropSub(pc: ProposalContext): Promise<number> {
  const { cfg, tree, props, id, rest, values, out } = pc;
  const nuggets = rest.slice(2).map((x) => Number(x.replace(/^#/, "")));
  if (!nuggets.length || nuggets.some((x) => !Number.isInteger(x) || x <= 0))
    throw new Error(
      `proposal drop expects <id> <nugget>... (nugget ids: lbg proposal show ${id})`,
    );
  const to =
    values.to !== undefined ? Number(values.to.replace(/^#/, "")) : undefined;
  if (to !== undefined && (!Number.isInteger(to) || to <= 0))
    throw new Error(`--to expects a node id, got ${values.to}`);
  const r = await dropEvidence(tree, modelRunner(cfg), cfg, id, nuggets, {
    ...(values.reason ? { reason: values.reason } : {}),
    ...(to !== undefined ? { to } : {}),
    revise: values.revise,
    log: (m) => process.stderr.write(`${m}\n`),
  });
  for (const d of r.dropped)
    out(
      `dropped #${d.nuggetId} ${d.title} → ${d.now?.path ?? "unplaced (the next run files it)"}\n`,
    );
  if (r.revised) {
    if (r.revised.problems.length)
      out(
        `revise not stored; the previous draft is kept:\n${r.revised.problems.map((p) => `  - ${p}`).join("\n")}\n`,
      );
    else {
      for (const w of r.revised.warnings) out(`⚠ ${w}\n`);
      out(
        `${r.revised.summary}\nproposal #${id} revised. Review: lbg proposal show ${id}\n`,
      );
    }
  } else {
    out(
      `The draft may still contain their content: lbg proposal revise ${id} (or drop with --revise)\n`,
    );
  }
  if (r.usage.cost) out(`cost≈$${r.usage.cost.toFixed(4)}\n`);
  if (!props.mustGet(id).nuggetIds.length)
    out(
      `No evidence is left on proposal #${id}. If nothing in it is worth keeping: lbg proposal reject ${id}\n`,
    );
  return r.revised?.problems.length ? 2 : 0;
}

/** `lbg proposal reject`. */
async function rejectSub(pc: ProposalContext): Promise<number> {
  const { cfg, tree, id, values, out } = pc;
  const kind = values.kind !== undefined ? assertKind(values.kind) : undefined;
  const to =
    values.to !== undefined ? Number(values.to.replace(/^#/, "")) : undefined;
  if (to !== undefined && !Number.isInteger(to))
    throw new Error(`--to expects a skill id, got ${values.to}`);
  const r = rejectProposal(tree, id, values.reason, {
    ...(kind ? { kind } : {}),
    ...(to !== undefined ? { targetNodeId: to } : {}),
    forget: values.forget,
    expireDays: cfg.rejections.expireDays,
  });
  out(`rejected #${id}${values.reason ? `: ${values.reason}` : ""}.\n`);
  if (r.forgotten)
    out(`${r.forgotten} evidence item(s) forgotten: they no longer count.\n`);
  out(
    r.status === "pending"
      ? `Rejection memory #${r.memoryId} is pending: the next lbg run classifies it. Check with: lbg rejections\n`
      : `Rejection memory #${r.memoryId}: ${r.kind}${kind ? "" : " (no reason given; edit with lbg rejections edit " + r.memoryId + ")"}.\n`,
  );
  return 0;
}

/** `lbg proposal`. */
export async function proposalCommand(ctx: Context): Promise<number> {
  const { cmd, rest, values, out, json } = ctx;
  const cfg = loadConfig();
  const db = new StateDb(join(cfg.stateDir, "state.db"));
  try {
    const tree = new Tree(db);
    const props = new Proposals(db);
    const sub = cmd === "proposals" ? "list" : (rest[0] ?? "list");
    const id = Number(
      (cmd === "proposals" ? "" : (rest[1] ?? "")).replace(/^#/, ""),
    );
    for (const r of props.recoverInterrupted())
      process.stderr.write(
        `proposal #${r}: drafting was interrupted earlier (lbg exited); marked failed\n`,
      );
    const pc: ProposalContext = { ...ctx, cfg, db, tree, props, id, sub };
    if (sub === "list") return await listSub(pc);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error(`proposal ${sub} expects <id>`);
    if (sub === "diff") return await diffSub(pc);
    if (sub === "show") return await showSub(pc);
    if (sub === "accept") return await acceptSub(pc);
    if (sub === "revise" || sub === "edit") return await reviseSub(pc);
    if (sub === "drop") return await dropSub(pc);
    if (sub === "reject") return await rejectSub(pc);
    throw new Error(
      `Unknown proposal subcommand: ${sub} (show | accept | revise | edit | drop | reject)`,
    );
  } finally {
    try {
      writePromptStatus(db, cfg.stateDir); // keep the prompt segment current
    } catch {
      // the prompt is a convenience; never fail the command over it
    }
    db.close();
  }
}

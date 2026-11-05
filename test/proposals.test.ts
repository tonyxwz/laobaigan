import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { scoreTree } from "../src/pipeline/treescore.ts";
import { MIGRATIONS, StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Proposals, type NewProposal } from "../src/state/proposals.ts";
import { Tree } from "../src/state/tree.ts";

const nugget = (sessionId: string): NuggetInsert => ({
  runId: 1,
  agent: "pi",
  sessionId,
  cwd: "/",
  kind: "fact",
  title: sessionId,
  knowledge: "k",
  triggers: [],
  scope: "global",
  confidence: 0.9,
  evidence: [{ label: "U1", quote: "q" }],
});

export function setup() {
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  const root = tree.ensureRoot({ scope: "global" });
  const skill = tree.createNode(root, { title: "Dotfiles", name: "dotfiles-management" });
  const section = tree.createNode(skill, { title: "tmux" });
  const ids = ["a", "b", "c"].map((s) => {
    const id = db.insertNugget(nugget(s));
    tree.attachNugget(id, skill);
    return id;
  });
  scoreTree(tree, DEFAULT_CONFIG.score); // → candidate:new
  const props = new Proposals(db);
  const draft = (over: Partial<NewProposal> = {}): NewProposal => ({
    nodeId: skill,
    kind: "new",
    scope: "global",
    skillName: "dotfiles-management",
    targetRoot: "/home/u/.config/opencode/skills",
    writable: ["dotfiles-management/"],
    nuggetIds: ids,
    sessions: 3,
    ...over,
  });
  return { db, tree, root, skill, section, props, draft, ids };
}

const FILES = [{ path: "dotfiles-management/SKILL.md", baseHash: null, content: "---\nname: dotfiles-management\n---\n" }];

describe("Proposals", () => {
  it("stores drafted files and freezes the node while active", () => {
    const { tree, skill, props, draft, ids, db } = setup();
    const id = props.create(draft());
    expect(props.get(id)).toMatchObject({ nodeId: skill, kind: "new", status: "drafting", files: [], nuggetIds: ids, sessions: 3 });
    expect(tree.getNode(skill)!.status).toBe("proposed");
    expect(db.counts().openProposals).toBe(1);
    scoreTree(tree, DEFAULT_CONFIG.score);
    expect(tree.getNode(skill)!.status).toBe("proposed");

    props.markOpen(id, FILES, "New dotfiles skill.", { cost: 0.12 });
    expect(props.get(id)).toMatchObject({ status: "open", files: FILES, summary: "New dotfiles skill.", usage: { cost: 0.12 } });
    // an open draft can be replaced (revise / edit)
    props.markOpen(id, [{ ...FILES[0]!, content: "v2" }], "Shorter.");
    expect(props.get(id)!.files[0]!.content).toBe("v2");
    expect(props.active(skill)!.id).toBe(id);
  });

  it("one active proposal per node, only for skills", () => {
    const { props, draft, section } = setup();
    props.create(draft());
    expect(() => props.create(draft())).toThrow(/already has drafting proposal #/);
    expect(() => props.create(draft({ nodeId: section }))).toThrow(/depth 1/);
    expect(() => props.create(draft({ nodeId: 999 }))).toThrow(/No node/);
  });

  it("failed → node is a candidate again; accepted → open; rejected → waits for new sessions", () => {
    const { db, tree, skill, props, draft } = setup();
    const a = props.create(draft());
    props.markFailed(a, "model never called report_draft", { cost: 0.03 });
    expect(props.get(a)).toMatchObject({ status: "failed", detail: "model never called report_draft" });
    expect(props.get(a)!.closedAt).toBeInstanceOf(Date);
    expect(tree.getNode(skill)!.status).toBe("candidate");

    const b = props.create(draft());
    expect(() => props.markAccepted(b)).toThrow(/is drafting; can't mark it accepted/);
    props.markOpen(b, FILES, "s");
    props.markRejected(b, "too broad");
    expect(tree.getNode(skill)).toMatchObject({ status: "rejected", rejectedSessions: 3 });
    expect(() => props.markAccepted(b)).toThrow(/is rejected/);
    scoreTree(tree, DEFAULT_CONFIG.score);
    expect(tree.getNode(skill)!.status).toBe("rejected");
    for (const s of ["d", "e"]) tree.attachNugget(db.insertNugget(nugget(s)), skill);
    scoreTree(tree, DEFAULT_CONFIG.score);
    expect(tree.getNode(skill)!.status).toBe("candidate");

    const c = props.create(draft());
    props.markOpen(c, FILES, "s");
    props.markAccepted(c);
    expect(tree.getNode(skill)!.status).toBe("open");
    expect(props.list(["accepted"]).map((p) => p.id)).toEqual([c]);
    expect(props.forNode(skill)).toHaveLength(3);
  });

  it("migrations 10-11 apply on a v9 database", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lbg-prop-")), "state.db");
    const raw = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 9)) raw.exec(m);
    raw.exec("PRAGMA user_version = 9");
    raw.close();
    const db = new StateDb(path);
    expect(Number((db.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(MIGRATIONS.length);
    expect(new Proposals(db).list()).toEqual([]);
  });
});

describe("the process working on a proposal", () => {
  /** A pid that isn't running. */
  const DEAD = 2_147_483_000;

  it("a draft is left alone while its process is alive, however long it takes; recovered once it's gone", () => {
    const { tree, skill, props, draft, db } = setup();
    const id = props.create(draft());
    expect(props.get(id)!.workerPid).toBe(process.pid);
    expect(props.recoverInterrupted(3600e3, Date.now() + 10 * 3600e3)).toEqual([]); // alive: no timeout

    db.db.prepare("UPDATE proposal SET worker_pid = ? WHERE id = ?").run(DEAD, id);
    expect(props.recoverInterrupted()).toEqual([id]);
    expect(props.get(id)).toMatchObject({ status: "failed", detail: "interrupted: lbg exited while drafting" });
    expect(props.get(id)!.workerPid).toBeUndefined();
    expect(tree.getNode(skill)!.status).toBe("candidate");
  });

  it("finishing a draft releases it; drafts from before workers were recorded use the 1h rule", () => {
    const { props, draft, db } = setup();
    const id = props.create(draft());
    props.markOpen(id, FILES, "s");
    expect(props.get(id)!.workerPid).toBeUndefined();

    props.markRejected(id);
    const legacy = props.create(draft());
    db.db.prepare("UPDATE proposal SET worker_pid = NULL WHERE id = ?").run(legacy);
    expect(props.recoverInterrupted(3600e3, Date.now() + 60_000)).toEqual([]);
    expect(props.recoverInterrupted(3600e3, Date.now() + 2 * 3600e3)).toEqual([legacy]);
  });

  it("while another live lbg revises a proposal, it can't be accepted, rejected, or revised; a dead holder is released", () => {
    const { props, draft, db } = setup();
    const id = props.create(draft());
    props.markOpen(id, FILES, "s");
    db.db.prepare("UPDATE proposal SET worker_pid = ? WHERE id = ?").run(process.ppid, id); // another live process

    expect(() => props.markAccepted(id)).toThrow(/being revised or edited by another lbg \(pid \d+\)/);
    expect(() => props.markRejected(id)).toThrow(/another lbg/);
    expect(() => props.claim(id)).toThrow(/another lbg/);
    expect(props.recoverInterrupted()).toEqual([]); // alive: untouched
    expect(props.get(id)!.workerPid).toBe(process.ppid);

    db.db.prepare("UPDATE proposal SET worker_pid = ? WHERE id = ?").run(DEAD, id); // that process died mid-chat
    expect(props.recoverInterrupted()).toEqual([]); // an open proposal isn't failed, just released
    expect(props.get(id)).toMatchObject({ status: "open" });
    expect(props.get(id)!.workerPid).toBeUndefined();
    props.claim(id);
    props.release(id);
    props.markAccepted(id);
  });
});

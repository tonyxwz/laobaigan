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

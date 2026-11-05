import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeSkills } from "../src/pipeline/curate.ts";
import { syncTree } from "../src/pipeline/sync.ts";
import { StateDb, type NuggetInsert } from "../src/state/db.ts";
import { Proposals } from "../src/state/proposals.ts";
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

const md = (name: string, body: string) => `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\n# ${name}\n\n${body}`;

async function setup() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "lbg-fk-")));
  const write = async (name: string, body: string) => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), md(name, body));
  };
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  const sync = () => syncTree(tree, { skillsDir: dir, declared: [] });
  const live = (name: string) => tree.trees({ scope: "global" })[0]!.children.find((c) => c.name === name)!;
  return { dir, write, db, tree, sync, live };
}

/** No row anywhere points at a missing node. */
function fkClean(db: StateDb) {
  expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("deleting nodes never breaks references", () => {
  it("a removed section that 'covered' a nugget: the nugget and its covered mark move to the skill", async () => {
    const { write, db, tree, sync, live } = await setup();
    await write("gradle", "intro\n\n## Build\nbuild text\n\n## Test\ntest text");
    await sync();
    const test = live("gradle").children.find((c) => c.title === "Test")!;
    const n = db.insertNugget(nugget("a"));
    tree.attachNugget(n, test.id);
    tree.setCovered(n, test.id);

    await write("gradle", "intro\n\n## Build\nbuild text"); // e.g. an accepted update dropped the section
    await sync();
    expect(db.getNugget(n)).toMatchObject({ nodeId: live("gradle").id, coveredNodeId: live("gradle").id });
    fkClean(db);
  });

  it("a removed file skill with proposal history (and no evidence) is kept as a latent node", async () => {
    const { dir, write, db, tree, sync, live } = await setup();
    await write("tmux", "x");
    await sync();
    const id = live("tmux").id;
    tree.updateNode(id, { status: "candidate", proposalKind: "update" });
    const props = new Proposals(db);
    const p = props.create({ nodeId: id, kind: "update", scope: "global", targetRoot: dir, writable: ["tmux/"], nuggetIds: [], sessions: 2 });
    props.markFailed(p, "x");

    await rm(join(dir, "tmux"), { recursive: true });
    await sync();
    expect(tree.getNode(id)).toMatchObject({ origin: "latent" });
    expect(props.get(p)!.nodeId).toBe(id);
    fkClean(db);
  });

  it("pruning empty latent nodes skips ones with proposals and clears covered marks", async () => {
    const { db, tree } = await setup();
    const root = tree.ensureRoot({ scope: "global" });
    const withHistory = tree.createNode(root, { title: "had a failed proposal" });
    const props = new Proposals(db);
    const p = props.create({ nodeId: withHistory, kind: "new", scope: "global", targetRoot: "/x", writable: ["a/"], nuggetIds: [], sessions: 3 });
    props.markFailed(p, "x");
    const coveredBy = tree.createNode(root, { title: "empty, but covered something" });
    const elsewhere = tree.createNode(root, { title: "holds the nugget" });
    const n = db.insertNugget(nugget("b"));
    tree.attachNugget(n, elsewhere);
    tree.setCovered(n, coveredBy);

    tree.pruneEmpty();
    expect(tree.getNode(withHistory)).toBeDefined();
    expect(tree.getNode(coveredBy)).toBeUndefined();
    expect(db.getNugget(n)!.coveredNodeId).toBeUndefined();
    fkClean(db);
  });

  it("merging skills re-points covered marks and keeps skills with proposal history", async () => {
    const { db, tree } = await setup();
    const root = tree.ensureRoot({ scope: "global" });
    const into = tree.createNode(root, { title: "into" });
    const a = tree.createNode(root, { title: "a" });
    const b = tree.createNode(root, { title: "b" });
    const n = db.insertNugget(nugget("c"));
    tree.attachNugget(n, a);
    tree.setCovered(n, a);
    const props = new Proposals(db);
    props.markRejected(props.create({ nodeId: b, kind: "new", scope: "global", targetRoot: "/x", writable: ["b/"], nuggetIds: [], sessions: 3 }), "no");
    tree.updateNode(b, { status: "open" });

    mergeSkills(tree, into, [a, b]);
    expect(db.getNugget(n)).toMatchObject({ nodeId: into, coveredNodeId: into });
    expect(tree.getNode(a)).toBeUndefined();
    fkClean(db);
  });
});

import { DEFAULT_CONFIG } from "../../src/config.ts";
import { scoreTree } from "../../src/pipeline/treescore.ts";
import { type NuggetInsert, StateDb } from "../../src/state/db.ts";
import { type NewProposal, Proposals } from "../../src/state/proposals.ts";
import { Tree } from "../../src/state/tree.ts";

export const nugget = (sessionId: string): NuggetInsert => ({
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

export function proposalSetup() {
  const db = new StateDb(":memory:");
  const tree = new Tree(db);
  const root = tree.ensureRoot({ scope: "global" });
  const skill = tree.createNode(root, {
    title: "Dotfiles",
    name: "dotfiles-management",
  });
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

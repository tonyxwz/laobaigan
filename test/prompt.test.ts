import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promptFile, promptSnippets, writePromptStatus } from "../src/notify/prompt.ts";
import { StateDb } from "../src/state/db.ts";
import { Proposals } from "../src/state/proposals.ts";
import { Tree } from "../src/state/tree.ts";

describe("prompt status", () => {
  it("holds the number of open proposals, empty when none, written atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-prompt-"));
    const db = new StateDb(":memory:");
    const tree = new Tree(db);
    const root = tree.ensureRoot({ scope: "global" });
    const props = new Proposals(db);
    const open = (title: string) => {
      const node = tree.createNode(root, { title });
      const id = props.create({ nodeId: node, kind: "new", scope: "global", targetRoot: dir, writable: [`${title}/`], nuggetIds: [], sessions: 3 });
      props.markOpen(id, [{ path: `${title}/SKILL.md`, baseHash: null, content: "x" }], "s");
      return id;
    };

    expect(writePromptStatus(db, dir)).toBe(0);
    expect(readFileSync(promptFile(dir), "utf8")).toBe("");
    const a = open("a");
    open("b");
    const drafting = props.create({ nodeId: tree.createNode(root, { title: "c" }), kind: "new", scope: "global", targetRoot: dir, writable: ["c/"], nuggetIds: [], sessions: 3 });
    expect(writePromptStatus(db, dir)).toBe(2); // drafting doesn't count yet
    expect(readFileSync(promptFile(dir), "utf8")).toBe("2");
    props.markRejected(a);
    props.markFailed(drafting, "x");
    expect(writePromptStatus(db, dir)).toBe(1);
    expect(readFileSync(promptFile(dir), "utf8")).toBe("1");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("snippets point at the file, with ~ for the home dir", () => {
    const home = process.env.HOME!;
    const { starship, zsh } = promptSnippets(join(home, ".local/state/laobaigan/prompt"));
    expect(starship).toContain('when = "test -s ~/.local/state/laobaigan/prompt"');
    expect(starship).toContain("[custom.lbg]");
    expect(zsh).toContain("local f=~/.local/state/laobaigan/prompt;");
  });
});

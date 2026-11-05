import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { commitTemplate, expandTilde, renderCommit, runCommit, shQuote } from "../src/pipeline/commit.ts";

const vars = {
  updatedFiles: ["/h/.config/opencode/skills/my skill/SKILL.md", "/h/.config/opencode/skills/it's/x.md"],
  draftNote: "skills: add tmux\n\nUse `$TMUX` and \"quotes\"; ~ stays literal.",
  targetRoot: "/h/.config/opencode/skills",
  skill: "tmux",
  proposalId: 7,
};

describe("commit command", () => {
  it("expands ~ in the template at word starts and after = or :, never inside values", () => {
    expect(expandTilde("git --git-dir=~/.cfg --work-tree=~ add ~/x PATH=a:~/b", "/h")).toBe("git --git-dir=/h/.cfg --work-tree=/h add /h/x PATH=a:/h/b");
    expect(expandTilde("echo a~b ~user", "/h")).toBe("echo a~b ~user");
    expect(renderCommit("echo ${draft_note}", vars, "/h")).toContain("~ stays literal");
  });

  it("quotes every value so the shell sees them verbatim", () => {
    const cmd = renderCommit("printf '%s\\n' ${updated_files} ${draft_note} ${target_root} ${skill} ${proposal_id}", vars, "/h");
    const r = runCommit(cmd, tmpdir(), { stdio: "pipe" });
    expect(r.status).toBe(0);
    expect(r.output).toBe([...vars.updatedFiles, vars.draftNote, vars.targetRoot, "tmux", "7", ""].join("\n"));
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  it("refuses unknown placeholders", () => {
    expect(() => renderCommit("git commit -m ${message}", vars)).toThrow(/unknown placeholder\(s\) \$\{message\}/);
  });

  it("picks the command per scope; validates the config", async () => {
    expect(commitTemplate({ commitCommand: "c" }, "repo")).toBe("c");
    expect(commitTemplate({ commitCommand: { global: "g" } }, "global")).toBe("g");
    expect(commitTemplate({ commitCommand: { global: "g" } }, "repo")).toBeUndefined();
    expect(commitTemplate({}, "global")).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "lbg-cfg-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ commitCommand: { global: "g", repo: "r" } }));
    expect(loadConfig(path).commitCommand).toEqual({ global: "g", repo: "r" });
    await writeFile(path, JSON.stringify({ commitCommand: { other: "x" } }));
    expect(() => loadConfig(path)).toThrow(/commitCommand must be/);
  });

  it("works end to end with a git commit (a bare dotfiles-style repo)", async () => {
    const home = realpathSync(await mkdtemp(join(tmpdir(), "lbg-home-")));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", "--bare", join(home, ".cfg")], { env });
    execFileSync("mkdir", ["-p", join(home, "skills", "tmux")]);
    await writeFile(join(home, "skills", "tmux", "SKILL.md"), "x\n");
    const template = "git --git-dir=~/.cfg --work-tree=~ add ${updated_files} && git --git-dir=~/.cfg --work-tree=~ commit -q -m ${draft_note}";
    const cmd = renderCommit(template, { ...vars, updatedFiles: [join(home, "skills", "tmux", "SKILL.md")] }, home);
    const prev = { ...process.env };
    Object.assign(process.env, env);
    try {
      expect(runCommit(cmd, home, { stdio: "pipe" }).status).toBe(0);
    } finally {
      process.env = prev;
    }
    const log = execFileSync("git", [`--git-dir=${join(home, ".cfg")}`, "log", "--format=%B", "-1"], { encoding: "utf8" });
    expect(log.trim()).toBe(vars.draftNote);
  });
});

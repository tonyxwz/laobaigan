import { describe, expect, it } from "vitest";
import { renderInput, truncate } from "../src/util/text.ts";
import { parseDuration, parseSince } from "../src/util/time.ts";

describe("time", () => {
  it("parses durations", () => {
    expect(parseDuration("30m")).toBe(30 * 60e3);
    expect(parseDuration("7d")).toBe(7 * 86400e3);
    expect(parseDuration("15")).toBe(15 * 60e3);
    expect(() => parseDuration("abc")).toThrow();
  });
  it("parses since as duration or date", () => {
    const now = new Date("2026-01-08T00:00:00Z");
    expect(parseSince("7d", now).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(parseSince("2026-01-02", now).toISOString()).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });
});

describe("text", () => {
  it("truncates with marker", () => {
    expect(truncate("abcdef", 3)).toBe("abc… [+3 chars]");
    expect(truncate("abc", 3)).toBe("abc");
  });
  it("renders inputs on one line", () => {
    expect(renderInput({ a: "x\n  y" }, 100)).toBe('{"a":"x\\n y"}');
    expect(renderInput("a\n b", 100)).toBe("a b");
  });
});

describe("home paths", () => {
  it("expands and shortens paths under the home directory", async () => {
    const { expandHome, tildify } = await import("../src/util/path.ts");
    expect(expandHome("~/a/b", "/h")).toBe("/h/a/b");
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("/x/~", "/h")).toBe("/x/~");
    expect(tildify("/h/a", "/h")).toBe("~/a");
    expect(tildify("/h", "/h")).toBe("~");
    expect(tildify("/hx/a", "/h")).toBe("/hx/a");
  });

  it("matches the real path of a symlinked home directory", async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, realpathSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { tildify } = await import("../src/util/path.ts");
    const d = realpathSync(mkdtempSync(join(tmpdir(), "lbg-home-")));
    mkdirSync(join(d, "real"));
    symlinkSync(join(d, "real"), join(d, "link"));
    expect(tildify(join(d, "real", "repo"), join(d, "link"))).toBe("~/repo");
    expect(tildify(join(d, "link", "repo"), join(d, "link"))).toBe("~/repo");
  });
});

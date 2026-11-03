import { describe, expect, it } from "vitest";
import { parseDuration, parseSince } from "../src/util/time.ts";
import { renderInput, truncate } from "../src/util/text.ts";

describe("time", () => {
  it("parses durations", () => {
    expect(parseDuration("30m")).toBe(30 * 60e3);
    expect(parseDuration("7d")).toBe(7 * 86400e3);
    expect(parseDuration("15")).toBe(15 * 60e3);
    expect(() => parseDuration("abc")).toThrow();
  });
  it("parses since as duration or date", () => {
    const now = new Date("2026-01-08T00:00:00Z");
    expect(parseSince("7d", now).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseSince("2026-01-02", now).toISOString()).toBe("2026-01-02T00:00:00.000Z");
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

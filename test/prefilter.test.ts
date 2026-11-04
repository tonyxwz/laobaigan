import { describe, expect, it } from "vitest";
import { fingerprintTranscript, fingerprintTurn } from "../src/pipeline/fingerprint.ts";
import { buildExcerpt, isTrivialPrompt } from "../src/pipeline/prefilter.ts";
import { containsSecrets, redact, setExtraPatterns } from "../src/pipeline/redact.ts";
import type { Transcript, Turn } from "../src/sources/types.ts";

// Fake credentials, assembled at runtime so secret scanners don't flag the source.
const FAKE_AKID = "AKIA" + "ABCDEFGHIJKLMNOP";
const FAKE_SECRET = "abcdEFGHijklMNOP" + "qrstUVWXyz0123456789ABCD";

const ts = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));

function transcript(turns: Turn[], id = "s1"): Transcript {
  return { agent: "pi", sessionId: id, location: "", cwd: "/repo", startedAt: ts(0), updatedAt: ts(99), turns };
}

const user = (text: string, m: number, extra: Partial<Turn> = {}): Turn => ({ role: "user", text, ts: ts(m), origin: "prompt", ...extra });
const asst = (text: string, m: number, extra: Partial<Turn> = {}): Turn => ({ role: "assistant", text, ts: ts(m), ...extra });

describe("redact", () => {
  it("redacts common secret shapes", () => {
    const input = [
      `key ${FAKE_AKID} here`,
      `aws_secret_access_key = ${FAKE_SECRET}`,
      'apiKey: "301a4857-aaaa-bbbb-cccc"',
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "token=ghp_abcdefghijklmnopqrstuvwxyz0123",
      "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
    ].join("\n");
    const { text, hits } = redact(input);
    expect(text).not.toMatch(/AKIA[A]BCDEFGHIJKLMNOP|abcdEFGHijkl|301a4857|abcdefghijklmnopqrstuvwxyz123456|ghp_|eyJhbGci/);
    expect(text).toContain("aws_secret_access_key = [REDACTED]");
    expect(Object.keys(hits).length).toBeGreaterThanOrEqual(5);
  });

  it("redacts Cookie headers and configured extra patterns", () => {
    expect(redact("curl -H 'Cookie: sso_session=abc123def; other=1' https://x").text).toBe("curl -H 'Cookie: [REDACTED]");
    setExtraPatterns([{ pattern: "(corp_sso=)[^\\s;]+", replace: "$1[REDACTED]", name: "corp-sso" }]);
    try {
      const r = redact("cookie jar has corp_sso=Zm9vYmFy; path=/");
      expect(r.text).toBe("cookie jar has corp_sso=[REDACTED]; path=/");
      expect(r.hits).toEqual({ "corp-sso": 1 });
    } finally {
      setExtraPatterns([]);
    }
    expect(redact("corp_sso=Zm9vYmFy").text).toBe("corp_sso=Zm9vYmFy");
    expect(() => setExtraPatterns([{ pattern: "(" }])).toThrow(/redact.extraPatterns\[0\]/);
  });

  it("leaves ordinary text alone", () => {
    const s = "Use `make release` in ~/code/foo; account 123456789012 is the dev account.";
    expect(redact(s).text).toBe(s);
    expect(containsSecrets(s)).toBe(false);
  });
});

describe("fingerprint", () => {
  it("is stable across sessions and whitespace, sensitive to time and text", () => {
    const a = fingerprintTurn(user("use  gradle\n", 1), { sessionId: "a", index: 0 });
    expect(fingerprintTurn(user("use gradle", 1), { sessionId: "b", index: 5 })).toBe(a);
    expect(fingerprintTurn(user("use gradle", 2), { sessionId: "a", index: 0 })).not.toBe(a);
    expect(fingerprintTurn(user("use npm", 1), { sessionId: "a", index: 0 })).not.toBe(a);
  });

  it("only fingerprints human turns", () => {
    const t = transcript([user("hi there", 1), asst("hello", 2), { role: "user", text: "[Request interrupted by user]", origin: "interrupt" }]);
    expect([...fingerprintTranscript(t).keys()]).toEqual([0]);
  });
});

describe("prefilter", () => {
  it("detects trivial prompts", () => {
    for (const s of ["hi", "hello how are you doing today?", "OK.", "continue", "lgtm"]) expect(isTrivialPrompt(s)).toBe(true);
    for (const s of ["no, use gh pr checkout", "hi, the build uses make. run it from the package root"])
      expect(isTrivialPrompt(s)).toBe(false);
  });

  it("labels new turns, turns seen ones into context, and computes signals", () => {
    const t = transcript([
      user("build the package", 1),
      asst("running npm run build", 2, { toolCalls: [{ name: "bash", input: "npm run build" }] }),
      { role: "tool", text: "npm: command not found", toolName: "bash", isError: true, ts: ts(3) },
      user("no, don't use npm. Always use `make release` here.", 4),
      asst("Done", 5),
      user("use bb", 6, { offBranch: true }),
    ]);
    const fps = fingerprintTranscript(t);
    const seen = new Set([fps.get(0)!]);
    const ex = buildExcerpt(t, fps, seen);
    expect(ex.skip).toBeUndefined();
    expect([...ex.labels]).toEqual([
      ["U1", 3],
      ["U2", 5],
    ]);
    const text = ex.chunks.join("");
    expect(text).toMatch(/^\[C 2026-01-01 00:01\] USER:/);
    expect(text).toContain("TOOL ERROR (bash): npm: command not found");
    expect(text).toContain("[U2 2026-01-01 00:06 rewound] USER:");
    expect(ex.signals).toMatchObject({ newHumanTurns: 2, corrections: 1, rewinds: 1, afterToolError: 1 });
  });

  it("skips sessions with nothing new or nothing substantive", () => {
    const t = transcript([user("hello how are you doing today?", 1), asst("Fine!", 2)]);
    const fps = fingerprintTranscript(t);
    expect(buildExcerpt(t, fps, new Set()).skip).toBe("only trivial prompts");
    expect(buildExcerpt(t, fps, new Set(fps.values())).skip).toBe("no new human turns");
  });

  it("chunks long sessions under the budget", () => {
    const turns: Turn[] = [];
    for (let i = 0; i < 20; i++) turns.push(user(`explain thing ${i} `.repeat(40), i), asst("ok", i));
    const t = transcript(turns);
    const ex = buildExcerpt(t, fingerprintTranscript(t), new Set(), { chunkTokens: 1000, contextTokens: 100 });
    expect(ex.chunks.length).toBeGreaterThan(1);
    for (const c of ex.chunks) expect(c.length).toBeLessThan(1000 * 4 + 2000);
    expect(ex.labels.size).toBe(20);
  });

  it("redacts the excerpt", () => {
    const t = transcript([user(`my key is ${FAKE_AKID}, use it to deploy the stack`, 1)]);
    const ex = buildExcerpt(t, fingerprintTranscript(t), new Set());
    expect(ex.chunks.join("")).toContain("[REDACTED:aws-access-key]");
    expect(ex.redactions).toEqual({ "aws-access-key": 1 });
  });
});

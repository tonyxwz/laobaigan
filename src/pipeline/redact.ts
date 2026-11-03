/**
 * Deterministic secret redaction, applied to everything before it is sent to a model.
 * Prefers over-redaction: a lost token in a transcript is harmless, a leaked one isn't.
 */

interface Rule {
  name: string;
  re: RegExp;
  /** Replacement; `$1` etc. allowed to keep a non-secret prefix. */
  replace: string;
}

const RULES: Rule[] = [
  {
    name: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "[REDACTED:private-key]",
  },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g, replace: "[REDACTED:aws-access-key]" },
  {
    name: "aws-secret",
    re: /(aws_secret_access_key|aws_session_token|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)(\s*[=:]\s*["']?)[A-Za-z0-9/+=]{20,}/g,
    replace: "$1$2[REDACTED]",
  },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: "[REDACTED:jwt]" },
  { name: "bearer", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, replace: "$1 [REDACTED]" },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, replace: "[REDACTED:github-token]" },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: "[REDACTED:slack-token]" },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replace: "[REDACTED:api-key]" },
  {
    // key = value / "key": "value" assignments with secret-looking names
    name: "assignment",
    re: /((?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|credential|session[_-]?id|cookie)["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"',;}{)]{6,}/gi,
    replace: "$1[REDACTED]",
  },
  { name: "cookie-header", re: /\b((?:Set-)?Cookie:[ \t]*)(?![ \t]*\[REDACTED)[^\r\n]+/gi, replace: "$1[REDACTED]" },
];

export interface RedactResult {
  text: string;
  /** Count of redactions per rule name. */
  hits: Record<string, number>;
}

export function redact(input: string): RedactResult {
  let text = input;
  const hits: Record<string, number> = {};
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args: unknown[]) => {
      hits[rule.name] = (hits[rule.name] ?? 0) + 1;
      // Re-run a non-global copy to honour `$n` references in the replacement.
      return (args[0] as string).replace(new RegExp(rule.re.source, rule.re.flags.replace("g", "")), rule.replace);
    });
  }
  return { text, hits };
}

/** True if any redaction rule would fire. Used to verify generated skill files. */
export function containsSecrets(text: string): boolean {
  return Object.keys(redact(text).hits).length > 0;
}

/** A skill name: lowercase letters, digits and single hyphens, at most 64 characters. */
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;

export function isValidSkillName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length <= MAX_SKILL_NAME &&
    SKILL_NAME.test(name)
  );
}

/** A skill name made from a title: its significant words, hyphenated, at most 40 characters. */
export function skillName(title: string): string {
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "for",
    "to",
    "in",
    "on",
    "with",
    "by",
    "is",
    "are",
  ]);
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !stop.has(w));
  let name = "";
  for (const w of words) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > 40) break;
    name = next;
  }
  return name || "skill";
}

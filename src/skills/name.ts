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

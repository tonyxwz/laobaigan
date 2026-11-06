import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_PATH, DEFAULT_CONFIG } from "../src/config.ts";

describe("test sandbox", () => {
  it("lbg's defaults point away from my real state, config and skills", () => {
    const real = [join(homedir(), ".local", "state", "laobaigan"), join(homedir(), ".config", "laobaigan"), join(homedir(), ".config", "opencode", "skills")];
    for (const p of [DEFAULT_CONFIG.stateDir, CONFIG_PATH, DEFAULT_CONFIG.skillsDir]) {
      for (const r of real) expect(p.startsWith(r)).toBe(false);
    }
  });
});

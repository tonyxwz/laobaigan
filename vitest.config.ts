import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests never touch the real state db, config, prompt file or skills: lbg's defaults
// point into a throwaway directory for the whole run.
const sandbox = mkdtempSync(join(tmpdir(), "lbg-test-"));

export default defineConfig({
  test: {
    env: {
      LBG_STATE_DIR: join(sandbox, "state"),
      LBG_CONFIG: join(sandbox, "config.json"),
      LBG_SKILLS_DIR: join(sandbox, "skills"),
    },
  },
});

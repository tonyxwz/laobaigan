import { existsSync } from "node:fs";
import { CONFIG_PATH, loadConfig } from "../config.ts";
import { init, renderInit } from "../init.ts";
import { piDefaults } from "../pi/run-pi.ts";
import type { Context } from "./context.ts";

/** `lbg init`. */
export async function initCommand(ctx: Context): Promise<number> {
  const { values, adapters, out, json } = ctx;
  const configured = existsSync(CONFIG_PATH)
    ? { skillsDir: loadConfig().skillsDir }
    : {};
  const r = await init({ adapters, piDefaults, ...configured });
  if (values.json) {
    json(r);
    return 0;
  }
  out(renderInit(r));
  return 0;
}

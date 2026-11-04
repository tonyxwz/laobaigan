/**
 * pi extension for `lbg proposal revise <id>` (interactive). lbg starts the pi CLI
 * in the draft's scratch dir with `-e` pointing here and LBG_GUARD set to
 * {"root": "...", "writable": ["..."]}.
 *
 *  - read / ls / find / grep / write / edit are replaced by lbg's guarded versions
 *    (write only the proposal's paths); pi is started with --tools limited to these,
 *    so there is no bash tool for the model.
 *  - The model is whatever pi is configured to use.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardedToolDefinitions, type FileGuard } from "./guard.ts";


export default async function lbgGuard(pi: ExtensionAPI): Promise<void> {
  const raw = process.env.LBG_GUARD;
  if (!raw) throw new Error("lbg guard extension: LBG_GUARD is not set");
  const guard = JSON.parse(raw) as FileGuard;
  for (const def of await guardedToolDefinitions(guard)) pi.registerTool(def as never);

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`lbg: you can write only ${guard.writable.join(", ")}. Exit pi (Ctrl+D) when done; lbg checks and stores the draft.`, "info");
  });
}

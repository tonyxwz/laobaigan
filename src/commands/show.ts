import { scan } from "../sources/index.ts";
import type { Context } from "./context.ts";
import { parseSessionTarget, renderTranscript } from "./format.ts";

/** `lbg show`. */
export async function showCommand(ctx: Context): Promise<number> {
  const { rest, values, adapters, out } = ctx;
  const target = parseSessionTarget(rest[0]);
  const found = (await scan(adapters, { agents: [target.agent] })).filter(
    ({ ref }) => ref.sessionId.startsWith(target.idPrefix),
  );
  if (found.length !== 1)
    throw new Error(`${found.length} sessions match ${rest[0]}`);
  const { ref, adapter } = found[0]!;
  const t = await adapter.load(ref);
  if (values["user-only"]) t.turns = t.turns.filter((x) => x.role === "user");
  out(values.json ? `${JSON.stringify(t, null, 2)}\n` : renderTranscript(t));
  return 0;
}

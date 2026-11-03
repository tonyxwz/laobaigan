import { createFauxCore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkPiRunner } from "../../src/pi/run-pi.ts";

/** A real pi session on pi's faux provider: scripted model responses, no network. */
export async function fauxRunner(steps: FauxResponseStep[]): Promise<SdkPiRunner> {
  const core = createFauxCore({ provider: "lbg-faux", models: [{ id: "m" }] });
  core.setResponses(steps);
  const runtime = await ModelRuntime.create({ authPath: join(await mkdtemp(join(tmpdir(), "lbg-auth-")), "auth.json"), modelsPath: null });
  runtime.registerProvider("lbg-faux", {
    api: core.api as never,
    baseUrl: "http://faux.invalid",
    apiKey: "x",
    streamSimple: core.streamSimple as never,
    models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_000 }],
  });
  const model = runtime.getModel("lbg-faux", "m")!;
  return new SdkPiRunner(async () => ({ runtime, model }));
}

/** Tool results the model saw, by tool name. */
export function toolResults(context: { messages: unknown[] }): { name: string; text: string; isError: boolean }[] {
  return (context.messages as Record<string, unknown>[])
    .filter((m) => m.role === "toolResult")
    .map((m) => ({
      name: String(m.toolName),
      text: ((m.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join(""),
      isError: m.isError === true,
    }));
}

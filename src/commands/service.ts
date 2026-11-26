import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.ts";
import {
  installedExecStart,
  installedExtraPath,
  installService,
  invokedEntry,
  uninstallService,
} from "../service.ts";
import type { Context } from "./context.ts";

/** `lbg service`. */
export async function serviceCommand(ctx: Context): Promise<number> {
  const { rest, values, out } = ctx;
  const sub = rest[0] ?? "status";
  if (sub === "install") {
    const extraPath = values.path ?? installedExtraPath();
    // Run the timer through the same `lbg` I invoked (npm link / npm install -g), if that's how I ran it.
    const r = installService({
      cli: invokedEntry(process.argv[1]),
      ...(extraPath !== undefined ? { extraPath } : {}),
    });
    out(
      `installed ${r.servicePath}\n          ${r.timerPath}\nruns: ${r.node} ${r.cli} run (hourly)\n`,
    );
    if (extraPath) out(`extra PATH: ${extraPath}\n`);
    for (const w of r.warnings) out(`\nwarning: ${w}\n`);
    if (r.lingerOff)
      out(
        `\nnote: lingering is off, so the timer only runs while you're logged in. Enable with: loginctl enable-linger ${process.env.USER ?? "$USER"}\n`,
      );
    return 0;
  }
  if (sub === "uninstall") {
    const removed = uninstallService();
    out(
      removed.length
        ? `removed ${removed.join(", ")}\nstate is kept in ${loadConfig().stateDir}\n`
        : "not installed\n",
    );
    return 0;
  }
  if (sub === "status") {
    const exec = installedExecStart();
    if (!exec) return (out("not installed (lbg service install)\n"), 0);
    out(`runs: ${exec}\n`);
    try {
      out(
        execFileSync(
          "systemctl",
          ["--user", "list-timers", "laobaigan.timer", "--no-pager"],
          { encoding: "utf8" },
        ),
      );
    } catch {
      // systemctl unavailable
    }
    return 0;
  }
  throw new Error(
    `Unknown service subcommand: ${sub} (install | uninstall | status)`,
  );
}

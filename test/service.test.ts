import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cliPath,
  fragileInstallWarnings,
  installedExecStart,
  installedExtraPath,
  installService,
  packageRoot,
  renderService,
  stableNode,
  uninstallService,
  type Exec,
} from "../src/service.ts";

function fakeExec(nodeMajor = "24") {
  const calls: string[] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "-p") return `${nodeMajor}\n`;
    if (cmd === "loginctl") return "no\n";
    return "";
  };
  return { calls, exec };
}

describe("lbg service", () => {
  it("finds the package and cli in both layouts", () => {
    expect(packageRoot("file:///repo/src/service.ts")).toBe("/repo");
    expect(cliPath("file:///repo/src/service.ts")).toBe("/repo/src/cli.ts");
    expect(packageRoot("file:///p/lib/node_modules/laobaigan/dist/service.js")).toBe("/p/lib/node_modules/laobaigan");
    expect(cliPath("file:///p/lib/node_modules/laobaigan/dist/service.js")).toBe("/p/lib/node_modules/laobaigan/dist/cli.js");
    expect(existsSync(join(packageRoot(), "systemd", "laobaigan.service.in"))).toBe(true);
  });

  it("prefers mise's major-version node alias when it exists", () => {
    const exact = "/h/.local/share/mise/installs/node/24.22.1/bin/node";
    expect(stableNode(exact, (p) => p === "/h/.local/share/mise/installs/node/24/bin/node")).toBe("/h/.local/share/mise/installs/node/24/bin/node");
    expect(stableNode(exact, () => false)).toBe(exact);
    expect(stableNode("/usr/bin/node")).toBe("/usr/bin/node");
  });

  it("warns about installs a node upgrade would break", () => {
    const miseCli = "/h/.local/share/mise/installs/node/24.22.1/lib/node_modules/laobaigan/dist/cli.js";
    expect(fragileInstallWarnings(miseCli, "/h/.local/share/mise/installs/node/24/bin/node")).toHaveLength(1);
    expect(fragileInstallWarnings("/h/.nvm/versions/node/v24.1.0/lib/node_modules/laobaigan/dist/cli.js", "/h/.nvm/versions/node/v24.1.0/bin/node")).toHaveLength(2);
    expect(fragileInstallWarnings("/h/.local/lib/node_modules/laobaigan/dist/cli.js", "/usr/bin/node")).toEqual([]);
    expect(fragileInstallWarnings("/repo/src/cli.ts", "/usr/bin/node")).toEqual([]);
  });

  it("renders the unit: node, cli, extra PATH with ~ expanded", () => {
    const t = "ExecStart=@NODE@ @CLI@ run\nEnvironment=PATH=@EXTRA_PATH@%h/.local/bin:/usr/bin\n";
    expect(renderService(t, { node: "/n", cli: "/c.js", extraPath: "~/.volta/bin" })).toBe(
      `ExecStart=/n /c.js run\nEnvironment=PATH=${homedir()}/.volta/bin:%h/.local/bin:/usr/bin\n`,
    );
    expect(renderService(t, { node: "/n", cli: "/c.js" })).toContain("Environment=PATH=%h/.local/bin");
  });

  it("installs, keeps the extra PATH on re-install, and uninstalls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-units-"));
    const { calls, exec } = fakeExec();
    const r = installService({ dir, exec, node: "/usr/bin/node", cli: "/opt/lbg/dist/cli.js", extraPath: "/opt/creds/bin" });
    expect(r.lingerOff).toBe(true);
    expect(calls).toContain("systemctl --user daemon-reload");
    expect(calls).toContain("systemctl --user enable --now laobaigan.timer");
    const unit = readFileSync(join(dir, "laobaigan.service"), "utf8");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/lbg/dist/cli.js run");
    expect(unit).not.toMatch(/@[A-Z_]+@/);
    expect(readFileSync(join(dir, "laobaigan.timer"), "utf8")).toContain("OnCalendar=hourly");
    expect(installedExecStart(dir)).toBe("/usr/bin/node /opt/lbg/dist/cli.js run");
    expect(installedExtraPath(dir)).toBe("/opt/creds/bin");

    expect(uninstallService({ dir, exec })).toEqual([join(dir, "laobaigan.service"), join(dir, "laobaigan.timer")]);
    expect(calls).toContain("systemctl --user disable --now laobaigan.timer");
    expect(installedExecStart(dir)).toBeUndefined();
  });

  it("refuses an old node", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lbg-units-"));
    expect(() => installService({ dir, exec: fakeExec("22").exec, node: "/usr/bin/node", cli: "/c.js" })).toThrow(/Node >= 24/);
  });
});

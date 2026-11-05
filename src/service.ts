import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The hourly systemd user timer: `lbg service install | uninstall | status`.
 * The unit runs this same lbg (the node that is running now + this package's cli),
 * so it works the same from a repo checkout and from `npm install -g laobaigan`.
 */

/** Package root: the directory above src/ (running from source) or dist/ (installed). */
export function packageRoot(moduleUrl: string = import.meta.url): string {
  return dirname(dirname(fileURLToPath(moduleUrl)));
}

/** The cli module next to this one (cli.ts from source, cli.js installed). */
export function cliPath(moduleUrl: string = import.meta.url): string {
  const here = fileURLToPath(moduleUrl);
  return join(dirname(here), `cli${here.endsWith(".ts") ? ".ts" : ".js"}`);
}

export function unitDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
}

/**
 * The node to put in ExecStart. mise's major-version alias (…/node/24/bin/node) survives
 * patch upgrades, so prefer it over the exact version when it points at the same node.
 */
export function stableNode(execPath: string, exists: (p: string) => boolean = existsSync): string {
  const m = /^(.*\/mise\/installs\/node\/)(\d+)\.\d+\.\d+(\/bin\/node)$/.exec(execPath);
  if (m) {
    const alias = `${m[1]}${m[2]}${m[3]}`;
    if (exists(alias)) return alias;
  }
  return execPath;
}

/** Warnings about installs that a node upgrade would break. */
export function fragileInstallWarnings(cli: string, node: string): string[] {
  const out: string[] = [];
  const versioned = /\/(mise\/installs\/node|\.nvm\/versions\/node|\.volta\/tools\/image\/node|fnm\/node-versions)\//;
  if (cli.includes("/node_modules/") && versioned.test(cli)) {
    out.push(
      `lbg is installed inside a version-specific node prefix (${cli.replace(/\/lib\/node_modules\/.*$/, "")}). ` +
        "After a node upgrade, reinstall it (npm install -g laobaigan) and re-run lbg service install, " +
        "or install it outside the versioned prefix: npm config set prefix ~/.local",
    );
  }
  if (versioned.test(node) && !/\/node\/\d+\/bin\/node$/.test(node)) {
    out.push(`The unit runs ${node}; it stops working when that node version is removed. Re-run lbg service install after upgrading node.`);
  }
  return out;
}

export interface UnitParams {
  node: string;
  cli: string;
  /** Extra PATH directories for the service (colon-separated). */
  extraPath?: string;
}

export function renderService(template: string, p: UnitParams): string {
  let extra = (p.extraPath ?? "").replace(/(^|:)~(?=\/|:|$)/g, `$1${homedir()}`);
  if (extra && !extra.endsWith(":")) extra += ":";
  return template.replaceAll("@NODE@", p.node).replaceAll("@CLI@", p.cli).replaceAll("@EXTRA_PATH@", extra);
}

export type Exec = (cmd: string, args: string[]) => string;
const realExec: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export interface InstallResult {
  servicePath: string;
  timerPath: string;
  node: string;
  cli: string;
  warnings: string[];
  /** Lingering is off: the timer only fires while I'm logged in. */
  lingerOff: boolean;
}

export function installService(
  opts: { extraPath?: string; node?: string; cli?: string; dir?: string; root?: string; exec?: Exec } = {},
): InstallResult {
  const exec = opts.exec ?? realExec;
  const root = opts.root ?? packageRoot();
  const node = opts.node ?? stableNode(process.execPath);
  const cli = opts.cli ?? cliPath();
  const major = Number(exec(node, ["-p", "process.versions.node.split('.')[0]"]).trim());
  if (!(major >= 24)) throw new Error(`lbg needs Node >= 24; ${node} is ${major || "unknown"}`);
  const dir = opts.dir ?? unitDir();
  mkdirSync(dir, { recursive: true });
  const servicePath = join(dir, "laobaigan.service");
  const timerPath = join(dir, "laobaigan.timer");
  const template = readFileSync(join(root, "systemd", "laobaigan.service.in"), "utf8");
  writeFileSync(servicePath, renderService(template, { node, cli, ...(opts.extraPath !== undefined ? { extraPath: opts.extraPath } : {}) }));
  writeFileSync(timerPath, readFileSync(join(root, "systemd", "laobaigan.timer"), "utf8"));
  exec("systemctl", ["--user", "daemon-reload"]);
  exec("systemctl", ["--user", "enable", "--now", "laobaigan.timer"]);
  let lingerOff = false;
  try {
    lingerOff = exec("loginctl", ["show-user", process.env.USER ?? "", "-p", "Linger", "--value"]).trim() !== "yes";
  } catch {
    // no logind: nothing to say
  }
  return { servicePath, timerPath, node, cli, warnings: fragileInstallWarnings(cli, node), lingerOff };
}

export function uninstallService(opts: { dir?: string; exec?: Exec } = {}): string[] {
  const exec = opts.exec ?? realExec;
  const dir = opts.dir ?? unitDir();
  try {
    exec("systemctl", ["--user", "disable", "--now", "laobaigan.timer"]);
  } catch {
    // not installed / not running
  }
  const removed: string[] = [];
  for (const f of ["laobaigan.service", "laobaigan.timer"]) {
    const p = join(dir, f);
    if (existsSync(p)) {
      rmSync(p);
      removed.push(p);
    }
  }
  exec("systemctl", ["--user", "daemon-reload"]);
  return removed;
}

/** ExecStart of the installed unit, if any (to show what the timer runs). */
export function installedExecStart(dir: string = unitDir()): string | undefined {
  const p = join(dir, "laobaigan.service");
  if (!existsSync(p)) return undefined;
  return /^ExecStart=(.*)$/m.exec(readFileSync(p, "utf8"))?.[1];
}

/** The extra PATH entries of the installed unit (kept on re-install unless --path is given). */
export function installedExtraPath(dir: string = unitDir()): string | undefined {
  const p = join(dir, "laobaigan.service");
  if (!existsSync(p)) return undefined;
  const m = /^Environment=PATH=(.*)%h\/\.local\/bin:/m.exec(readFileSync(p, "utf8"));
  return m ? m[1]!.replace(/:$/, "") : undefined;
}

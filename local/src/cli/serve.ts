import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath, loadConfig, resolveSkillarHome, resolveHome } from "../config.js";
import { startServer } from "../server.js";
import { openDb } from "../store/db.js";
import { createStore } from "../store/index.js";
import type { CliDeps, PackPlan, PackPlanFile } from "../types.js";
import { readTarget } from "./config-writer.js";

export type Io = { out(text: string): void; err(text: string): void };
export const processIo: Io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) };

export const SERVICE_LABEL = "dev.skillar.daemon";

export function packageRoot(): string {
  return realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
}

export function nodePath(): string {
  return realpathSync(process.execPath);
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

export function makeCliDeps(env: NodeJS.ProcessEnv): CliDeps {
  const config = loadConfig(env);
  const home = resolveHome(env);
  const skillarHome = resolveSkillarHome(env);
  return { config, home, skillarHome, env, openStore: () => createStore(openDb(dbPath(skillarHome)), { config, home, skillarHome }) };
}

export async function runServe(opts: { port?: number }, env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const deps = makeCliDeps(env);
  const config = opts.port === undefined ? deps.config : { ...deps.config, port: opts.port };
  const server = await startServer(config, { skillarHome: deps.skillarHome, openStore: deps.openStore });
  io.err(`skillar listening on http://127.0.0.1:${server.port}\n`);
  return 0;
}

export type PlannedCommand = PackPlan["commands"][number] & { allowFailure?: boolean };
export type ServicePlatform = "darwin" | "linux";
export type ServiceCtx = { home: string; skillarHome: string; env: NodeJS.ProcessEnv; nodePath: string; packageRoot: string; platform: ServicePlatform; uid: number };
export type ServicePlan = { file: PackPlanFile; commands: PlannedCommand[]; notes: string[] };

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unitQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function serviceLabel(home: string, platform: ServicePlatform): string {
  const legacy = platform === "darwin" ? join(home, "Library", "LaunchAgents", "dev.gisool.daemon.plist") : join(home, ".config", "systemd", "user", "gisool.service");
  return existsSync(legacy) ? (platform === "darwin" ? "dev.gisool.daemon" : "gisool") : (platform === "darwin" ? SERVICE_LABEL : "skillar");
}

export function servicePath(home: string, platform: ServicePlatform): string {
  const label = serviceLabel(home, platform);
  return platform === "darwin"
    ? join(home, "Library", "LaunchAgents", `${label}.plist`)
    : join(home, ".config", "systemd", "user", `${label}.service`);
}

export function daemonLogPath(skillarHome: string): string {
  return join(skillarHome, "logs", "daemon.log");
}

function plist(ctx: ServiceCtx): string {
  const log = xml(daemonLogPath(ctx.skillarHome));
  const args = [ctx.nodePath, join(ctx.packageRoot, "dist", "cli", "main.js"), "serve"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceLabel(ctx.home, ctx.platform)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SKILLAR_HOME</key>
    <string>${xml(ctx.skillarHome)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function unit(ctx: ServiceCtx): string {
  const log = daemonLogPath(ctx.skillarHome);
  return `[Unit]
Description=skillar local skill router

[Service]
ExecStart=${unitQuote(ctx.nodePath)} ${unitQuote(join(ctx.packageRoot, "dist", "cli", "main.js"))} serve
Environment=${unitQuote(`SKILLAR_HOME=${ctx.skillarHome}`)}
Restart=always
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

export function planService(ctx: ServiceCtx): ServicePlan {
  const path = servicePath(ctx.home, ctx.platform);
  const before = readTarget(path);
  const after = ctx.platform === "darwin" ? plist(ctx) : unit(ctx);
  const file: PackPlanFile = { path, before, after, mode: 0o644 };
  const commands: PlannedCommand[] = [];
  const notes: string[] = [];
  if (before === after) return { file, commands, notes: ["service definition already up to date"] };
  if (ctx.platform === "darwin") {
    const domain = `gui/${ctx.uid}`;
    if (before !== null) commands.push({ argv: ["launchctl", "bootout", `${domain}/${serviceLabel(ctx.home, ctx.platform)}`], description: "Unload the previous skillar LaunchAgent", allowFailure: true });
    commands.push({ argv: ["launchctl", "bootstrap", domain, path], description: "Load the skillar LaunchAgent",
      undo: { argv: ["launchctl", "bootout", `${domain}/${serviceLabel(ctx.home, ctx.platform)}`], description: "Unload the skillar LaunchAgent" } });
  } else {
    commands.push({ argv: ["systemctl", "--user", "daemon-reload"], description: "Reload systemd user units" });
    commands.push({ argv: ["systemctl", "--user", "enable", "--now", `${serviceLabel(ctx.home, ctx.platform)}.service`], description: "Enable and start the skillar user service",
      undo: { argv: ["systemctl", "--user", "disable", "--now", `${serviceLabel(ctx.home, ctx.platform)}.service`], description: "Stop and disable the skillar user service" } });
    if (before !== null) commands.push({ argv: ["systemctl", "--user", "restart", `${serviceLabel(ctx.home, ctx.platform)}.service`], description: "Restart skillar with the new unit" });
  }
  if ((ctx.env.SKILLAR_NO_CLI ?? ctx.env.GISOOL_NO_CLI)) {
    notes.push(`SKILLAR_NO_CLI set: service file written but not loaded; run manually: ${commands.map((c) => c.argv.join(" ")).join(" && ")}`);
    return { file, commands: [], notes };
  }
  return { file, commands, notes };
}

export function serviceLoaded(platform: ServicePlatform, uid: number, env: NodeJS.ProcessEnv): boolean {
  const argv = platform === "darwin" ? ["launchctl", "print", `gui/${uid}/${serviceLabel(resolveHome(env), platform)}`] : ["systemctl", "--user", "is-active", serviceLabel(resolveHome(env), platform)];
  const r = spawnSync(argv[0]!, argv.slice(1), { env, stdio: "ignore" });
  return r.status === 0;
}

export function currentServicePlatform(): ServicePlatform {
  return process.platform === "darwin" ? "darwin" : "linux";
}

export function serviceStatus(env: NodeJS.ProcessEnv, io: Io): number {
  const home = resolveHome(env);
  const platform = currentServicePlatform();
  const path = servicePath(home, platform);
  const installed = existsSync(path);
  io.out(`service file: ${installed ? path : "not installed"}\n`);
  if ((env.SKILLAR_NO_CLI ?? env.GISOOL_NO_CLI)) {
    io.out("service loaded: skipped (SKILLAR_NO_CLI)\n");
    return installed ? 0 : 1;
  }
  const loaded = serviceLoaded(platform, process.getuid?.() ?? 0, env);
  io.out(`service loaded: ${loaded ? "yes" : "no"}\n`);
  return installed && loaded ? 0 : 1;
}

export { dbPath } from "../config.js";

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveSkillarHome } from "../config.js";
import type { PackCtx, PackPlan, PackPlanFile, RuntimePack } from "../types.js";

const CONFIG_NOTE = "Set plugins.entries.skillar.hooks.allowConversationAccess: true in the OpenClaw config (openclaw.json); without it before_agent_run is not delivered.";
const TEMPLATES = new Set([".mcp.json", "openclaw.plugin.json", "skillar.json"]);

function skillarHome(env: NodeJS.ProcessEnv, home: string): string {
  return resolveSkillarHome({ ...env, HOME: home });
}

function openclawConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.OPENCLAW_CONFIG_PATH || join(env.OPENCLAW_STATE_DIR || join(home, ".openclaw"), "openclaw.json");
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function fill(node: unknown, vars: Record<string, unknown>): unknown {
  if (typeof node === "string") return node in vars ? vars[node] : node;
  if (Array.isArray(node)) return node.flatMap((n) => (typeof n === "string" && Array.isArray(vars[n]) ? (vars[n] as unknown[]) : [fill(n, vars)]));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, vars)]));
  return node;
}

/** Tolerant read of an openclaw.json (JSON5-ish): strips comments and trailing commas, falls back to null. */
function parseConfig(text: string): unknown {
  const stripped = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, s) => s ?? "").replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

type Rec = Record<string, any>;
const isRecord = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const pluginEntries = (cfg: Rec): Rec | undefined => (isRecord(cfg.plugins) && isRecord(cfg.plugins.entries) ? cfg.plugins.entries : undefined);

function hasConversationAccess(text: string): boolean {
  const cfg = parseConfig(text);
  if (isRecord(cfg)) return (pluginEntries(cfg)?.skillar?.hooks?.allowConversationAccess === true || pluginEntries(cfg)?.gisool?.hooks?.allowConversationAccess === true);
  return /allowConversationAccess["']?\s*:\s*true/.test(text);
}

export function bundleDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(skillarHome(env, home), "packs", "openclaw");
}

export const openclawPack: RuntimePack = {
  id: "openclaw",

  async detect({ home, env }) {
    const state = env.OPENCLAW_STATE_DIR || join(home, ".openclaw");
    const evidence: string[] = [];
    if (existsSync(state)) evidence.push(state);
    if (existsSync(openclawConfigPath(env, home))) evidence.push(openclawConfigPath(env, home));
    const remote = ["gisul", "skillar"].flatMap(name => [join(state, name), join(state, "plugins", name), join(state, "extensions", name)]).find(existsSync);
    const cfgText = readOrNull(openclawConfigPath(env, home));
    const cfg = cfgText ? parseConfig(cfgText) : null;
    const entries = isRecord(cfg) ? pluginEntries(cfg) : undefined;
    const remoteSkillarRegistered = Boolean(remote) || Boolean(entries?.gisul || entries?.["gisul-openclaw"] || entries?.["skillar-openclaw"]);
    if (remote) evidence.push(remote);
    return { installed: evidence.length > 0, evidence, remoteSkillarRegistered };
  },

  async plan(ctx: PackCtx): Promise<PackPlan> {
    const src = join(ctx.packageRoot, "packs", "openclaw");
    const dest = bundleDir(ctx.env, ctx.home);
    const cfg = parseConfig(readOrNull(openclawConfigPath(ctx.env, ctx.home)) ?? "{}");
    const prior = readOrNull(join(dest, "openclaw.plugin.json"));
    const legacy = (isRecord(cfg) && Boolean(pluginEntries(cfg)?.gisool)) || (prior !== null && /"id"\s*:\s*"gisool"/.test(prior));
    const pluginName = legacy ? "gisool" : "skillar";
    const vars = {
      __COMMAND__: ctx.nodePath,
      __ARGS__: [join(ctx.packageRoot, "dist", "cli", "main.js"), "mcp-stdio"],
      __SKILLAR_HOME__: skillarHome(ctx.env, ctx.home),
      __PORT__: ctx.port,
    };
    const files: PackPlanFile[] = walk(src)
      .sort()
      .map((abs) => {
        let rel = relative(src, abs);
        const raw = readFileSync(abs, "utf8");
        let after = TEMPLATES.has(rel) ? JSON.stringify(fill(JSON.parse(raw), vars), null, 2) + "\n" : raw;
        if (legacy) {
          // Preserve the installed plugin and hook identities while replacing their implementation.
          after = after.replaceAll('"id": "skillar"', '"id": "gisool"').replaceAll('"name": "skillar"', '"name": "gisool"')
            .replaceAll('id: "skillar"', 'id: "gisool"').replaceAll('name: "skillar"', 'name: "gisool"')
            .replaceAll('"skillar": {', '"gisool": {').replaceAll('skillar-discovery', 'gisool-discovery');
          rel = rel.replaceAll("skillar-discovery", "gisool-discovery");
        }
        const path = join(dest, rel);
        return { path, before: readOrNull(path), after, mode: statSync(abs).mode & 0o777 };
      });

    const notes = [
      `Bundle files: ${files.map((f) => relative(dest, f.path)).join(", ")}`,
      CONFIG_NOTE.replace("entries.skillar", `entries.${pluginName}`),
      "Restart the OpenClaw Gateway after installing so the plugin and its hooks load.",
    ];
    const commands: PackPlan["commands"] = [];
    // skillar writes this bundle itself, so the local-path trust prompt ("rerun with --force") is expected and answered here.
    const install = ["openclaw", "plugins", "install", "--force", dest];
    const uninstall = ["openclaw", "plugins", "uninstall", pluginName];
    if ((ctx.env.SKILLAR_NO_CLI ?? ctx.env.GISOOL_NO_CLI)) notes.push(`SKILLAR_NO_CLI set: run manually: ${install.join(" ")} (undo: ${uninstall.join(" ")})`);
    else commands.push({ argv: install, description: "Install the skillar capture plugin into OpenClaw (restart the OpenClaw Gateway afterwards)", undo: { argv: uninstall, description: "Uninstall the skillar OpenClaw plugin" } });

    if (ctx.disableRemote) notes.push("Remote skillar OpenClaw bundle is not removed automatically. To disable it run: openclaw plugins disable gisul-openclaw; to remove it run: openclaw plugins uninstall gisul-openclaw");
    return { files, commands, notes, conflicts: [] };
  },

  async doctorChecks({ home, env }) {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const bundle = bundleDir(env, home);
    const bundled = existsSync(join(bundle, "openclaw.plugin.json"));
    checks.push({ name: "openclaw bundle", ok: bundled, detail: bundled ? bundle : `bundle missing at ${bundle}; run skillar init` });
    const cfgPath = openclawConfigPath(env, home);
    const text = readOrNull(cfgPath);
    if (text === null) checks.push({ name: "allowConversationAccess", ok: false, detail: `allowConversationAccess missing: no OpenClaw config at ${cfgPath}` });
    else if (hasConversationAccess(text)) checks.push({ name: "allowConversationAccess", ok: true, detail: cfgPath });
    else checks.push({ name: "allowConversationAccess", ok: false, detail: `allowConversationAccess missing: set plugins.entries.skillar.hooks.allowConversationAccess: true in ${cfgPath}` });
    return checks;
  },
};

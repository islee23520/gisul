import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { SkillarConfig } from "./types.js";

export const DEFAULT_PORT = 8799;

export const DEFAULT_ROOTS: readonly { id: string; path: string }[] = [
  { id: "agents", path: "~/.agents/skills" },
  { id: "claude", path: "~/.claude/skills" },
  { id: "codex", path: "~/.codex/skills" },
  { id: "gemini", path: "~/.gemini/skills" },
  { id: "omo", path: "~/.omo/agent/skills" },
  { id: "gajae", path: "~/.gjc/agent/skills" },
  { id: "openclaw", path: "~/.openclaw/skills" },
  { id: "iyen", path: "~/iyen-skills/skills" },
];

const runtimeIds = ["claude-code", "codex", "gemini", "cursor", "omo", "gajae", "openclaw", "unknown"] as const;

const fileSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  captureLevel: z.enum(["metadata", "redacted", "full"]).optional(),
  retentionDays: z.number().int().positive().nullable().optional(),
  roots: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) })).optional(),
  runtimes: z.partialRecord(z.enum(runtimeIds), z.object({ enabled: z.boolean() })).optional(),
});

export function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}

export function resolveSkillarHome(env: NodeJS.ProcessEnv): string {
  const explicit = env.SKILLAR_HOME || env.GISOOL_HOME;
  if (explicit) return explicit;
  // Reuse the complete legacy store in place: never split tokens, backups or history.
  const preferred = join(resolveHome(env), ".skillar");
  const legacy = join(resolveHome(env), ".gisool");
  if (["config.json", "token", "skillar.db", "gisool.db"].some(file => existsSync(join(preferred, file)))) return preferred;
  return existsSync(legacy) ? legacy : preferred;
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : join(home, path);
}

export function defaultConfigFile(): { port: number; captureLevel: "full"; retentionDays: null; roots: { id: string; path: string }[]; runtimes: Record<string, never> } {
  return { port: DEFAULT_PORT, captureLevel: "full", retentionDays: null, roots: DEFAULT_ROOTS.map((r) => ({ ...r })), runtimes: {} };
}

export function ensureSkillarHome(env: NodeJS.ProcessEnv): string {
  const dir = resolveSkillarHome(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Returns the daemon bearer token, creating a 32-byte hex token (mode 0600) on first use. */
export function ensureToken(skillarHome: string): string {
  const path = join(skillarHome, "token");
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** Loads (and on first run creates) SKILLAR_HOME, config.json and the token. No work happens at import time. */
export function loadConfig(env: NodeJS.ProcessEnv): SkillarConfig {
  const home = resolveHome(env);
  const skillarHome = ensureSkillarHome(env);
  const configPath = join(skillarHome, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(defaultConfigFile(), null, 2) + "\n", { mode: 0o600 });
  }
  const parsed = fileSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  ensureToken(skillarHome);
  const defaults = defaultConfigFile();
  return {
    port: parsed.port ?? defaults.port,
    captureLevel: parsed.captureLevel ?? defaults.captureLevel,
    retentionDays: parsed.retentionDays ?? null,
    roots: (parsed.roots ?? defaults.roots).map((r) => ({ id: r.id, path: expandHome(r.path, home) })),
    runtimes: parsed.runtimes ?? {},
  };
}

export function dbPath(skillarHome: string): string {
  const current = join(skillarHome, "skillar.db"), legacy = join(skillarHome, "gisool.db");
  if (existsSync(current) && existsSync(legacy)) throw new Error("Both skillar.db and gisool.db exist in the selected home; preserve both and choose one store before starting Skillar");
  return existsSync(legacy) ? legacy : current;
}

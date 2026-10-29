#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, ListResourcesRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ServerProtocolTransport, MODERN_VERSION, VERSION_KEY, CAPS_KEY, cacheHints, decodeHeader } from "./protocol.js";
import { identityFromEnv, classifyClientName, guidanceFor, NEUTRAL_IDENTITY } from "./client-identity.js";

import type { Request, Response } from "express";
import { z } from "zod";
import { parse as parseYaml } from "yaml";

const DEFAULT_ROOT = (existsSync(path.join(homedir(), "gisul")) ? path.join(homedir(), "gisul") : path.join(homedir(), "iyen-skills"));
const ROOT_DIR = path.resolve((process.env.SKILLAR_ROOT ?? process.env.GISUL_ROOT) ?? DEFAULT_ROOT);
const CURRENT_DIR = path.join(ROOT_DIR, "current");
const HAS_CURRENT = await lstat(CURRENT_DIR).then(() => true, error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  throw error;
});
const CONTENT_DIR = HAS_CURRENT ? CURRENT_DIR : ROOT_DIR;
const DEFAULT_SKILL_ROOTS = [
  { id: "iyen", dir: path.join(CONTENT_DIR, "skills") },
  ...(HAS_CURRENT ? [] : [
    { id: "codex", dir: path.join(homedir(), ".codex", "skills") },
    { id: "agents", dir: path.join(homedir(), ".agents", "skills") },
  ]),
];
const SKILL_ROOTS = configuredSkillRoots();
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const configuredAuthority = process.env.SKILLAR_URI_AUTHORITY ?? process.env.GISUL_URI_AUTHORITY;
const SKILL_URI_AUTHORITY = configuredAuthority === "gisul" ? "skillar" : configuredAuthority ?? "skillar";
const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
const MAX_SKILL_RESOURCE_COUNT = 512;
const MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_HTTP_PORT = 8788;
const STATE_DIR = path.resolve((process.env.SKILLAR_STATE_DIR ?? process.env.GISUL_STATE_DIR) ?? (existsSync(path.join(homedir(), ".config", "gisul-mcp")) ? path.join(homedir(), ".config", "gisul-mcp") : path.join(homedir(), ".config", "skillar-mcp")));
const TOKEN_REQUESTS_FILE = path.resolve((process.env.SKILLAR_TOKEN_REQUESTS_FILE ?? process.env.GISUL_TOKEN_REQUESTS_FILE) ?? path.join(STATE_DIR, "token-requests.json"));
const TOKENS_FILE = path.resolve((process.env.SKILLAR_TOKENS_FILE ?? process.env.GISUL_TOKENS_FILE) ?? path.join(STATE_DIR, "tokens.json"));
const ADMIN_TOKEN_FILE = path.resolve((process.env.SKILLAR_ADMIN_TOKEN_FILE ?? process.env.GISUL_ADMIN_TOKEN_FILE) ?? path.join(STATE_DIR, "admin-token"));
const RELEASE_FILE = path.resolve((process.env.SKILLAR_RELEASE_FILE ?? process.env.GISUL_RELEASE_FILE) ?? path.join(CONTENT_DIR, "release.json"));
const ALIASES_FILE = path.resolve((process.env.SKILLAR_ALIASES_FILE ?? process.env.GISUL_ALIASES_FILE) ?? path.join(CONTENT_DIR, "aliases.json"));
const SERVER_VERSION = "0.2.0";

function configuredSkillRoots(): Array<{ id: string; dir: string }> {
  const configured = (process.env.SKILLAR_SKILL_ROOTS ?? process.env.GISUL_SKILL_ROOTS);
  if (configured !== undefined) {
    const ids = new Set<string>();
    const roots = configured.split(";").map(value => {
      const separator = value.indexOf("=");
      const id = value.slice(0, separator).trim();
      const dir = value.slice(separator + 1).trim();
      if (separator < 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || !path.isAbsolute(dir) || ids.has(id)) {
        throw new Error("SKILLAR_SKILL_ROOTS requires unique URI-safe ids and absolute directories: skillar=/path/skills;codex=/path/codex-skills");
      }
      ids.add(id);
      return { id, dir: path.resolve(dir) };
    });
    if ((process.env.SKILLAR_SKILLS_DIRS ?? process.env.GISUL_SKILLS_DIRS)) console.error("SKILLAR_SKILLS_DIRS is deprecated and ignored because SKILLAR_SKILL_ROOTS is configured");
    return roots;
  }
  if ((process.env.SKILLAR_SKILLS_DIRS ?? process.env.GISUL_SKILLS_DIRS)) {
    console.error("SKILLAR_SKILLS_DIRS is deprecated; use SKILLAR_SKILL_ROOTS to preserve stable URI source ids");
    return (process.env.SKILLAR_SKILLS_DIRS ?? process.env.GISUL_SKILLS_DIRS)!.split(path.delimiter).filter(Boolean).map((dir, index) => ({ id: `root${index}`, dir: path.resolve(dir) }));
  }
  return DEFAULT_SKILL_ROOTS;
}

type SkillSummary = {
  name: string;
  source: string;
  description: string;
  uri: string;
  path: string;
  sha256: string;
  resources: string[];
};

type SkillRecord = {
  source: string;
  dirName: string;
  rootDir: string;
};

type SkillResourceManifest = {
  uri: string;
  digest: string;
  size: number;
};

type SkillEntry = {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: SkillResourceManifest[];
};

const releaseSchema = z.object({
  release: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{7,40}$/),
  skills: z.array(z.object({ uri: z.string(), manifest_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) })).optional(),
});
type ReleaseRecord = { data: z.infer<typeof releaseSchema>; fingerprint: string };

function manifestDigest(entry: SkillEntry): string {
  const resources = entry.resources.map(({ uri, digest, size }) => ({ uri, digest, size })).sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
  return `sha256:${createHash("sha256").update(JSON.stringify(resources)).digest("hex")}`;
}

async function readRelease(): Promise<ReleaseRecord | undefined> {
  let text: string;
  try { text = await readFile(RELEASE_FILE, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !HAS_CURRENT) return undefined; throw error; }
  const parsed = releaseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new McpError(ErrorCode.InternalError, "Invalid skillar release metadata");
  return { data: parsed.data, fingerprint: createHash("sha256").update(text).digest("hex") };
}

async function releaseMetadata(before: ReleaseRecord | undefined, entries: SkillEntry[], complete = false): Promise<Record<string, string>> {
  const after = await readRelease();
  if (before?.fingerprint !== after?.fingerprint) throw new McpError(ErrorCode.InternalError, "Skillar release changed during this request; retry against the current release");
  const meta: Record<string, string> = { server_version: SERVER_VERSION };
  if (!before) return meta;
  const manifest = before.data.skills;
  if (manifest) {
    const byUri = new Map(manifest.map(skill => [skill.uri, skill.manifest_digest]));
    if (byUri.size !== manifest.length || (complete && entries.length !== manifest.length) || entries.some(entry => byUri.get(entry.uri) !== manifestDigest(entry))) {
      throw new McpError(ErrorCode.InternalError, "Served skills differ from release metadata; publish a matching release before claiming its version");
    }
  }
  return { ...meta, release: before.data.release, commit: before.data.commit };
}

type TokenRequestStatus = "pending" | "approved" | "denied" | "delivered";

type TokenRequestRecord = {
  id: string;
  claimHash: string;
  status: TokenRequestStatus;
  label: string;
  note: string;
  requester: string;
  createdAt: string;
  approvedAt?: string;
  deniedAt?: string;
  deliveredAt?: string;
  tokenId?: string;
  tokenPlaintext?: string;
};

type IssuedTokenRecord = {
  id: string;
  tokenHash: string;
  prefix: string;
  label: string;
  note: string;
  requestId?: string;
  requester?: string;
  createdAt: string;
  revokedAt?: string;
};

type TokenStore = {
  tokens: IssuedTokenRecord[];
};

type TokenRequestStore = {
  requests: TokenRequestRecord[];
};

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function equalSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sanitizeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function getRequester(req: Request): string {
  const forwardedFor = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "";
  return Array.isArray(forwardedFor) ? forwardedFor[0] : String(forwardedFor).split(",")[0].trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, filePath);
}

async function readTokenStore(): Promise<TokenStore> {
  const store = await readJsonFile<TokenStore>(TOKENS_FILE, { tokens: [] });
  return { tokens: Array.isArray(store.tokens) ? store.tokens : [] };
}

async function writeTokenStore(store: TokenStore): Promise<void> {
  await writeJsonFile(TOKENS_FILE, store);
}

async function readTokenRequestStore(): Promise<TokenRequestStore> {
  const store = await readJsonFile<TokenRequestStore>(TOKEN_REQUESTS_FILE, { requests: [] });
  return { requests: Array.isArray(store.requests) ? store.requests : [] };
}

async function writeTokenRequestStore(store: TokenRequestStore): Promise<void> {
  await writeJsonFile(TOKEN_REQUESTS_FILE, store);
}

function parseFrontmatter(markdown: string): Record<string, string> {
  if (!markdown.startsWith("---\n")) return {};
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return {};

  const result: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return result;
}

function parseSkillFrontmatter(markdown: string): Record<string, unknown> | null {
  if (!markdown.startsWith("---\n")) return null;
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return null;
  const afterDelimiter = markdown.slice(end + 4, end + 5);
  if (afterDelimiter !== "" && afterDelimiter !== "\n") return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(markdown.slice(4, end));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/plain",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function mimeForPath(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    mimeType === "image/svg+xml"
  );
}

function assertSkillName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return name;
}

function normalizeRelativePath(value: string | undefined): string {
  if (!value || value === "/") return "SKILL.md";
  if (value.includes("\0")) throw new Error("Resource path contains a NUL byte");

  const normalized = path.posix.normalize(value.replace(/^\/+/, ""));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Resource path escapes the skill directory: ${value}`);
  }
  return normalized;
}

function parseSkillUri(uri: string): { record: SkillRecord; relativePath: string } {
  const parsed = new URL(uri);
  if (parsed.protocol !== "skill:") {
    throw new Error(`Unsupported resource URI protocol: ${parsed.protocol}`);
  }

  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const source = assertSkillName(parts[0] ?? "");
  const dirName = assertSkillName(parts[1] ?? "");
  const relativePath = normalizeRelativePath(parts.slice(2).join("/"));
  const rootDir = SKILL_ROOTS.find((root) => root.id === source)?.dir;
  if (!rootDir) throw new Error(`Unknown skill source: ${source}`);

  return { record: { source, dirName, rootDir }, relativePath };
}

async function readSkillMarkdown(record: SkillRecord): Promise<{ markdown: string; filePath: string }> {
  const safeName = assertSkillName(record.dirName);
  const filePath = path.join(record.rootDir, safeName, "SKILL.md");
  const markdown = await readFile(filePath, "utf8");
  return { markdown, filePath };
}

async function readSkillResource(record: SkillRecord, relativePathInput?: string): Promise<{ text: string; filePath: string }> {
  const safeName = assertSkillName(record.dirName);
  const relativePath = normalizeRelativePath(relativePathInput);
  const baseDir = path.join(record.rootDir, safeName);
  const filePath = path.resolve(baseDir, relativePath);
  const relativeToBase = path.relative(baseDir, filePath);

  if (relativeToBase.startsWith("..") || path.isAbsolute(relativeToBase)) {
    throw new Error(`Resource path escapes the skill directory: ${relativePathInput}`);
  }

  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Resource is not a file: ${relativePath}`);
  if (info.size > MAX_RESOURCE_BYTES) {
    throw new Error(`Resource exceeds ${MAX_RESOURCE_BYTES} bytes: ${relativePath}`);
  }

  return { text: await readFile(filePath, "utf8"), filePath };
}

async function listResourceUris(record: SkillRecord): Promise<string[]> {
  const safeName = assertSkillName(record.dirName);
  const baseDir = path.join(record.rootDir, safeName);
  const output: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const nextPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relative = path.relative(baseDir, nextPath).split(path.sep).join("/");
      output.push(
        `skill://${SKILL_URI_AUTHORITY}/${encodeURIComponent(record.source)}/${encodeURIComponent(safeName)}/${relative
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
      );
    }
  }

  await walk(baseDir);
  return output.sort();
}

async function listSkills(query?: string): Promise<SkillSummary[]> {
  const normalizedQuery = query?.trim().toLowerCase();
  const skills: SkillSummary[] = [];

  for (const root of SKILL_ROOTS) {
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const record: SkillRecord = { source: root.id, dirName: entry.name, rootDir: root.dir };

      try {
        const { markdown, filePath } = await readSkillMarkdown(record);
        const frontmatter = parseFrontmatter(markdown);
        const name = frontmatter.name || entry.name;
        const description = frontmatter.description || "";

        if (
          normalizedQuery &&
          !name.toLowerCase().includes(normalizedQuery) &&
          !description.toLowerCase().includes(normalizedQuery)
        ) {
          continue;
        }

        skills.push({
          name,
          source: root.id,
          description,
          uri: `skill://${SKILL_URI_AUTHORITY}/${encodeURIComponent(root.id)}/${encodeURIComponent(entry.name)}`,
          path: filePath,
          sha256: hashText(markdown),
          resources: await listResourceUris(record),
        });
      } catch {
        continue;
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).optional(),
});

const SkillsGetRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string() }),
});

const SkillsDirectoryReadRequestSchema = z.object({
  method: z.literal("resources/directory/read"),
  params: z.object({ uri: z.string(), cursor: z.string().optional() }).optional(),
});

function skillUri(...segments: string[]): string {
  const pathSegments = segments.flatMap((segment) => segment.split("/"));
  return `skill://${SKILL_URI_AUTHORITY}/${pathSegments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

async function collectSkillRelativeFiles(baseDir: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        output.push(relative);
      }
    }
  }

  await walk(baseDir, "");
  return output.sort();
}

async function buildSkillEntry(source: string, rootDir: string, dirName: string): Promise<SkillEntry | null> {
  let markdown: string;
  try {
    const info = await lstat(path.join(rootDir, dirName, "SKILL.md"));
    if (!info.isFile() || info.isSymbolicLink()) {
      console.error(`Skipping skill ${source}/${dirName}: SKILL.md must be a regular file`);
      return null;
    }
    markdown = await readFile(path.join(rootDir, dirName, "SKILL.md"), "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseSkillFrontmatter(markdown);
  if (
    !frontmatter ||
    typeof frontmatter.name !== "string" ||
    !frontmatter.name ||
    typeof frontmatter.description !== "string" ||
    !frontmatter.description
  ) {
    console.error(`Skipping skill ${source}/${dirName}: SKILL.md frontmatter requires name and description`);
    return null;
  }
  if (frontmatter.name !== dirName.split("/").pop()) {
    console.error(
      `Skipping skill ${source}/${dirName}: frontmatter name "${frontmatter.name}" does not match directory name`,
    );
    return null;
  }

  const resources: SkillResourceManifest[] = [];
  let totalBytes = 0;
  for (const relative of await collectSkillRelativeFiles(path.join(rootDir, dirName))) {
    const bytes = await readFile(path.join(rootDir, dirName, relative));
    totalBytes += bytes.byteLength;
    resources.push({
      uri: skillUri(source, dirName, relative),
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.byteLength,
    });
  }

  if (resources.length > MAX_SKILL_RESOURCE_COUNT || totalBytes > MAX_SKILL_TOTAL_BYTES) {
    console.error(
      `Skipping skill ${source}/${dirName}: exceeds SEP-2640 limits (${resources.length} resources, ${totalBytes} bytes)`,
    );
    return null;
  }

  return { uri: skillUri(source, dirName, "SKILL.md"), frontmatter, resources };
}

async function listSkillEntryDirs(rootDir: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      try {
        const info = await stat(path.join(dir, entry.name, "SKILL.md"));
        if (info.isFile()) output.push(relative);
      } catch {
        // not a skill directory; descendants may still contain one
      }
      await walk(path.join(dir, entry.name), relative);
    }
  }

  await walk(rootDir, "");
  return output.sort();
}

async function listSkillEntries(): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  const seenUris = new Set<string>();
  for (const root of SKILL_ROOTS) {
    let skillDirs: string[];
    try {
      skillDirs = await listSkillEntryDirs(root.dir);
    } catch {
      continue;
    }
    for (const dirName of skillDirs) {
      try {
        const entry = await buildSkillEntry(root.id, root.dir, dirName);
        if (entry && !seenUris.has(entry.uri)) {
          seenUris.add(entry.uri);
          entries.push(entry);
        }
      } catch (error) {
        console.error(`Failed to build skill entry for ${root.id}/${dirName}:`, error);
      }
    }
  }
  return entries.sort((a, b) => a.uri.localeCompare(b.uri));
}

function parseSkillUriSegments(uri: string): { source: string; pathSegments: string[] } | null {
  if (/%2e/i.test(uri)) return null;
  const authorityIndex = uri.indexOf("://");
  const rawPath = authorityIndex === -1 ? uri : uri.slice(authorityIndex + 3);
  if (rawPath.split("/").some((segment) => segment === ".." || segment === ".")) return null;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "skill:" || !(parsed.host === SKILL_URI_AUTHORITY || (SKILL_URI_AUTHORITY === "skillar" && parsed.host === "gisul" && /^\/(gisul|codex)\//.test(parsed.pathname))) || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname || parsed.pathname === "/") return null;

  let segments: string[];
  try {
    segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length === 0) return null;

  const source = parsed.host === "gisul" && SKILL_URI_AUTHORITY === "skillar" && ["gisul", "codex"].includes(segments[0]) ? "iyen" : segments[0];
  if (!/^[A-Za-z0-9._-]+$/.test(source)) return null;
  for (const segment of segments.slice(1)) {
    if (segment === ".." || segment === "." || segment.includes("/") || segment.includes("\0")) return null;
  }
  return { source, pathSegments: segments.slice(1) };
}

function resolveSkillPath(source: string, pathSegments: string[]): { rootDir: string; relativePath: string } | null {
  const root = SKILL_ROOTS.find((candidate) => candidate.id === source);
  if (!root || pathSegments.length === 0) return null;

  const relativePath = path.posix.normalize(pathSegments.join("/"));
  const filePath = path.resolve(root.dir, relativePath);
  const relativeToRoot = path.relative(root.dir, filePath);
  if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) return null;
  return { rootDir: root.dir, relativePath };
}

async function resolveSkillAlias(uri: string): Promise<string> {
  const parsed = parseSkillUriSegments(uri);
  const migrated = uri.startsWith("skill://gisul/") && parsed && SKILL_URI_AUTHORITY === "skillar"
    ? skillUri(parsed.source, ...parsed.pathSegments) : uri;
  let contents: string;
  try { contents = await readFile(ALIASES_FILE, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return migrated; throw error; }
  const aliases = z.record(z.string(), z.string()).parse(JSON.parse(contents));
  let current = Object.hasOwn(aliases, uri) ? uri : migrated;
  const visited = new Set<string>();
  while (Object.hasOwn(aliases, current)) {
    if (visited.has(current) || visited.size >= 8) throw new McpError(ErrorCode.InternalError, "Cyclic or excessive skillar URI aliases");
    visited.add(current);
    const next = aliases[current];
    const parsed = parseSkillUriSegments(next);
    if (!parsed || parsed.pathSegments.at(-1) !== "SKILL.md" || next !== skillUri(parsed.source, ...parsed.pathSegments)) {
      throw new McpError(ErrorCode.InternalError, "Alias target must be a canonical SKILL.md URI on this server");
    }
    current = next;
  }
  return current;
}

async function readSkillResourceByUri(uri: string): Promise<{ mimeType: string; text?: string; blob?: string }> {
  const parsed = parseSkillUriSegments(uri);
  if (!parsed) throw new McpError(ErrorCode.InvalidParams, `Invalid skill resource URI: ${uri}`);

  const resolved = resolveSkillPath(parsed.source, parsed.pathSegments);
  if (!resolved) throw new McpError(ErrorCode.InvalidParams, `Unknown skill resource: ${uri}`);

  const filePath = await assertRegularSkillPath(resolved.rootDir, resolved.relativePath.split("/"));
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Unknown skill resource: ${uri}`);
  }
  if (!info.isFile()) throw new McpError(ErrorCode.InvalidParams, `Resource is not a file: ${uri}`);
  if (info.size > MAX_RESOURCE_BYTES) {
    throw new McpError(ErrorCode.InvalidParams, `Resource exceeds ${MAX_RESOURCE_BYTES} bytes: ${uri}`);
  }

  const bytes = await readFile(filePath);
  const mimeType = mimeForPath(filePath);
  return isTextMimeType(mimeType)
    ? { mimeType, text: bytes.toString("utf8") }
    : { mimeType, blob: bytes.toString("base64") };
}

async function readSkillDirectoryByUri(uri: string): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
  const parsed = parseSkillUriSegments(uri);
  if (!parsed) throw new McpError(ErrorCode.InvalidParams, `Invalid skill directory URI: ${uri}`);

  const resolved = resolveSkillPath(parsed.source, parsed.pathSegments);
  if (!resolved) throw new McpError(ErrorCode.InvalidParams, `Unknown skill directory: ${uri}`);

  const dirPath = await assertRegularSkillPath(resolved.rootDir, resolved.relativePath.split("/"), "directory");
  let info;
  try {
    info = await stat(dirPath);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Unknown skill directory: ${uri}`);
  }
  if (!info.isDirectory()) throw new McpError(ErrorCode.InvalidParams, `Resource is not a directory: ${uri}`);

  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules" && (entry.isFile() || entry.isDirectory()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      uri: skillUri(parsed.source, ...parsed.pathSegments, entry.name),
      name: entry.name,
      mimeType: entry.isDirectory() ? "inode/directory" : mimeForPath(entry.name),
    }));
}

async function listSkillResourcesForClient(): Promise<
  Array<{ uri: string; name: string; mimeType: string; description?: string }>
> {
  const resources: Array<{ uri: string; name: string; mimeType: string; description?: string }> = [];
  for (const entry of await listSkillEntries()) {
    for (const manifest of entry.resources) {
      if (manifest.uri === entry.uri) {
        resources.push({
          uri: manifest.uri,
          name: String(entry.frontmatter.name),
          mimeType: "text/markdown",
          description: String(entry.frontmatter.description ?? ""),
        });
      } else {
        const name = manifest.uri.split("/").pop() ?? "";
        resources.push({ uri: manifest.uri, name, mimeType: mimeForPath(name) });
      }
    }
  }
  return resources;
}

function registerSkillsExtension(server: McpServer): void {
  server.server.setRequestHandler(z.object({ method: z.literal("server/discover"), params: z.object({ _meta: z.record(z.string(), z.unknown()) }) }), async () => ({
    resultType: "complete", supportedVersions: [MODERN_VERSION], ...cacheHints,
    capabilities: { resources: {}, tools: {}, extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } } },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "skillar", version: SERVER_VERSION } },
  }));
  server.server.setRequestHandler(SkillsListRequestSchema, async () => {
    const release = await readRelease();
    const skills = await listSkillEntries();
    return { resultType: "complete", ...cacheHints, skills, _meta: await releaseMetadata(release, skills, true) };
  });

  server.server.setRequestHandler(SkillsGetRequestSchema, async (request) => {
    const release = await readRelease();
    const uri = request.params.uri;
    const canonical = await resolveSkillAlias(uri);
    const entry = (await listSkillEntries()).find((candidate) => candidate.uri === canonical);
    if (!entry) throw new McpError(ErrorCode.InvalidParams, `Not a skill served by this server: ${uri}`);
    return { resultType: "complete", ...cacheHints, skill: entry, _meta: { ...await releaseMetadata(release, [entry]), ...(canonical !== uri ? { movedFrom: uri } : {}) } };
  });

  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params?.uri ?? "";
    const resource = await readSkillResourceByUri(uri);
    return { resultType: "complete", ...cacheHints, contents: [{ uri, mimeType: resource.mimeType, text: resource.text, blob: resource.blob }] };
  });

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resultType: "complete", ...cacheHints, resources: await listSkillResourcesForClient(),
  }));

  server.server.setRequestHandler(SkillsDirectoryReadRequestSchema, async (request) => ({
    resultType: "complete",
    resources: await readSkillDirectoryByUri(request.params?.uri ?? ""),
  }));
}

function asJsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function registerGisulTools(server: McpServer, identity: () => import("./client-identity.js").ClientIdentity = () => NEUTRAL_IDENTITY): void {
  server.registerTool(
    "skills_list",
    {
      title: "List skills",
      description: "List SKILL.md packages available from skillar.",
      inputSchema: {
        query: z.string().optional().describe("Optional case-insensitive substring filter."),
      },
    },
    async ({ query }) => asJsonText(await listSkills(query)),
  );

  server.registerTool(
    "skills_get",
    {
      title: "Get skill",
      description: "Read a skill's SKILL.md by name.",
      inputSchema: {
        name: z.string().describe("Skill directory name or frontmatter name."),
      },
    },
    async ({ name }) => {
      const skills = await listSkills();
      const selected =
        skills.find((skill) => skill.name === name) ??
        skills.find((skill) => skill.uri.endsWith(`/${encodeURIComponent(name)}`));
      if (!selected) throw new Error(`Skill not found: ${name}`);

      const { record } = parseSkillUri(selected.uri);
      const { markdown, filePath } = await readSkillMarkdown(record);
      const ident = identity();
      return asJsonText({ name: selected.name, source: selected.source, uri: selected.uri, path: filePath, markdown, client: { identity: { kind: ident.kind, name: ident.name ?? null, source: ident.source }, guidance: guidanceFor(ident) } });
    },
  );

  server.registerTool(
    "resources_read",
    {
      title: "Read skill resource",
      description: "Read a skill resource by skill://<authority>/<source>/<skill>/<path> URI.",
      inputSchema: {
        uri: z.string().describe("Resource URI, for example skill://skillar/agents/korean-spell-check/SKILL.md."),
      },
    },
    async ({ uri }) => {
      const { record, relativePath } = parseSkillUri(uri);
      const { text, filePath } = await readSkillResource(record, relativePath);
      const ident = identity();
      return asJsonText({ uri, path: filePath, text, client: { identity: { kind: ident.kind, name: ident.name ?? null, source: ident.source }, guidance: guidanceFor(ident) } });
    },
  );
}

const skillNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const skillMarkdownSchema = z.string().min(1).max(MAX_RESOURCE_BYTES);

function validateSkillMarkdown(markdown: string, name: string): void {
  const frontmatter = parseSkillFrontmatter(markdown);
  if (!frontmatter || frontmatter.name !== name || typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    throw new Error("SKILL.md requires matching name and a nonempty description in YAML frontmatter");
  }
  if (Buffer.byteLength(markdown) > MAX_RESOURCE_BYTES) throw new Error("Skill exceeds the byte limit");
}

async function withSkillWriteLock<T>(source: string, action: (root: string) => Promise<T>): Promise<T> {
  if (HAS_CURRENT || await readRelease()) {
    throw new Error("Published releases are immutable. Edit the iyen-skills Git checkout, validate and commit the draft, then promote a new release. Live create/update cannot modify a release.");
  }
  const configured = SKILL_ROOTS.find(root => root.id === source);
  if (!configured) throw new Error(`Unknown skill source: ${source}`);
  await mkdir(configured.dir, { recursive: true });
  const root = await realpath(configured.dir);
  const lock = path.join(root, ".gisul-write-lock");
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Skill root is busy; reload and retry. A stale .gisul-write-lock requires operator inspection.");
    throw error;
  }
  try { return await action(root); } finally { await rm(lock, { recursive: true }); }
}

async function assertRegularSkillPath(root: string, segments: string[], leaf: "file" | "directory" = "file"): Promise<string> {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch { throw new McpError(ErrorCode.InvalidParams, "Unknown or inaccessible skill resource"); }
    if (info.isSymbolicLink() || (index === segments.length - 1 && leaf === "file" ? !info.isFile() : !info.isDirectory())) {
      throw new McpError(ErrorCode.InvalidParams, "Skill resources require regular files and directories; internal symbolic links are not accessible");
    }
  }
  return current;
}

function registerSkillWriteTools(server: McpServer): void {
  server.registerTool("create_skill", {
    description: "Create a new top-level SKILL.md in a served source. Never overwrites an existing directory. Available over trusted stdio/SSH only.",
    inputSchema: { source: z.string().default(SKILL_ROOTS[0].id), name: skillNameSchema, markdown: skillMarkdownSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ source, name, markdown }) => {
    validateSkillMarkdown(markdown, name);
    return withSkillWriteLock(source, async root => {
      const destination = path.join(root, name);
      try { await lstat(destination); throw new Error("Skill directory already exists; load it and use update_skill"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const staging = await mkdtemp(path.join(root, ".skillar-create-"));
      try {
        await writeFile(path.join(staging, "SKILL.md"), markdown, { flag: "wx", mode: 0o600 });
        await rename(staging, destination);
      } finally { await rm(staging, { recursive: true, force: true }); }
      return asJsonText({ uri: skillUri(source, name, "SKILL.md"), digest: `sha256:${sha256(markdown)}`, created: true });
    });
  });
  server.registerTool("update_skill", {
    description: "Replace an existing SKILL.md by exact URI and expected SHA-256 digest. Preserves supporting files and rejects stale edits. Trusted stdio/SSH only.",
    inputSchema: { uri: z.string(), markdown: skillMarkdownSchema, expected_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ uri, markdown, expected_digest }) => {
    const parsed = parseSkillUriSegments(uri);
    if (!parsed || parsed.pathSegments.length < 2 || parsed.pathSegments.at(-1) !== "SKILL.md" || uri !== skillUri(parsed.source, ...parsed.pathSegments)) {
      throw new Error("Expected an exact canonical SKILL.md URI served by this authority");
    }
    const name = parsed.pathSegments.at(-2)!;
    validateSkillMarkdown(markdown, name);
    return withSkillWriteLock(parsed.source, async root => {
      const target = await assertRegularSkillPath(root, parsed.pathSegments);
      const previous = await readFile(target);
      if (`sha256:${createHash("sha256").update(previous).digest("hex")}` !== expected_digest) throw new Error("Skill changed; load_skill again before editing");
      const entry = await buildSkillEntry(parsed.source, root, parsed.pathSegments.slice(0, -1).join("/"));
      if (!entry) throw new Error("Existing skill is not a valid served skill");
      if (entry.resources.reduce((sum, item) => sum + item.size, 0) - previous.length + Buffer.byteLength(markdown) > MAX_SKILL_TOTAL_BYTES) throw new Error("Skill package exceeds the byte limit");
      const temporary = path.join(path.dirname(target), `.skillar-update-${randomBytes(12).toString("hex")}`);
      try {
        await writeFile(temporary, markdown, { flag: "wx", mode: (await stat(target)).mode & 0o777 });
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
      return asJsonText({ uri, digest: `sha256:${sha256(markdown)}`, updated: true });
    });
  });
}

function createSkillarServer(writable = false, identity: () => import("./client-identity.js").ClientIdentity = () => NEUTRAL_IDENTITY): McpServer {
  const server = new McpServer(
    {
      name: "skillar",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        resources: { listChanged: false },
        extensions: {
          [SKILLS_EXTENSION_ID]: { directoryRead: true },
        },
      },
    },
  );
  registerGisulTools(server, identity);
  if (writable) registerSkillWriteTools(server);
  registerSkillsExtension(server);
  return server;
}

async function readBearerToken(): Promise<string | undefined> {
  const token = process.env.SKILLAR_BEARER_TOKEN ?? process.env.GISUL_BEARER_TOKEN;
  if (token) return token.trim();
  const file = process.env.SKILLAR_BEARER_TOKEN_FILE ?? process.env.GISUL_BEARER_TOKEN_FILE;
  return file ? (await readFile(file, "utf8")).trim() : undefined;
}

async function readAdminToken(bearerToken: string | undefined): Promise<string | undefined> {
  const token = process.env.SKILLAR_ADMIN_TOKEN ?? process.env.GISUL_ADMIN_TOKEN;
  if (token) return token.trim();
  try {
    return (await readFile(ADMIN_TOKEN_FILE, "utf8")).trim();
  } catch {
    return bearerToken;
  }
}

async function isAuthorized(header: string | undefined, bearerToken: string | undefined): Promise<boolean> {
  if (!bearerToken) return true;
  if (!header?.startsWith("Bearer ")) return false;

  const token = header.slice("Bearer ".length);
  if (equalSecret(token, bearerToken)) return true;

  const store = await readTokenStore();
  const tokenHash = sha256(token);
  return store.tokens.some((record) => !record.revokedAt && equalSecret(record.tokenHash, tokenHash));
}

function hasAdminCookie(req: Request, adminToken: string | undefined): boolean {
  if (!adminToken) return true;
  const cookies = req.headers.cookie?.split(";").map((value) => value.trim()) ?? [];
  const cookie = cookies.find((value) => (value.startsWith("skillar_admin=") || value.startsWith("gisul_admin=")));
  if (!cookie) return false;
  return equalSecret(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)), adminToken);
}

function requireAdmin(req: Request, res: Response, adminToken: string | undefined): boolean {
  if (hasAdminCookie(req, adminToken)) return true;
  res.status(303).set("Location", "/dashboard/login").end();
  return false;
}

async function createTokenRequest(req: Request, res: Response): Promise<void> {
  const id = randomToken("req_");
  const claimToken = randomToken("claim_");
  const now = new Date().toISOString();
  const store = await readTokenRequestStore();

  const record: TokenRequestRecord = {
    id,
    claimHash: sha256(claimToken),
    status: "pending",
    label: sanitizeText(req.body?.label, "unnamed-client", 80),
    note: sanitizeText(req.body?.note, "", 500),
    requester: getRequester(req),
    createdAt: now,
  };
  store.requests.unshift(record);
  await writeTokenRequestStore(store);

  res.status(201).json({
    requestId: id,
    claimToken,
    status: "pending",
    statusUrl: `/auth/token-requests/${encodeURIComponent(id)}?claim_token=${encodeURIComponent(claimToken)}`,
    dashboardUrl: "/dashboard",
  });
}

async function getTokenRequest(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? "");
  const claimToken = String(req.query.claim_token ?? req.headers["x-skillar-claim-token"] ?? req.headers["x-gisul-claim-token"] ?? "");
  const store = await readTokenRequestStore();
  const record = store.requests.find((request) => request.id === id);

  if (!record || !claimToken || !equalSecret(record.claimHash, sha256(claimToken))) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  if (record.status === "approved" && record.tokenPlaintext) {
    const token = record.tokenPlaintext;
    record.status = "delivered";
    record.deliveredAt = new Date().toISOString();
    delete record.tokenPlaintext;
    await writeTokenRequestStore(store);
    res.json({ requestId: record.id, status: "approved", bearerToken: token });
    return;
  }

  res.json({ requestId: record.id, status: record.status });
}

async function approveTokenRequest(id: string): Promise<void> {
  const requestStore = await readTokenRequestStore();
  const request = requestStore.requests.find((candidate) => candidate.id === id);
  if (!request) throw new Error(`Request not found: ${id}`);
  if (request.status !== "pending") return;

  const token = randomToken("skp_");
  const tokenId = randomToken("tok_");
  const now = new Date().toISOString();
  const tokenStore = await readTokenStore();

  tokenStore.tokens.unshift({
    id: tokenId,
    tokenHash: sha256(token),
    prefix: token.slice(0, 12),
    label: request.label,
    note: request.note,
    requestId: request.id,
    requester: request.requester,
    createdAt: now,
  });

  request.status = "approved";
  request.approvedAt = now;
  request.tokenId = tokenId;
  request.tokenPlaintext = token;

  await writeTokenStore(tokenStore);
  await writeTokenRequestStore(requestStore);
}

async function denyTokenRequest(id: string): Promise<void> {
  const store = await readTokenRequestStore();
  const request = store.requests.find((candidate) => candidate.id === id);
  if (!request) throw new Error(`Request not found: ${id}`);
  if (request.status !== "pending") return;
  request.status = "denied";
  request.deniedAt = new Date().toISOString();
  await writeTokenRequestStore(store);
}

async function revokeToken(tokenId: string): Promise<void> {
  const store = await readTokenStore();
  const token = store.tokens.find((candidate) => candidate.id === tokenId);
  if (!token) throw new Error(`Token not found: ${tokenId}`);
  if (!token.revokedAt) token.revokedAt = new Date().toISOString();
  await writeTokenStore(store);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #0f172a; color: #e5e7eb; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 28px; margin: 0 0 20px; }
    h2 { font-size: 18px; margin: 28px 0 12px; }
    form { display: inline; }
    input, textarea { width: 100%; box-sizing: border-box; margin: 6px 0 14px; padding: 10px 12px; border-radius: 6px; border: 1px solid #334155; background: #020617; color: #e5e7eb; }
    button, .button { display: inline-block; margin: 2px 4px 2px 0; padding: 8px 12px; border: 0; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; text-decoration: none; }
    button.danger { background: #b91c1c; }
    button.secondary { background: #475569; }
    table { width: 100%; border-collapse: collapse; background: #111827; border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px; border-bottom: 1px solid #334155; text-align: left; vertical-align: top; font-size: 14px; }
    th { background: #1f2937; }
    code { color: #bfdbfe; }
    .muted { color: #94a3b8; }
    .panel { background: #111827; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

async function showRequestForm(_req: Request, res: Response): Promise<void> {
  res.type("html").send(
    page(
      "Request Skillar Token",
      `<h1>Request Token</h1>
      <form method="post" action="/auth/token-requests">
        <label>Client label<input name="label" placeholder="my laptop, claude desktop, test client"></label>
        <label>Note<textarea name="note" rows="4" placeholder="Why this token is needed"></textarea></label>
        <button type="submit">Create Request</button>
      </form>`,
    ),
  );
}

async function showDashboardLogin(_req: Request, res: Response): Promise<void> {
  res.type("html").send(
    page(
      "Skillar Login",
      `<h1>Skillar Admin</h1>
      <form method="post" action="/dashboard/login" class="panel">
        <label>Admin token<input name="token" type="password" autocomplete="current-password"></label>
        <button type="submit">Log in</button>
      </form>`,
    ),
  );
}

async function handleDashboardLogin(req: Request, res: Response, adminToken: string | undefined): Promise<void> {
  const submitted = sanitizeText(req.body?.token, "", 4096);
  if (!adminToken || !submitted || !equalSecret(submitted, adminToken)) {
    res.status(401).type("html").send(page("Unauthorized", `<h1>Unauthorized</h1><a class="button" href="/dashboard/login">Retry</a>`));
    return;
  }

  res
    .status(303)
    .set("Set-Cookie", `skillar_admin=${encodeURIComponent(adminToken)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`)
    .set("Location", "/dashboard")
    .end();
}

async function showDashboard(req: Request, res: Response, adminToken: string | undefined): Promise<void> {
  if (!requireAdmin(req, res, adminToken)) return;

  const [requestStore, tokenStore] = await Promise.all([readTokenRequestStore(), readTokenStore()]);
  const requests = requestStore.requests.slice(0, 100);
  const tokens = tokenStore.tokens.slice(0, 100);

  const requestRows = requests
    .map(
      (request) => `<tr>
        <td><code>${escapeHtml(request.id)}</code><div class="muted">${escapeHtml(request.requester)}</div></td>
        <td>${escapeHtml(request.label)}<div class="muted">${escapeHtml(request.note)}</div></td>
        <td>${escapeHtml(request.status)}<div class="muted">${escapeHtml(request.createdAt)}</div></td>
        <td>
          ${
            request.status === "pending"
              ? `<form method="post" action="/dashboard/requests/${encodeURIComponent(request.id)}/approve"><button type="submit">Approve</button></form>
                 <form method="post" action="/dashboard/requests/${encodeURIComponent(request.id)}/deny"><button class="danger" type="submit">Deny</button></form>`
              : ""
          }
        </td>
      </tr>`,
    )
    .join("");

  const tokenRows = tokens
    .map(
      (token) => `<tr>
        <td><code>${escapeHtml(token.id)}</code><div class="muted">${escapeHtml(token.prefix)}...</div></td>
        <td>${escapeHtml(token.label)}<div class="muted">${escapeHtml(token.note)}</div></td>
        <td>${escapeHtml(token.revokedAt ? "revoked" : "active")}<div class="muted">${escapeHtml(token.createdAt)}</div></td>
        <td>${
          token.revokedAt
            ? ""
            : `<form method="post" action="/dashboard/tokens/${encodeURIComponent(token.id)}/revoke"><button class="danger" type="submit">Revoke</button></form>`
        }</td>
      </tr>`,
    )
    .join("");

  res.type("html").send(
    page(
      "Skillar Dashboard",
      `<h1>Skillar Dashboard</h1>
      <p><a class="button secondary" href="/auth/request">Open request form</a></p>
      <h2>Requests</h2>
      <table>
        <thead><tr><th>Request</th><th>Client</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${requestRows || `<tr><td colspan="4" class="muted">No requests</td></tr>`}</tbody>
      </table>
      <h2>Issued Tokens</h2>
      <table>
        <thead><tr><th>Token</th><th>Client</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${tokenRows || `<tr><td colspan="4" class="muted">No issued tokens</td></tr>`}</tbody>
      </table>`,
    ),
  );
}

async function startStdio(): Promise<void> {
  const envIdentity = identityFromEnv();
  const broker = new ServerProtocolTransport(new StdioServerTransport());
  const identity: () => import("./client-identity.js").ClientIdentity = () => envIdentity ?? { kind: classifyClientName(broker.clientIdentity?.name), name: broker.clientIdentity?.name, version: broker.clientIdentity?.version, source: broker.clientIdentity ? "initialize" : "unknown" };
  const server = createSkillarServer(true, identity);
  await server.connect(broker);
}

async function startHttp(): Promise<void> {
  const bearerToken = await readBearerToken();
  const adminToken = await readAdminToken(bearerToken);
  const port = Number(process.env.PORT ?? DEFAULT_HTTP_PORT);
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHosts = ((process.env.SKILLAR_ALLOWED_HOSTS ?? process.env.GISUL_ALLOWED_HOSTS) ?? "127.0.0.1,localhost")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const app = createMcpExpressApp({ host, allowedHosts });
  app.use(express.urlencoded({ extended: false }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, service: "skillar" });
  });

  app.get("/auth/request", showRequestForm);
  app.post("/auth/token-requests", createTokenRequest);
  app.get("/auth/token-requests/:id", getTokenRequest);

  app.get("/dashboard/login", showDashboardLogin);
  app.post("/dashboard/login", async (req: Request, res: Response) => {
    await handleDashboardLogin(req, res, adminToken);
  });
  app.get("/dashboard", async (req: Request, res: Response) => {
    await showDashboard(req, res, adminToken);
  });
  app.post("/dashboard/requests/:id/approve", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res, adminToken)) return;
    await approveTokenRequest(String(req.params.id));
    res.status(303).set("Location", "/dashboard").end();
  });
  app.post("/dashboard/requests/:id/deny", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res, adminToken)) return;
    await denyTokenRequest(String(req.params.id));
    res.status(303).set("Location", "/dashboard").end();
  });
  app.post("/dashboard/tokens/:id/revoke", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res, adminToken)) return;
    await revokeToken(String(req.params.id));
    res.status(303).set("Location", "/dashboard").end();
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    if (!(await isAuthorized(req.headers.authorization, bearerToken))) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const meta = req.body?.params?._meta;
    const modern = req.body?.method === "server/discover" || meta?.[VERSION_KEY] !== undefined || meta?.[CAPS_KEY] !== undefined || (req.get("MCP-Protocol-Version") ?? "") >= MODERN_VERSION;
    if (modern) {
      const fail = (code: number, message: string) => res.status(400).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code, message } });
      const origin = req.get("Origin");
      if (origin) {
        let hostname = ""; try { hostname = new URL(origin).hostname; } catch { /* invalid origin */ }
        if (!allowedHosts.includes(hostname)) { res.status(403).json({ error: "Invalid origin" }); return; }
      }
      if (!(req.get("Accept")?.includes("application/json") && req.get("Accept")?.includes("text/event-stream"))) { res.status(406).end(); return; }
      const parsed = JSONRPCRequestSchema.safeParse(req.body);
      if (!parsed.success) { fail(-32600, "Invalid JSON-RPC request"); return; }
      if (!meta || typeof meta[VERSION_KEY] !== "string" || typeof meta[CAPS_KEY] !== "object" || !meta[CAPS_KEY] || Array.isArray(meta[CAPS_KEY])) { fail(-32602, "Required request metadata is missing"); return; }
      const named = ["tools/call", "resources/read", "prompts/get"].includes(parsed.data.method);
      if (req.get("MCP-Protocol-Version") !== meta[VERSION_KEY] || req.get("Mcp-Method") !== parsed.data.method || (named && decodeHeader(req.get("Mcp-Name")) !== (parsed.data.params?.name ?? parsed.data.params?.uri))) { fail(-32020, "Request headers do not match the body"); return; }
      const server = createSkillarServer();
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const transport: Transport = {
        start: async () => {}, close: async () => { transport.onclose?.(); },
        send: async message => {
          if (!("id" in message) || message.id !== parsed.data.id) return;
          const code = "error" in message ? message.error.code : undefined;
          res.status(code === -32601 ? 404 : code === -32603 ? 500 : code ? 400 : 200).set("Cache-Control", "no-store").json(message);
          finish();
        },
      };
      res.on("close", finish);
      try {
        await server.connect(new ServerProtocolTransport(transport));
        transport.onmessage?.(parsed.data);
        await done;
      } finally { await server.close(); }
      return;
    }
    const server = createSkillarServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(new ServerProtocolTransport(transport, true));
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });

  app.all("/mcp", (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  const listener = app.listen(port, host, (error?: Error) => {
    if (error) {
      console.error("Failed to start HTTP MCP server:", error);
      process.exit(1);
    }
    const address = listener.address();
    console.error(`skillar listening on http://${host}:${typeof address === "object" && address ? address.port : port}/mcp`);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--http")) {
    await startHttp();
    return;
  }
  await startStdio();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

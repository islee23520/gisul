// Read-only live smoke. Requires this installed bundle's completed OAuth login.
// Uses OpenClaw's actual MCP runtime, with only this bundle and an empty workspace
// so an existing Codex MCP connection cannot accidentally satisfy the checks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--openclaw-root" || args[2] !== "--plugin-root") {
  throw new Error("Usage: node scripts/check-openclaw-live.mjs --openclaw-root /path/to/openclaw --plugin-root /profile/extensions/gisul-openclaw");
}
const openclaw = resolve(args[1]), plugin = await realpath(resolve(args[3]));
const workspace = await mkdtemp(join(tmpdir(), "gisul-openclaw-live-"));
const cfg = { plugins: { allow: ["gisul-openclaw"], load: { paths: [plugin] }, entries: { "gisul-openclaw": { enabled: true } } } };
const sha = value => "sha256:" + createHash("sha256").update(value).digest("hex");
let runtime;
try {
  // These private imports belong only to the compatibility test, never the plugin.
  let loadMcp;
  for (const file of await readdir(join(openclaw, "dist"))) {
    if (!file.startsWith("bundle-mcp-") || !file.endsWith(".js")) continue;
    const module = await import(pathToFileURL(join(openclaw, "dist", file)).href);
    loadMcp = Object.values(module).find(fn => typeof fn === "function" && fn.name === "loadEnabledBundleMcpConfig");
    if (loadMcp) break;
  }
  assert.ok(loadMcp, "This OpenClaw build needs an updated live smoke adapter");
  const loaded = loadMcp({ cfg, workspaceDir: workspace });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(Object.keys(loaded.config.mcpServers), ["gisul"]);
  assert.equal(await realpath(loaded.config.mcpServers.gisul.args[0]), join(plugin, "scripts/bridge.mjs"));
  const { createSessionMcpRuntime } = await import(pathToFileURL(join(openclaw, "dist/agents/agent-bundle-mcp-runtime.js")).href);
  runtime = createSessionMcpRuntime({ sessionId: `gisul-live-${Date.now()}`, workspaceDir: workspace, cfg });
  const catalog = await runtime.getCatalog();
  assert.deepEqual(catalog.diagnostics ?? [], [], "MCP connection must succeed");
  assert.deepEqual(Object.keys(catalog.servers), ["gisul"]);
  const tools = catalog.tools.map(tool => tool.toolName).sort();
  assert.deepEqual(tools, ["load_skill", "read_skill_file", "search_skills"]);
  const call = async (name, input) => {
    const result = await runtime.callTool("gisul", name, input);
    assert.ok(!result.isError, `${name} returned an MCP error`);
    const text = result.content.find(item => item.type === "text")?.text;
    assert.ok(text, `${name} must return content`);
    return JSON.parse(text);
  };
  const search = await call("search_skills", { mode: "discovery", query: "시안 비교", limit: 5 });
  assert.ok(search.commit && search.skills.length > 0);
  const chosen = search.skills.find(skill => skill.name === "dont-make-me-think");
  assert.ok(chosen, "Live test fixture must appear in discovery results");
  const skill = await call("load_skill", { uri: chosen.uri, commit: search.commit });
  assert.equal(skill.commit, search.commit);
  assert.equal(skill.uri, chosen.uri);
  assert.equal(sha(skill.markdown), skill.digest);
  const uri = skill.files.find(uri => uri.includes("/references/") && uri.endsWith(".md"));
  assert.ok(uri, "Live fixture must declare a supporting Markdown file");
  const support = await call("read_skill_file", { uri, skill_uri: skill.skill_uri, load_id: skill.load_id });
  assert.equal(support.commit, search.commit);
  assert.equal(support.uri, uri);
  assert.equal(sha(support.text), support.digest);
  const version = JSON.parse(await readFile(join(openclaw, "package.json"), "utf8")).version;
  console.log(JSON.stringify({
    verified: true, observed_at: new Date().toISOString(), openclaw_version: version,
    connection: "installed bundle through native OpenClaw MCP runtime; no inherited Codex MCP config",
    tools, search: { query: "시안 비교", matches: search.totalMatches },
    release: search.release, commit: search.commit,
    skill: { uri: skill.uri, digest: skill.digest, digest_verified: true },
    supporting_file: { uri, digest: support.digest, digest_verified: true },
    credential_contents_logged: false,
  }, null, 2));
} finally {
  await runtime?.dispose();
  await rm(workspace, { recursive: true, force: true });
}

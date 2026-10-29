import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { distImport, makeSandbox } from "./_helpers.mjs";
import { event, openStore } from "./helpers/store.mjs";
import { fixture } from "./helpers/ingest.mjs";
import { call, modernClient, uriOf, withDaemon } from "./helpers/mcp.mjs";

const { resolveSkillarHome, loadConfig, dbPath } = await distImport("config.js");
const { openDb } = await distImport("store/db.js");
const { makeCliDeps, planService, packageRoot } = await distImport("cli/serve.js");
const { codexPack } = await distImport("packs/codex.js");
const { claudeCodePack } = await distImport("packs/claude-code.js");
const { geminiPack } = await distImport("packs/gemini.js");
const { cursorPack } = await distImport("packs/cursor.js");
const { omoPack } = await distImport("packs/omo.js");
const { openclawPack } = await distImport("packs/openclaw.js");
const { parseOtlpLogs } = await distImport("ingest/otlp.js");
const { normalizeHook } = await distImport("ingest/hooks.js");
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const context = sb => ({ home: sb.home, env: sb.env, port: 8799, token: "migration-token", nodePath: process.execPath, packageRoot: packageRoot(), disableRemote: false });

test("upgrade reopens legacy token, config, backups and SQLite history without creating a parallel store", () => {
  const sb = makeSandbox();
  try {
    const env = { ...sb.env }; delete env.SKILLAR_HOME;
    const home = join(sb.home, ".gisool"), token = "a".repeat(64);
    put(join(home, "token"), token + "\n");
    const configText = JSON.stringify({ roots: [{ id: "gisul", path: "~/gisul/skills" }], port: 8921 });
    put(join(home, "config.json"), configText);
    put(join(home, "backups", "old", "manifest.json"), '{"status":"applied"}');
    const db = openDb(join(home, "gisool.db"));
    db.prepare("INSERT INTO sessions(id,runtime,runtime_session_id,started_at,first_prompt) VALUES ('historical','codex','thread-old',100,'keep history')").run();
    db.close();
    const deps = makeCliDeps(env), store = deps.openStore();
    try {
      assert.equal(deps.skillarHome, home);
      assert.equal(deps.config.port, 8921);
      assert.equal(store.upsertSession({ runtime: "codex", runtimeSessionId: "thread-old" }, 100), "historical");
      assert.equal(deps.config.roots[0].id, "gisul");
    } finally { store.close(); }
    assert.equal(readFileSync(join(home, "token"), "utf8"), token + "\n");
    assert.equal(readFileSync(join(home, "config.json"), "utf8"), configText);
    assert.equal(readFileSync(join(home, "backups", "old", "manifest.json"), "utf8"), '{"status":"applied"}');
    assert.equal(existsSync(join(home, "skillar.db")), false);
    assert.equal(existsSync(join(sb.home, ".skillar")), false);
  } finally { sb.cleanup(); }
});

test("home precedence honors explicit prefixes and configured new home; ambiguous database files are refused", () => {
  const sb = makeSandbox();
  try {
    const env = { HOME: sb.home }, legacy = join(sb.home, ".gisool"), current = join(sb.home, ".skillar");
    mkdirSync(legacy); mkdirSync(current);
    assert.equal(resolveSkillarHome(env), legacy, "an empty new directory does not hide old history");
    put(join(current, "config.json"), "{}");
    assert.equal(resolveSkillarHome(env), current);
    assert.equal(resolveSkillarHome({ ...env, GISOOL_HOME: legacy }), legacy);
    assert.equal(resolveSkillarHome({ ...env, GISOOL_HOME: legacy, SKILLAR_HOME: current }), current);
    put(join(current, "gisool.db"), "legacy"); put(join(current, "skillar.db"), "new");
    assert.throws(() => dbPath(current), /Both skillar.db and gisool.db/);
    assert.equal(readFileSync(join(current, "gisool.db"), "utf8"), "legacy");
  } finally { sb.cleanup(); }
});

test("legacy managed Codex block is replaced once, preserving user tables and idempotence", async () => {
  const sb = makeSandbox();
  try {
    const ctx = context(sb), path = join(sb.home, ".codex/config.toml");
    const fresh = (await codexPack.plan(ctx)).files[0].after;
    put(path, 'model = "user-model"\n' + fresh.replaceAll("skillar", "gisool"));
    const plan = await codexPack.plan(ctx);
    assert.deepEqual(plan.conflicts, []);
    const text = plan.files[0].after;
    assert.equal((text.match(/\[otel\]/g) ?? []).length, 1);
    assert.equal((text.match(/\[mcp_servers\./g) ?? []).length, 1);
    assert.match(text, /model = "user-model"/);
    put(path, text);
    assert.equal((await codexPack.plan(ctx)).files.length, 0);
  } finally { sb.cleanup(); }
});

test("legacy service definitions are updated in place with matching unload/start identity", () => {
  const sb = makeSandbox();
  try {
    for (const [platform, path, identity] of [["darwin", "Library/LaunchAgents/dev.gisool.daemon.plist", "dev.gisool.daemon"], ["linux", ".config/systemd/user/gisool.service", "gisool.service"]]) {
      put(join(sb.home, path), "old service");
      const plan = planService({ ...context(sb), skillarHome: join(sb.home, ".gisool"), env: {}, platform, uid: 501 });
      assert.equal(plan.file.path, join(sb.home, path));
      assert.match(plan.file.after, /SKILLAR_HOME/);
      assert.ok(plan.commands.some(c => c.argv.some(a => a.endsWith(identity))));
      assert.equal(plan.commands.some(c => c.argv.some(a => a.includes("dev.skillar.daemon") || a === "skillar.service")), false);
    }
  } finally { sb.cleanup(); }
});

test("old managed JSON MCP keys and extension directories stay single across repeated init", async () => {
  const sb = makeSandbox();
  try {
    for (const [pack, path, entry] of [[geminiPack, ".gemini/settings.json", { httpUrl: "http://127.0.0.1:8799/mcp" }], [cursorPack, ".cursor/mcp.json", { url: "http://127.0.0.1:8799/mcp" }], [omoPack, ".omo/agent/mcp.json", { url: "http://127.0.0.1:8799/mcp" }]]) {
      put(join(sb.home, path), JSON.stringify({ mcpServers: { gisool: entry, other: { command: "keep" } } }));
      if (pack === omoPack) put(join(sb.home, ".omo/agent/extensions/gisool/index.js"), "old extension");
      for (let run = 0; run < 2; run++) {
        const plan = await pack.plan(context(sb)); assert.deepEqual(plan.conflicts, []);
        for (const f of plan.files) put(f.path, f.after);
        const servers = JSON.parse(readFileSync(join(sb.home, path), "utf8")).mcpServers;
        assert.deepEqual(Object.keys(servers).sort(), ["gisool", "other"]);
      }
    }
    assert.equal(existsSync(join(sb.home, ".omo/agent/extensions/skillar")), false);
  } finally { sb.cleanup(); }
});

test("old Claude hooks are replaced once and old local registration keeps its name", async () => {
  const sb = makeSandbox();
  try {
    const path = join(sb.home, ".claude/settings.json");
    put(join(sb.home, ".claude.json"), JSON.stringify({ mcpServers: { gisool: { url: "http://127.0.0.1:8799/mcp" } } }));
    put(path, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Skill|mcp__gisool__.*", hooks: [{ type: "command", command: 'node "/old/gisool/packs/hook-post.mjs" claude-code' }] }] } }));
    for (let run = 0; run < 2; run++) {
      const plan = await claudeCodePack.plan(context(sb)); assert.deepEqual(plan.conflicts, []);
      for (const f of plan.files) put(f.path, f.after);
      assert.ok(plan.notes.some(n => n.includes("scope user gisool http")));
      const groups = JSON.parse(readFileSync(path, "utf8")).hooks.PostToolUse;
      assert.equal(groups.length, 1); assert.match(groups[0].matcher, /gisool/);
      assert.ok(groups[0].hooks[0].command.includes(join(packageRoot(), "packs/hook-post.mjs")));
    }
  } finally { sb.cleanup(); }
});

test("legacy OpenClaw plugin and hook IDs are retained rather than adding a second plugin", async () => {
  const sb = makeSandbox();
  try {
    put(join(sb.home, ".openclaw/openclaw.json"), JSON.stringify({ plugins: { entries: { gisool: { hooks: { allowConversationAccess: true } } } } }));
    const ctx = context(sb); delete ctx.env.SKILLAR_NO_CLI;
    const plan = await openclawPack.plan(ctx);
    assert.equal(JSON.parse(plan.files.find(f => f.path.endsWith("openclaw.plugin.json")).after).id, "gisool");
    assert.ok(plan.files.some(f => f.path.includes("hooks/gisool-discovery/")));
    assert.equal(plan.files.some(f => f.path.includes("hooks/skillar-discovery/")), false);
    assert.deepEqual(plan.commands[0].undo.argv, ["openclaw", "plugins", "uninstall", "gisool"]);
    assert.ok((await openclawPack.doctorChecks(ctx)).some(c => c.name === "allowConversationAccess" && c.ok));
  } finally { sb.cleanup(); }
});

test("old MCP telemetry names still bind tools without recording duplicate skill reads", () => {
  for (const name of ["skillar", "gisool"]) {
    const body = JSON.parse(JSON.stringify(fixture("claude-otlp-tool-result-skillar-mcp.json")).replaceAll("skillar", name));
    const parsed = parseOtlpLogs(body, Date.now());
    assert.equal(parsed.ok, true); assert.deepEqual(parsed.events.map(e => e.kind), ["tool_call"]);
    assert.equal(parsed.events[0].data.skillarMcp, true);
    const hook = normalizeHook("claude-code", { hook_event_name: "PostToolUse", session_id: "old-session", tool_name: `mcp__${name}__search_skills`, tool_use_id: "old-tool" }, Date.now());
    assert.equal(hook.bindings.length, 1); assert.equal(hook.events.length, 0);
  }
});

test("historical gisoolMcp payloads still reconcile to the original session without rewriting evidence", () => {
  const { db, store } = openStore();
  try {
    const ref = { runtime: "codex", runtimeSessionId: "old-thread" };
    const id = store.upsertSession(ref, 1000), uri = "skill://local/gisul/alpha/SKILL.md";
    const tool = event("tool_call", 1001, ref, { source: "otel", text: JSON.stringify({ uri }), data: { gisoolMcp: true } });
    store.append(tool, { sessionId: id, method: "runtime_id" });
    const load = event("load", 1002, ref, { skillUri: uri, data: { attributionCandidates: [id] } });
    store.append(load, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
    store.reconcileLoads({ eventId: load.id });
    assert.equal(db.prepare("SELECT session_id FROM events WHERE id=?").get(load.id).session_id, id);
    assert.equal(JSON.parse(db.prepare("SELECT data_json FROM events WHERE id=?").get(tool.id).data_json).gisoolMcp, true);
  } finally { store.close(); }
});

test("legacy trace metadata joins a resource read to its original search", () => withDaemon(async daemon => {
  const client = modernClient(daemon.port);
  const result = await call(client, "search_skills", { query: "pull request review", mode: "discovery" }, { threadId: "migration-thread" });
  await client.readResource({ uri: uriOf("pr-review"), _meta: { "app.gisool/traceId": result.body.trace_id } });
  assert.equal(daemon.rows().find(r => r.kind === "load").trace_id, result.body.trace_id);
}));

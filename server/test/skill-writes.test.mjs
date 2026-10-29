import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const server = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const markdown = (name, body = "Original") => `---\nname: ${name}\ndescription: Test flow\n---\n${body}\n`;
const data = result => { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
async function connect(root) {
  const client = new Client({ name: "write-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, SKILLAR_ROOT: root, SKILLAR_SKILLS_DIRS: root } }));
  return client;
}
test("writes round-trip, preserve supporting files and reject duplicates, stale edits and unsafe paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillar-writes-"));
  const client = await connect(root);
  const call = (name, args) => client.callTool({ name, arguments: args });
  try {
    const created = data(await call("create_skill", { name: "flow", markdown: markdown("flow") }));
    assert.equal(created.uri, "skill://skillar/root0/flow/SKILL.md");
    assert.equal((await client.readResource({ uri: created.uri })).contents[0].text, markdown("flow"));
    assert.equal((await call("create_skill", { name: "flow", markdown: markdown("flow", "Overwritten") })).isError, true);
    assert.equal((await call("create_skill", { name: "other", markdown: markdown("wrong") })).isError, true);
    assert.equal((await call("create_skill", { name: "../escape", markdown: markdown("escape") })).isError, true);
    assert.equal((await call("create_skill", { source: "unknown", name: "other", markdown: markdown("other") })).isError, true);
    await writeFile(join(root, "flow/guide.md"), "Keep me");
    const changed = markdown("flow", "Updated");
    const updated = data(await call("update_skill", { uri: created.uri, expected_digest: created.digest, markdown: changed }));
    assert.notEqual(updated.digest, created.digest);
    assert.equal(await readFile(join(root, "flow/guide.md"), "utf8"), "Keep me");
    assert.equal((await call("update_skill", { uri: created.uri, expected_digest: created.digest, markdown: markdown("flow") })).isError, true);
    for (const uri of [created.uri.replace("skillar/", "foreign/"), "skill://skillar/root0/%2e%2e/flow/SKILL.md", created.uri + "?x=1"]) {
      assert.equal((await call("update_skill", { uri, expected_digest: updated.digest, markdown: changed })).isError, true);
    }
    await symlink(join(root, "flow"), join(root, "alias"));
    assert.equal((await call("update_skill", { uri: "skill://skillar/root0/alias/SKILL.md", expected_digest: updated.digest, markdown: markdown("alias") })).isError, true);
    await mkdir(join(root, "file-link"));
    await symlink(join(root, "flow/SKILL.md"), join(root, "file-link/SKILL.md"));
    assert.equal((await call("update_skill", { uri: "skill://skillar/root0/file-link/SKILL.md", expected_digest: updated.digest, markdown: markdown("file-link") })).isError, true);
    assert.equal(await readFile(join(root, "flow/SKILL.md"), "utf8"), changed);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
test("independent server processes cannot both overwrite the same version", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillar-race-"));
  const clients = await Promise.all([connect(root), connect(root)]);
  try {
    const created = data(await clients[0].callTool({ name: "create_skill", arguments: { name: "flow", markdown: markdown("flow") } }));
    const results = await Promise.all(clients.map((client, index) => client.callTool({ name: "update_skill", arguments: {
      uri: created.uri, expected_digest: created.digest, markdown: markdown("flow", `Writer ${index}`),
    } })));
    assert.equal(results.filter(result => !result.isError).length, 1);
    const winner = results.findIndex(result => !result.isError);
    assert.equal(await readFile(join(root, "flow/SKILL.md"), "utf8"), markdown("flow", `Writer ${winner}`));
  } finally { await Promise.all(clients.map(client => client.close())); await rm(root, { recursive: true, force: true }); }
});
test("authenticated public HTTP remains read-only", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "skillar-http-write-"));
  const child = spawn(process.execPath, [server, "--http"], { env: { ...process.env, PORT: "0", HOST: "127.0.0.1", SKILLAR_ROOT: root, SKILLAR_STATE_DIR: join(root, "state"), SKILLAR_SKILLS_DIRS: root, SKILLAR_BEARER_TOKEN: "fixture-read-token", SKILLAR_ADMIN_TOKEN: "fixture-admin-token" }, stdio: ["ignore", "ignore", "pipe"] });
  const client = new Client({ name: "http-test", version: "1" });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = "";
      child.stderr.on("data", chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/mcp/); if (match) resolve(match[0]); });
      child.on("error", reject);
      child.on("exit", () => reject(new Error("HTTP server exited")));
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer fixture-read-token" } } }));
    const tools = await client.listTools();
    assert.ok(!tools.tools.some(tool => ["create_skill", "update_skill"].includes(tool.name)));
    assert.equal((await client.callTool({ name: "create_skill", arguments: { name: "flow", markdown: markdown("flow") } })).isError, true);
  } finally { await client.close(); child.kill(); await rm(root, { recursive: true, force: true }); }
});

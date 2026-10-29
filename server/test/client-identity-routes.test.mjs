import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const SKILL_MD = `---
name: flow
description: Test skill
---

Body stays untouched.
`;
const REF_MD = "reference body";

function startRpc(name, env) {
  const child = spawn(process.execPath, [DIST], { stdio: ["pipe", "pipe", "pipe"], env });
  const pending = new Map();
  let nextId = 0;
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}: ${JSON.stringify(message.error.data ?? "")}`));
        else resolve(message.result);
      }
    }
  });
  child.stderr.on("data", () => {});
  return {
    child,
    call(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async initialize() {
      await this.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name, version: "0.0.0" } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        child.kill();
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 2000);
      });
    },
  };
}

test("broker metadata: tools/call resources_read + skills_get/schema preservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gisul-broker6-"));
  await mkdir(join(root, "flow", "references"), { recursive: true });
  await writeFile(join(root, "flow", "SKILL.md"), SKILL_MD);
  await writeFile(join(root, "flow", "references", "ref.md"), REF_MD);

  const env = { ...process.env, SKILLAR_SKILL_ROOTS: `root0=${root}`, SKILLAR_STATE_DIR: join(root, ".state") };
  const codex = startRpc("codex_cli", env);
  const unknown = startRpc("mystery-agent", env);

  try {
    await codex.initialize();
    await unknown.initialize();

    const listRes = await codex.call("tools/call", { name: "skills_list", arguments: {} });
    const entries = JSON.parse(listRes.content[0].text);
    const flow = entries.find((entry) => entry.name === "flow");
    assert.ok(flow, "flow listed via skills_list");
    const flowUri = flow.uri;

    const rr = await codex.call("tools/call", { name: "resources_read", arguments: { uri: `${flowUri}/references/ref.md` } });
    const rrBody = JSON.parse(rr.content[0].text);
    assert.equal(rrBody.text, REF_MD);
    assert.equal(rrBody.client.identity.kind, "codex");
    assert.equal(rrBody.client.guidance.imageGeneration, "client-tool");

    const rr2 = await unknown.call("tools/call", { name: "resources_read", arguments: { uri: `${flowUri}/references/ref.md` } });
    const rr2Body = JSON.parse(rr2.content[0].text);
    assert.equal(rr2Body.text, REF_MD);
    assert.equal(rr2Body.client.identity.kind, "unknown");
    assert.equal(rr2Body.client.guidance.imageGeneration, "unknown");

    const ext = await codex.call("skills/get", { uri: `${flowUri}/SKILL.md` });
    assert.equal(ext.skill.frontmatter.name, "flow");
    assert.equal(ext.skill.frontmatter.description, "Test skill");
    assert.equal(ext.client, undefined);
    assert.equal(ext.skill._clientGuidance, undefined);
  } finally {
    await codex.stop();
    await unknown.stop();
    await rm(root, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const SKILL_MD = `---
name: flow
description: Test skill
---

Body stays untouched.
`;

async function connect(root, name, env = {}) {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { ...process.env, GISUL_ROOT: root, GISUL_SKILLS_DIRS: root, ...env },
  }));
  return client;
}

test("client-aware guide broker reports identity and guidance per connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "gisul-broker-"));
  await mkdir(join(root, "flow"), { recursive: true });
  await writeFile(join(root, "flow", "SKILL.md"), SKILL_MD);

  const codex = await connect(root, "codex_cli");
  const omp = await connect(root, "oh-my-pi");
  const hinted = await connect(root, "whatever", { GISUL_CLIENT_HINT: "omp" });
  const unknown = await connect(root, "mystery-agent");
  const clients = [codex, omp, hinted, unknown];

  try {
    const get = async (client) => JSON.parse((await client.callTool({ name: "skills_get", arguments: { name: "flow" } })).content[0].text);

    const codexResult = await get(codex);
    assert.equal(codexResult.client.identity.kind, "codex");
    assert.equal(codexResult.client.identity.source, "initialize");
    assert.equal(codexResult.client.guidance.imageGeneration, "client-tool");
    assert.match(codexResult.client.guidance.imageToolHint, /image_gen/);

    const ompResult = await get(omp);
    assert.equal(ompResult.client.identity.kind, "omp");
    assert.equal(ompResult.client.guidance.imageToolHint, "xd://generate_image device");

    const hintedResult = await get(hinted);
    assert.equal(hintedResult.client.identity.kind, "omp");
    assert.equal(hintedResult.client.identity.source, "env-hint");

    const unknownResult = await get(unknown);
    assert.equal(unknownResult.client.identity.kind, "unknown");
    assert.equal(unknownResult.client.guidance.imageGeneration, "unknown");
    assert.match(unknownResult.client.guidance.notes[0], /do not assume a specific tool name/);

    assert.equal(codexResult.markdown, SKILL_MD);
    assert.equal(ompResult.markdown, SKILL_MD);
    assert.equal(unknownResult.markdown, SKILL_MD);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await rm(root, { recursive: true, force: true });
  }
});

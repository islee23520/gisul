import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

test("release metadata is reread, supports rollback, and rejects mismatched or corrupt manifests", async t => {
  const root = await mkdtemp(join(tmpdir(), "skillar-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "skills/example"), { recursive: true });
  const markdown = "---\nname: example\ndescription: Release fixture\n---\nBody\n";
  await writeFile(join(root, "skills/example/SKILL.md"), markdown);
  const client = new Client({ name: "release-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], env: { ...process.env, SKILLAR_ROOT: root, SKILLAR_SKILL_ROOTS: `skillar=${root}/skills` }, stderr: "pipe" });
  transport.stderr.on("data", () => {});
  t.after(() => client.close());
  await client.connect(transport);
  const schema = z.object({ skills: z.array(z.object({ uri: z.string(), resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })) })).optional(), skill: z.unknown().optional(), _meta: z.record(z.string(), z.unknown()) });
  const list = () => client.request({ method: "skills/list", params: {} }, schema);
  const initial = await list();
  assert.deepEqual(initial._meta, { server_version: "0.2.0" });
  const entry = initial.skills[0];
  const resources = entry.resources.slice().sort((a, b) => a.uri < b.uri ? -1 : 1);
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(resources)).digest("hex")}`;
  const publish = (release, commit, manifest_digest = digest) => writeFile(join(root, "release.json"), JSON.stringify({ release, commit, skills: [{ uri: entry.uri, manifest_digest }] }));
  for (const [release, commit] of [["20260916.1", "a".repeat(40)], ["20260916.2", "b".repeat(40)], ["20260916.1", "a".repeat(40)]]) {
    await publish(release, commit);
    assert.deepEqual((await list())._meta, { server_version: "0.2.0", release, commit });
    assert.deepEqual((await client.request({ method: "skills/get", params: { uri: entry.uri } }, schema))._meta, { server_version: "0.2.0", release, commit });
  }
  const oldUri = "skill://skillar/codex/example/SKILL.md";
  await writeFile(join(root, "aliases.json"), JSON.stringify({ [oldUri]: entry.uri }));
  const moved = await client.request({ method: "skills/get", params: { uri: oldUri } }, schema);
  assert.equal(moved.skill.uri, entry.uri);
  assert.equal(moved._meta.movedFrom, oldUri);
  assert.equal(moved._meta.release, "20260916.1");
  for (const aliases of [{ [oldUri]: oldUri }, { [oldUri]: "skill://other/skillar/example/SKILL.md" }, { [oldUri]: "skill://skillar/iyen/../example/SKILL.md" }]) {
    await writeFile(join(root, "aliases.json"), JSON.stringify(aliases));
    await assert.rejects(client.request({ method: "skills/get", params: { uri: oldUri } }, schema), /aliases|Alias target/);
  }
  await rm(join(root, "aliases.json"));
  await writeFile(join(root, "skills/example/SKILL.md"), markdown + "Unreleased edit\n");
  await assert.rejects(list(), /differ from release metadata/);
  await writeFile(join(root, "release.json"), JSON.stringify({ release: "invalid", commit: "not-a-commit" }));
  await assert.rejects(list(), /Invalid skillar release metadata/);
  await writeFile(join(root, "release.json"), "{");
  await assert.rejects(list(), /JSON|Unexpected|property/i);
});

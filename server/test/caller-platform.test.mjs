import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCodexBridge } from "../dist/codex.js";

const digest = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const adapter = fileURLToPath(new URL("../dist/codex.js", import.meta.url));
const upstream = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const uri = name => `skill://gisul/gisul/${name}/SKILL.md`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gisul-platform-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "upstream.env"), `GISUL_ROOT="${root}"\nGISUL_SKILL_ROOTS="gisul=${join(root, "skills")}"\nGISUL_STATE_DIR="${join(root, "state")}"\n`);
  const markdown = "---\nname: example\ndescription: Caller workflow\n---\nRead references/guide.md.\n";
  const guide = "Canonical supporting content\n";
  await mkdir(join(root, "skills/example/references"), { recursive: true });
  await writeFile(join(root, "skills/example/SKILL.md"), markdown);
  await writeFile(join(root, "skills/example/references/guide.md"), guide);
  for (const [name, metadata] of [
    ["cua-driver", ""],
    ["declared", "metadata:\n  gisul:\n    platforms: [win32, linux]\n"],
    ["invalid", "metadata:\n  gisul:\n    platforms: [solaris]\n"],
  ]) {
    await mkdir(join(root, `skills/${name}`));
    await writeFile(join(root, `skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: Caller workflow\n${metadata}---\nCanonical guidance\n`);
  }
  return { root, markdown, guide };
}

async function connect(t, root, platform) {
  const env = { ...process.env, GISUL_ROOT: root, GISUL_SKILL_ROOTS: `gisul=${join(root, "skills")}`, GISUL_STATE_DIR: join(root, "state"), GISUL_EVENT_LOG_DIR: join(root, "events") };
  delete env.GISUL_CALLER_PLATFORM;
  if (platform !== undefined) env.GISUL_CALLER_PLATFORM = platform;
  const client = new Client({ name: "caller-platform-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [adapter, "--origin", "remote-fixture", "--", process.execPath, `--env-file=${join(root, "upstream.env")}`, upstream], env }));
  return async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
}

test("real adapter delivers distinct caller context without changing skill identity", { timeout: 20000 }, async t => {
  // Given: one real upstream serving identical canonical bytes for every caller.
  const { root, markdown, guide } = await fixture(t);
  const resources = [
    { uri: uri("example"), digest: digest(markdown), size: Buffer.byteLength(markdown) },
    { uri: uri("example").replace("SKILL.md", "references/guide.md"), digest: digest(guide), size: Buffer.byteLength(guide) },
  ].sort((a, b) => a.uri < b.uri ? -1 : 1);
  const expectedManifest = digest(JSON.stringify(resources));
  const identities = [];
  const contexts = [];
  const cases = [
    { platform: "win32", os: "windows", shell: "powershell", path: "win32", separator: "\\", home: "$env:USERPROFILE", lookup: "Get-Command {name}", cua: "incompatible", declared: "compatible" },
    { platform: "darwin", os: "macos", shell: "posix", path: "posix", separator: "/", home: "$HOME", lookup: "command -v {name}", cua: "compatible", declared: "incompatible" },
    { platform: "linux", os: "linux", shell: "posix", path: "posix", separator: "/", home: "$HOME", lookup: "command -v {name}", cua: "incompatible", declared: "compatible" },
    { platform: "unknown", os: "unknown", shell: null, path: null, separator: null, home: null, lookup: null, cua: "unknown", declared: "unknown" },
  ];
  for (const expected of cases) await t.test(expected.platform, async t => {
    const call = await connect(t, root, expected.platform);
    // When: discovery and actual load/file/directory tools cross both stdio transports.
    const found = await call("search_skills", { query: "Caller", mode: "discovery" });
    const loaded = await call("load_skill", { uri: uri("example") });
    const read = await call("read_skill_file", { skill_uri: uri("example"), uri: resources[1].uri, load_id: loaded.load_id });
    const directory = await call("read_skill_file", { skill_uri: uri("example"), uri: uri("example").replace("/SKILL.md", "/references") });
    // Then: machine-consumed host context varies while canonical bytes and identities do not.
    for (const result of [found, loaded, read, directory]) {
      assert.deepEqual(result.caller_platform, { platform: expected.platform, reported_platform: expected.platform, source: "override" });
      assert.equal(result.platform_guidance.os, expected.os);
      assert.equal(result.platform_guidance.shell_family, expected.shell);
      assert.equal(result.platform_guidance.path_style, expected.path);
      assert.equal(result.platform_guidance.path_separator, expected.separator);
      assert.equal(result.platform_guidance.home_reference, expected.home);
      assert.equal(result.platform_guidance.executable_lookup_template, expected.lookup);
      assert.equal(result.origin, "remote-fixture");
    }
    assert.equal(loaded.markdown, markdown);
    assert.equal(loaded.digest, digest(markdown));
    assert.equal(read.text, guide);
    assert.equal(loaded.manifest_digest, expectedManifest);
    assert.equal(read.manifest_digest, expectedManifest);
    assert.equal(read.load_id, loaded.load_id);
    assert.deepEqual(directory.files, [resources[1].uri]);
    assert.equal(directory.kind, "directory");
    for (const result of [loaded, read, directory]) assert.deepEqual(result.platform_compatibility, { status: "unknown", required_platforms: null, basis: "not-declared" });
    const cua = await call("load_skill", { uri: uri("cua-driver") });
    assert.deepEqual(cua.platform_compatibility, { status: expected.cua, required_platforms: ["darwin"], basis: "known-cua-driver-contract" });
    const cuaRead = await call("read_skill_file", { skill_uri: uri("cua-driver"), uri: uri("cua-driver") });
    assert.deepEqual(cuaRead.platform_compatibility, cua.platform_compatibility);
    const declared = await call("load_skill", { uri: uri("declared") });
    assert.deepEqual(declared.platform_compatibility, { status: expected.declared, required_platforms: ["win32", "linux"], basis: "skill-metadata" });
    const invalid = await call("load_skill", { uri: uri("invalid") });
    assert.deepEqual(invalid.platform_compatibility, { status: "unknown", required_platforms: null, basis: "invalid-declaration" });
    identities.push([loaded.digest, loaded.manifest_digest, loaded.load_id]);
    contexts.push(JSON.stringify(loaded.caller_platform));
  });
  assert.ok(identities.every(identity => JSON.stringify(identity) === JSON.stringify(identities[0])));
  assert.equal(new Set(contexts).size, 4);
});

test("real adapter detects its local runtime when no caller override is supplied", { timeout: 10000 }, async t => {
  // Given: a local adapter without GISUL_CALLER_PLATFORM, connected to a remote origin label.
  const { root, markdown, guide } = await fixture(t);
  const call = await connect(t, root);
  // When: the client loads and reads through the real MCP adapter.
  const loaded = await call("load_skill", { uri: uri("example") });
  const read = await call("read_skill_file", { skill_uri: uri("example"), uri: uri("example").replace("SKILL.md", "references/guide.md") });
  // Then: only the caller runtime is used, and canonical content is still exact.
  const platform = ["win32", "darwin", "linux"].includes(process.platform) ? process.platform : "unknown";
  assert.deepEqual(loaded.caller_platform, { platform, reported_platform: process.platform, source: "process.platform" });
  assert.deepEqual(read.caller_platform, loaded.caller_platform);
  assert.equal(loaded.markdown, markdown);
  assert.equal(read.text, guide);
});

test("caller context cannot bypass supporting file digest verification", { timeout: 10000 }, async t => {
  // Given: a real adapter has loaded the original manifest on a Windows caller.
  const { root } = await fixture(t);
  const env = { ...process.env, GISUL_CALLER_PLATFORM: "win32", GISUL_ROOT: root, GISUL_SKILL_ROOTS: `gisul=${join(root, "skills")}`, GISUL_STATE_DIR: join(root, "state"), GISUL_EVENT_LOG_DIR: join(root, "events") };
  const client = new Client({ name: "digest-platform-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [adapter, "--origin", "remote-fixture", "--", process.execPath, `--env-file=${join(root, "upstream.env")}`, upstream], env }));
  const loaded = await client.callTool({ name: "load_skill", arguments: { uri: uri("example") } });
  assert.ok(!loaded.isError);
  await writeFile(join(root, "skills/example/references/guide.md"), "Changed canonical bytes\n");
  // When: the client requests changed bytes against the held manifest.
  const result = await client.callTool({ name: "read_skill_file", arguments: { skill_uri: uri("example"), uri: uri("example").replace("SKILL.md", "references/guide.md") } });
  // Then: the real verification gate rejects the read.
  assert.equal(result.isError, true);
});

test("explicit caller override rejects invalid values at the adapter boundary", () => {
  // Given: invalid wrapper/test values and an upstream that must not be contacted.
  const upstream = { request: () => assert.fail("invalid platform must be rejected before requesting content") };
  // When/Then: invalid values fail instead of being inferred or silently normalized.
  for (const value of ["windows", "macos", "solaris", "", " win32", null, 42]) {
    assert.throws(() => createCodexBridge(upstream, "remote-fixture", undefined, true, false, value));
  }
});

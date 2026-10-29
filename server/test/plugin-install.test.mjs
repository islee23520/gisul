import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isPluginTransport, pluginSource, verifyInstalled } from "../../clients/codex/install-plugin.mjs";

test("plugin updates require one confirmed local marketplace source", () => {
  const local = { pluginId: "skillar@personal", source: { source: "local", path: "/plugins/skillar" } };
  assert.equal(pluginSource({ installed: [local] }, "personal"), "/plugins/skillar");
  for (const entries of [[], [{ ...local, source: { source: "github", path: "/plugins/skillar" } }], [local, { ...local, source: { source: "local", path: "/another/skillar" } }]]) {
    assert.throws(() => pluginSource({ installed: entries }, "personal"), /one confirmed local/);
  }
});

test("plugin-provided mcp get results are distinguished from standalone registrations", () => {
  const installed = [{ pluginId: "skillar@personal", version: "1.0.0" }];
  assert.equal(isPluginTransport({ transport: { cwd: "/codex/plugins/cache/personal/skillar/1.0.0/." } }, installed, "personal", "/codex"), true);
  for (const cwd of [undefined, "/repo/server", "/codex/plugins/cache/personal/skillar/old", "/codex/plugins/cache/personal/skillar/1.0.0-extra"]) {
    assert.equal(isPluginTransport({ transport: { cwd } }, installed, "personal", "/codex"), false);
  }
});

test("installed verification detects stale versions, disabled plugins, and stale cache bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "skillar-plugin-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const cache = join(root, "plugins/cache/personal/skillar/1.0.0");
  for (const base of [source, cache]) for (const file of [".codex-plugin/plugin.json", ".mcp.json", "runtime/codex.mjs", "skills/skillar/SKILL.md"]) {
    await mkdir(dirname(join(base, file)), { recursive: true });
    await writeFile(join(base, file), file);
  }
  const entry = { pluginId: "skillar@personal", enabled: true, version: "1.0.0" };
  const verify = installed => verifyInstalled({ installed }, "personal", "1.0.0", source, root);
  assert.equal(await verify([entry]), cache);
  await assert.rejects(verify([{ ...entry, version: "0.0.1" }]), /new plugin version/);
  await assert.rejects(verify([{ ...entry, enabled: false }]), /disabled/);
  await writeFile(join(cache, "runtime/codex.mjs"), "stale bundle");
  await assert.rejects(verify([entry]), /differs from the built plugin/);
});

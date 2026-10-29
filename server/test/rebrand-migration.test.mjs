import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { createGisulEventLog, createSkillarEventLog } from "../dist/codex.js";

test("renamed and legacy SSH launchers follow symlinks and accept legacy configuration and catalog URIs", async t => {
  const root = await mkdtemp(join(tmpdir(), "skillar-launcher-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "skills/alpha"), { recursive: true });
  await writeFile(join(root, "skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: Migration fixture\n---\nPreserved body\n");
  for (const name of ["skillar", "gisul"]) {
    const launcher = join(root, name);
    await symlink(fileURLToPath(new URL(`../bin/${name}`, import.meta.url)), launcher);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SKILLAR_") && !key.startsWith("GISUL_")));
    Object.assign(env, { GISUL_ROOT: root, GISUL_SKILL_ROOTS: `iyen=${root}/skills`, GISUL_URI_AUTHORITY: "gisul", GISUL_STATE_DIR: join(root, "state") });
    const client = new Client({ name: "legacy-config-test", version: "1" });
    const transport = new StdioClientTransport({ command: launcher, env, stderr: "pipe" });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion().name, "skillar");
      const result = await client.request({ method: "skills/list", params: {} }, z.object({ skills: z.array(z.object({ uri: z.string() })) }));
      assert.deepEqual(result.skills.map(s => s.uri), ["skill://skillar/iyen/alpha/SKILL.md"]);
      for (const source of ["gisul", "codex"]) {
        const uri = `skill://gisul/${source}/alpha/SKILL.md`;
        const loaded = await client.request({ method: "skills/get", params: { uri } }, z.object({ skill: z.object({ uri: z.string() }), _meta: z.object({ movedFrom: z.string() }) }));
        assert.equal(loaded.skill.uri, "skill://skillar/iyen/alpha/SKILL.md");
        assert.equal(loaded._meta.movedFrom, uri);
        assert.match((await client.readResource({ uri })).contents[0].text, /Preserved body/);
      }
      await assert.rejects(client.readResource({ uri: "skill://foreign/iyen/alpha/SKILL.md" }));
    } finally { await client.close(); }
  }
});

test("the public legacy event-log export remains the same implementation", () => {
  assert.equal(createGisulEventLog, createSkillarEventLog);
});

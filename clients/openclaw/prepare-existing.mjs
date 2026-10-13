#!/usr/bin/env node
// Prepare a loader-only bundle for hosts that already register mcp.servers.gisul.
// No OpenClaw config or credentials are read or changed by this build step.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./plugin/", import.meta.url));
export async function prepareExisting(output) {
  const target = resolve(output);
  // A fresh directory prevents replacing a customized or installed bundle.
  await mkdir(target);
  try {
    const files = ["package.json", "skills/gisul/SKILL.md", "hooks/gisul-discovery/HOOK.md", "hooks/gisul-discovery/handler.js"];
    for (const name of files) {
      await mkdir(dirname(join(target, name)), { recursive: true });
      await copyFile(join(source, name), join(target, name));
    }
    const manifest = JSON.parse(await readFile(join(source, ".codex-plugin/plugin.json"), "utf8"));
    delete manifest.mcpServers;
    manifest.description = "Gisul discovery and remote skill loader using the host's existing MCP registration.";
    await mkdir(join(target, ".codex-plugin"));
    await writeFile(join(target, ".codex-plugin/plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(join(target, "gisul-client.json"), JSON.stringify({ mode: "existing-mcp", server: "gisul" }, null, 2) + "\n");
    await writeFile(join(target, "README.md"), `# Gisul for OpenClaw — existing MCP connection

This bundle installs only the gisul loader and in-memory discovery hook.
It contains no MCP registration, OAuth bridge, token or remote workflow catalog.
Keep this host's existing mcp.servers.gisul connection, endpoint, authentication,
tool filter and event-log configuration. Follow that connection's own login or
credential management instructions; do not run the default OAuth bridge login.

Prerequisite: the existing connection exposes search_skills, load_skill and
read_skill_file. Probe it with openclaw mcp probe gisul --json. Installation does
not upgrade the remote service or add missing capabilities to an old adapter.

Install this directory with OpenClaw's native plugin manager and inspect
gisul-openclaw, the gisul skill and the gisul-discovery hook. Existing plugin,
skill and tool policies still apply. Verify discovery → pinned load → supporting
file read in a fresh session; catalog inspection alone does not verify calls.

Uninstalling gisul-openclaw removes only the loader/hook. Manage the independently
registered MCP server separately if you intend to change it.
`);
    return { output: target, mode: "existing-mcp", mcpRegistrationIncluded: false };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: node clients/openclaw/prepare-existing.mjs --output /new/bundle-directory");
    console.log(JSON.stringify(await prepareExisting(args[1]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

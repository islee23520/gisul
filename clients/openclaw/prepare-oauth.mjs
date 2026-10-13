#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEndpoint } from "./plugin/scripts/bridge.mjs";

export async function prepareOAuth(output, endpoint) {
  const target = resolve(output), url = validateEndpoint(endpoint);
  await mkdir(target);
  try {
    await cp(new URL("./plugin/", import.meta.url), target, { recursive: true });
    await writeFile(resolve(target, "gisul-client.json"), JSON.stringify({ mode: "oauth", endpoint: url }, null, 2) + "\n");
    return { output: target, mode: "oauth", endpoint: url };
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--output" || args[2] !== "--endpoint") throw new Error("Usage: node prepare-oauth.mjs --output /new/bundle --endpoint https://host/mcp");
    console.log(JSON.stringify(await prepareOAuth(args[1], args[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

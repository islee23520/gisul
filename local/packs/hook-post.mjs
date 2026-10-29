#!/usr/bin/env node
// Forwards a runtime hook payload (stdin JSON) to the local skillar daemon. Always exits 0.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveStateHome(env) {
  const home = env.HOME || homedir();
  const preferred = join(home, ".skillar"), legacy = join(home, ".gisool");
  if (["config.json", "token", "skillar.db", "gisool.db"].some(file => existsSync(join(preferred, file)))) return preferred;
  return existsSync(legacy) ? legacy : preferred;
}


const done = () => process.exit(0);
try {
  const runtime = process.argv[2] ?? "unknown";
  const home = (process.env.SKILLAR_HOME || process.env.GISOOL_HOME) || resolveStateHome(process.env);
  const body = await new Promise(resolve => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), 1000);
    process.stdin.on("data", c => chunks.push(c));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(""); });
  });
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const { port } = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  if (body && token && Number.isInteger(port)) {
    await fetch(`http://127.0.0.1:${port}/ingest/hook/${encodeURIComponent(runtime)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(2000),
    });
  }
} catch { /* never block the agent */ }
done();

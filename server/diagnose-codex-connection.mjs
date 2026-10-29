import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [plugin, mode, secondsArg, output] = process.argv.slice(2);
const seconds = Number(secondsArg);
if (!plugin || !["idle", "upstream-close"].includes(mode) || !Number.isFinite(seconds) || seconds < 0 || !output || process.argv.length !== 6) throw new Error("Usage: node diagnose-codex-connection.mjs <installed-plugin> <idle|upstream-close> <seconds> <output.jsonl>");
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(output, "", { flag: "wx", mode: 0o600 });
const log = value => { const event = { ts: new Date().toISOString(), ...value }; appendFileSync(output, JSON.stringify(event) + "\n"); if (value.event !== "stderr") console.log(JSON.stringify(event)); };
const root = resolve(plugin);
const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.skillar;
const client = new Client({ name: "skillar-connection-diagnostic", version: "1" });
const transport = new StdioClientTransport({ ...config, cwd: root, stderr: "pipe" });
transport.stderr?.on("data", bytes => log({ event: "stderr", text: bytes.toString() }));
client.onerror = error => log({ event: "client-error", message: String(error) });
client.onclose = () => log({ event: "client-close" });
const call = async (phase, name, args) => {
  const start = Date.now();
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    if (result.isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
    const data = JSON.parse(result.content[0].text);
    log({ event: "call", phase, tool: name, ok: true, elapsed_ms: Date.now() - start, total: data.totalMatches, uri: data.uri });
    return data;
  } catch (error) { log({ event: "call", phase, tool: name, ok: false, elapsed_ms: Date.now() - start, message: String(error) }); return undefined; }
};
try {
  await client.connect(transport);
  log({ event: "connected", plugin: root, mode, seconds, bridge_pid: transport.pid });
  const before = await call("before", "search_skills", { limit: 1 });
  if (!before?.skills.length) throw new Error("Baseline search failed; no outage was injected");
  const uri = before.skills[0].uri;
  if (!await call("before", "load_skill", { uri })) throw new Error("Baseline load failed; no outage was injected");
  if (mode === "upstream-close") {
    const children = spawnSync("pgrep", ["-P", String(transport.pid)], { encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean);
    const ssh = children.filter(pid => basename(spawnSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" }).stdout.trim()) === "ssh");
    if (ssh.length !== 1) throw new Error("Expected exactly one SSH child owned by this diagnostic bridge");
    process.kill(Number(ssh[0]), "SIGTERM");
    log({ event: "owned-ssh-terminated", ssh_pid: Number(ssh[0]), note: "Only this probe's SSH child was terminated; sshd was not restarted" });
  }
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, Math.min(60000, until - Date.now())));
    log({ event: "waiting", remaining_seconds: Math.max(0, Math.round((until - Date.now()) / 1000)) });
  }
  await call("after", "search_skills", { limit: 1 });
  await call("after", "load_skill", { uri });
  log({ event: "finished", mode });
} finally { await client.close(); }

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(process.argv[2] ?? "../clients/codex/plugin/skillar");
const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.skillar;
const client = new Client({ name: "skillar-plugin-smoke", version: "1" });
try {
  await client.connect(new StdioClientTransport({ ...config, cwd: root, stderr: "pipe" }));
  const parseResult = result => {
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return JSON.parse(result.content[0].text);
  };
  const found = parseResult(await client.callTool({ name: "search_skills", arguments: { limit: 1 } }));
  if (!found.skills.length) throw new Error("No skills returned from upstream");
  if (found.totalMatches > 1) {
    if (found.nextOffset !== 1) throw new Error("Outdated bridge: search_skills did not return nextOffset");
    const next = parseResult(await client.callTool({ name: "search_skills", arguments: { limit: 1, offset: found.nextOffset, ...(found.commit ? { commit: found.commit } : {}) } }));
    if (next.offset !== 1 || next.skills[0]?.uri === found.skills[0].uri) throw new Error("Bridge pagination did not advance");
  }
  const loaded = parseResult(await client.callTool({ name: "load_skill", arguments: { uri: found.skills[0].uri, ...(found.commit ? { commit: found.commit } : {}) } }));
  if (!/^[a-f0-9]{64}$/.test(loaded.load_id ?? "")) throw new Error("Missing load identity");
  if (found.commit && loaded.commit !== found.commit) throw new Error("Selected release changed");
  const reread = parseResult(await client.callTool({ name: "read_skill_file", arguments: { skill_uri: loaded.uri, uri: loaded.uri, load_id: loaded.load_id } }));
  if (reread.load_id !== loaded.load_id) throw new Error("Read lost load identity");
  if (loaded.markdown !== reread.text) throw new Error("Read mismatch");
  console.log(JSON.stringify({ origin: found.origin, matches: found.totalMatches, nextOffset: found.nextOffset, loaded: loaded.uri, verifiedRead: true }));
} finally { await client.close(); }

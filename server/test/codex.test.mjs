import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexBridge } from "../dist/codex.js";

test("Codex bridge searches metadata, loads exact identity and pins supporting files", async () => {
  const uri = "skill://skillar/root0/review/SKILL.md";
  const otherUri = "skill://skillar/root1/review/SKILL.md";
  const file = "skill://skillar/root0/review/references/guide.md";
  const markdown = "---\nname: review\ndescription: Team review\n---\nRead references/guide.md.\n";
  const bodies = new Map([[uri, markdown], [file, "Original guide"]]);
  const manifest = () => [...bodies].map(([uri, text]) => ({ uri, size: Buffer.byteLength(text), digest: `sha256:${createHash("sha256").update(text).digest("hex")}` }));
  let entry = { uri, frontmatter: { name: "review", description: "Team review" }, resources: manifest() };
  const reads = [];
  const upstream = {
    request: async ({ method, params }) => {
      if (method === "skills/list") return { skills: [entry, { ...entry, uri: otherUri, resources: [{ ...entry.resources[0], uri: otherUri }] }] };
      assert.equal(params.uri, uri);
      return { skill: entry };
    },
    readResource: async ({ uri }) => { reads.push(uri); return { contents: [{ uri, text: bodies.get(uri) }] }; },
  };
  const server = createCodexBridge(upstream, "macmini");
  const client = new Client({ name: "test", version: "1" });
  const [front, back] = InMemoryTransport.createLinkedPair();
  await server.connect(back);
  await client.connect(front);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const data = result => JSON.parse(result.content[0].text);
  try {
    const found = data(await call("search_skills", { query: "review" }));
    assert.equal(found.skills.length, 2);
    assert.notEqual(found.skills[0].uri, found.skills[1].uri);
    assert.equal(reads.length, 0, "discovery must not read file bodies");
    assert.equal((await call("read_skill_file", { skill_uri: uri, uri: file })).isError, true);
    const loaded = data(await call("load_skill", { uri }));
    assert.equal(loaded.origin, "macmini");
    assert.equal(loaded.markdown, markdown);
    assert.deepEqual(reads, [uri], "load does not prefetch supporting files");
    assert.equal(data(await call("read_skill_file", { skill_uri: uri, uri: file })).text, "Original guide");
    const readCount = reads.length;
    assert.equal((await call("read_skill_file", { skill_uri: uri, uri: otherUri })).isError, true);
    assert.equal(reads.length, readCount, "off-manifest URI is rejected before fetching");
    bodies.set(file, "Changed guide!");
    assert.equal((await call("read_skill_file", { skill_uri: uri, uri: file })).isError, true);
    entry = { ...entry, resources: manifest() };
    assert.equal(data(await call("load_skill", { uri })).changed, true);
    assert.equal(data(await call("read_skill_file", { skill_uri: uri, uri: file })).text, "Changed guide!");
    entry = { ...entry, frontmatter: { name: "review", description: "Misleading description" } };
    assert.equal((await call("load_skill", { uri })).isError, true);
  } finally { await client.close(); await server.close(); }
});

test("Codex search exposes every filtered match across upstream and result pages", async () => {
  const entries = Array.from({ length: 125 }, (_, index) => {
    const uri = `skill://skillar/root${String(index).padStart(3, "0")}/review/SKILL.md`;
    return {
      uri,
      frontmatter: { name: "review", description: index < 123 ? "Team review" : "Other workflow" },
      resources: [{ uri, size: 0, digest: `sha256:${createHash("sha256").update("").digest("hex")}` }],
    };
  });
  const requests = [];
  const upstream = {
    request: async ({ method, params }) => {
      assert.equal(method, "skills/list");
      requests.push(params);
      const offset = params.cursor ? Number(params.cursor) : 0;
      const end = offset + 17;
      return { skills: entries.slice().reverse().slice(offset, end), ...(end < entries.length ? { nextCursor: String(end) } : {}) };
    },
    readResource: async () => { assert.fail("search must not read skill bodies"); },
  };
  const server = createCodexBridge(upstream, "fixture-host");
  const client = new Client({ name: "pagination-test", version: "1" });
  const [front, back] = InMemoryTransport.createLinkedPair();
  await server.connect(back);
  await client.connect(front);
  const search = async args => {
    const result = await client.callTool({ name: "search_skills", arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  try {
    const query = " TEAM   review ";
    const defaults = await search({ query });
    assert.equal(defaults.offset, 0);
    assert.equal(defaults.limit, 5);
    assert.equal(defaults.skills.length, 5);
    assert.equal(defaults.nextOffset, 5);
    assert.deepEqual(requests, [{}, ...[17, 34, 51, 68, 85, 102, 119].map(cursor => ({ cursor: String(cursor) }))]);

    const collected = [];
    let offset = 0;
    for (const size of [50, 50, 23]) {
      const page = await search({ query, limit: 50, offset });
      assert.equal(page.origin, "fixture-host");
      assert.equal(page.totalMatches, 123);
      assert.equal(page.offset, offset);
      assert.equal(page.limit, 50);
      assert.equal(page.skills.length, size);
      collected.push(...page.skills.map(skill => skill.uri));
      if (size === 50) assert.equal(page.nextOffset, offset + size);
      else assert.ok(!Object.hasOwn(page, "nextOffset"));
      offset = page.nextOffset;
    }
    assert.deepEqual(collected, entries.slice(0, 123).map(entry => entry.uri));
    assert.equal(new Set(collected).size, 123, "same-named skills are neither skipped nor duplicated");
    assert.equal((await search({ limit: 50 })).totalMatches, 125);
    assert.equal((await search({ query, offset: 73, limit: 50 })).nextOffset, undefined, "an exactly full final page terminates");
    for (const args of [{ query, offset: 123 }, { query, offset: 124 }, { query, offset: Number.MAX_SAFE_INTEGER }, { query: "missing" }]) {
      const page = await search(args);
      assert.deepEqual(page.skills, []);
      assert.equal(page.totalMatches, args.query === "missing" ? 0 : 123);
      assert.ok(!Object.hasOwn(page, "nextOffset"));
    }

    const requestCount = requests.length;
    for (const args of [
      ...[-1, 0.5, "50", null, true, Number.MAX_SAFE_INTEGER + 1].map(offset => ({ offset })),
      ...[0, -1, 51, 1.5, "10", null].map(limit => ({ limit })),
    ]) {
      const result = await client.callTool({ name: "search_skills", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, /Input validation error/);
    }
    assert.equal(requests.length, requestCount, "invalid pagination is rejected before upstream requests");
  } finally { await client.close(); await server.close(); }
});

test("Codex stdio adapter interoperates with the real skillar server", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "skillar-codex-test-"));
  const client = new Client({ name: "codex-smoke", version: "1" });
  try {
    await mkdir(join(root, "example"));
    await writeFile(join(root, "example/SKILL.md"), "---\nname: example\ndescription: Test workflow\n---\nFollow the test workflow.\n");
    const adapter = fileURLToPath(new URL("../dist/codex.js", import.meta.url));
    const upstream = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const eventDir = join(root, "events");
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [adapter, "--origin", "fixture-host", "--", "env", `SKILLAR_ROOT=${root}`, `SKILLAR_STATE_DIR=${root}/state`, `SKILLAR_SKILLS_DIRS=${root}`, process.execPath, upstream], env: { ...process.env, SKILLAR_EVENT_LOG_DIR: eventDir } }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["create_skill", "load_skill", "read_skill_file", "search_skills", "update_skill"]);
    const result = await client.callTool({ name: "search_skills", arguments: { query: "workflow" } });
    assert.ok(!result.isError, JSON.stringify(result));
    const found = JSON.parse(result.content[0].text);
    assert.equal(found.skills.length, 1);
    const loaded = await client.callTool({ name: "load_skill", arguments: { uri: found.skills[0].uri } });
    assert.ok(!loaded.isError, JSON.stringify(loaded));
    assert.equal(JSON.parse(loaded.content[0].text).origin, "fixture-host");
    const markdown = "---\nname: new-flow\ndescription: New workflow\n---\nOriginal\n";
    const call = (name, args) => client.callTool({ name, arguments: args });
    const created = await call("create_skill", { name: "new-flow", markdown });
    assert.ok(!created.isError, JSON.stringify(created));
    const { uri, digest } = JSON.parse(created.content[0].text);
    const changed = markdown.replace("Original", "Updated");
    assert.equal((await call("update_skill", { uri, expected_digest: digest, markdown: changed })).isError, true, "bridge requires verified load");
    const first = JSON.parse((await call("load_skill", { uri })).content[0].text);
    assert.equal(first.digest, digest);
    assert.match(first.connection_id, /^c_[0-9]+_[0-9]+$/);
    assert.ok(!(await call("update_skill", { uri, expected_digest: first.digest, markdown: changed })).isError);
    assert.equal((await call("read_skill_file", { skill_uri: uri, uri })).isError, true, "old manifest must fail verification");
    const second = JSON.parse((await call("load_skill", { uri })).content[0].text);
    assert.equal(second.changed, true);
    assert.equal(second.markdown, changed);
    assert.equal((await call("update_skill", { uri, expected_digest: first.digest, markdown })).isError, true);
    await client.close();
    const log = (await Promise.all((await readdir(eventDir)).map(file => readFile(join(eventDir, file), "utf8")))).join("");
    const events = log.trim().split("\n").map(line => JSON.parse(line));
    for (const event of ["connect", "search", "load_skill", "error", "disconnect"]) assert.ok(events.some(item => item.event === event), event);
    assert.ok(events.every(event => event.connection_id === first.connection_id));
    assert.ok(events.some(event => event.event === "load_skill" && event.manifest_digest && event.bytes > 0));
    assert.ok(events.some(event => event.code === "skillar_verification_failed"));
    assert.ok(!log.includes("Follow the test workflow.") && !log.includes("name: new-flow"), "event logs must not contain skill bodies");
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("bridge reports release identity, follows explicit aliases, searches keywords, and expands pinned directories", async () => {
  const uri = "skill://skillar/iyen/delivery/SKILL.md";
  const oldUri = "skill://gisul/codex/delivery/SKILL.md";
  const root = uri.slice(0, -8);
  const markdown = "---\nname: delivery\ndescription: Delivery workflow\nkeywords: [개발, 티켓, implementation]\n---\nRead references when needed.\n";
  const bodies = new Map([[uri, markdown], ...Array.from({ length: 25 }, (_, index) => [`${root}references/file-${index}.md`, `Guide ${index}`])]);
  const entry = { uri, frontmatter: { name: "delivery", description: "Delivery workflow", keywords: ["개발", "티켓", "implementation"] }, resources: [...bodies].map(([uri, body]) => ({ uri, digest: `sha256:${createHash("sha256").update(body).digest("hex")}`, size: Buffer.byteLength(body) })) };
  let meta = { release: "20260916.1", commit: "a".repeat(40), server_version: "0.1.0", movedFrom: oldUri };
  let omitChild = false;
  const reads = [];
  const server = createCodexBridge({
    request: async ({ method }) => {
      if (method === "skills/list") return { skills: [entry] };
      if (method === "skills/get") return { skill: entry, _meta: meta };
      if (method === "resources/directory/read") return { resources: [...bodies.keys()].filter(key => key.includes("/references/")).slice(omitChild ? 1 : 0).map(uri => ({ uri })) };
      throw new Error(method);
    },
    readResource: async ({ uri }) => { reads.push(uri); return { contents: [{ uri, text: bodies.get(uri) }] }; },
  }, "fixture");
  const client = new Client({ name: "versioned-bridge-test", version: "1" });
  const [front, back] = InMemoryTransport.createLinkedPair();
  await server.connect(back); await client.connect(front);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const data = result => { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  try {
    assert.equal(data(await call("search_skills", { query: "개발 티켓" })).totalMatches, 1);
    const loaded = data(await call("load_skill", { uri: oldUri }));
    assert.equal(loaded.uri, uri);
    assert.equal(loaded.movedFrom, oldUri);
    assert.equal(loaded.release, meta.release);
    assert.equal(loaded.commit, meta.commit);
    const ordered = entry.resources.slice().sort((a, b) => a.uri < b.uri ? -1 : 1);
    assert.equal(loaded.manifest_digest, `sha256:${createHash("sha256").update(JSON.stringify(ordered)).digest("hex")}`);
    assert.deepEqual(loaded.files, [uri, `${root}references`]);
    assert.equal(loaded.filesFolded, true);
    assert.deepEqual(reads, [uri], "large manifests must not fetch supporting bodies eagerly");
    const directory = data(await call("read_skill_file", { skill_uri: oldUri, uri: `${root}references` }));
    assert.equal(directory.files.length, 25);
    assert.equal(directory.manifest_digest, loaded.manifest_digest);
    assert.equal(data(await call("read_skill_file", { skill_uri: uri, uri: directory.files[0] })).release, meta.release);
    omitChild = true;
    assert.equal(data(await call("read_skill_file", { skill_uri: uri, uri: `${root}references` })).files.length, 25, "directory expansion uses the held manifest, not a live listing");
    for (const foreign of ["skill://foreign/codex/delivery/SKILL.md", "skill://gisul/untrusted/delivery/SKILL.md"]) {
      meta = { ...meta, movedFrom: foreign };
      assert.equal((await call("load_skill", { uri: foreign })).isError, true, "foreign authorities or legacy roots are not migration aliases");
    }
    meta = { ...meta, movedFrom: "skill://wrong/source/delivery/SKILL.md" };
    assert.equal((await call("load_skill", { uri: oldUri })).isError, true, "an undeclared redirect must fail");
  } finally { await client.close(); await server.close(); }
});

test("bridge pins each load across promotion, including the first body and directory reads", async t => {
  const uri = "skill://skillar/iyen/versioned/SKILL.md";
  const root = uri.slice(0, -8);
  const releases = new Map(["a", "b"].map(letter => {
    const commit = letter.repeat(40);
    const markdown = `---\nname: versioned\ndescription: Versioned workflow\n---\nRelease ${letter}\n`;
    const bodies = new Map([[uri, markdown], ...Array.from({ length: 21 }, (_, i) => [`${root}references/${letter}-${i}.md`, `Guide ${letter}-${i}`])]);
    const skill = { uri, frontmatter: { name: "versioned", description: "Versioned workflow" }, resources: [...bodies].map(([uri, text]) => ({ uri, size: Buffer.byteLength(text), digest: `sha256:${createHash("sha256").update(text).digest("hex")}` })) };
    return [commit, { skill, bodies, _meta: { release: `20260917.${letter === "a" ? 3 : 4}`, commit } }];
  }));
  const oldCommit = "a".repeat(40), newCommit = "b".repeat(40);
  let current = oldCommit;
  const reads = [];
  const upstream = {
    request: async ({ method, params }) => {
      const release = releases.get(params._meta?.["app.skillar/commit"] ?? current);
      if (method === "skills/list") return { skills: [release.skill], _meta: release._meta };
      if (method === "skills/get") {
        current = newCommit; // Promotion happens before the bridge reads even SKILL.md.
        return { skill: release.skill, _meta: release._meta };
      }
      if (method === "resources/directory/read") {
        assert.ok(params._meta?.["app.skillar/commit"], "directory requests must carry the loaded commit");
        return { resources: [...release.bodies.keys()].filter(key => key.startsWith(`${params.uri}/`)).map(uri => ({ uri })) };
      }
      throw new Error(method);
    },
    readResource: async params => {
      const commit = params._meta?.["app.skillar/commit"];
      assert.ok(commit, "body requests must carry the loaded commit");
      reads.push({ commit, uri: params.uri });
      return { contents: [{ uri: params.uri, text: releases.get(commit).bodies.get(params.uri) }] };
    },
  };
  const connect = async () => {
    const server = createCodexBridge(upstream, "worker-fixture", undefined, true);
    const client = new Client({ name: "pinned-test", version: "1" });
    const [front, back] = InMemoryTransport.createLinkedPair();
    await server.connect(back); await client.connect(front);
    t.after(async () => { await client.close(); await server.close(); });
    return async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
  };
  const first = await connect();
  assert.equal((await first("search_skills", {})).commit, oldCommit);
  current = newCommit; // Also cover promotion between discovery and selection.
  const loaded = await first("load_skill", { uri, commit: oldCommit });
  assert.equal(loaded.commit, oldCommit);
  assert.match(loaded.markdown, /Release a/);
  assert.deepEqual(reads, [{ commit: oldCommit, uri }], "loading reads only SKILL.md");
  const second = await connect();
  assert.equal((await second("search_skills", {})).commit, newCommit);
  assert.equal((await second("search_skills", { commit: oldCommit })).commit, oldCommit, "a continuation can retain its original catalog");
  assert.equal((await second("load_skill", { uri })).commit, newCommit);
  const oldDirectory = await first("read_skill_file", { skill_uri: uri, uri: `${root}references` });
  assert.ok(oldDirectory.files.every(uri => uri.includes("/a-")));
  const original = await first("read_skill_file", { skill_uri: uri, uri: oldDirectory.files[0] });
  assert.equal(original.commit, oldCommit);
  assert.match(original.text, /^Guide a-/);
  const refreshed = await first("load_skill", { uri });
  assert.equal(refreshed.commit, newCommit);
  assert.equal(refreshed.changed, true);
  assert.notEqual(refreshed.load_id, loaded.load_id);
  const pinnedDirectory = await first("read_skill_file", { skill_uri: uri, uri: `${root}references`, load_id: loaded.load_id });
  const pinnedFile = await first("read_skill_file", { skill_uri: uri, uri: pinnedDirectory.files[0], load_id: loaded.load_id });
  assert.equal(pinnedFile.commit, oldCommit, "reloading the same URI cannot replace an earlier explicit load");
  assert.match(pinnedFile.text, /^Guide a-/);
  current = oldCommit;
  const afterRollback = await first("read_skill_file", { skill_uri: uri, uri: `${root}references/b-0.md`, load_id: refreshed.load_id });
  assert.equal(afterRollback.commit, newCommit, "rollback does not rewrite an already loaded version");
});

test("search pins catalog pagination and rejects mixed release evidence", async t => {
  const uri = "skill://skillar/iyen/flow/SKILL.md";
  const entry = { uri, frontmatter: { name: "flow", description: "Flow" }, resources: [{ uri, size: 0, digest: `sha256:${createHash("sha256").update("").digest("hex")}` }] };
  let drift = false;
  const commit = "a".repeat(40);
  const server = createCodexBridge({
    request: async ({ params }) => {
      if (params.cursor) assert.equal(params._meta["app.skillar/commit"], commit);
      return { skills: params.cursor ? [] : [entry], ...(params.cursor ? {} : { nextCursor: "second" }), _meta: { commit: drift && params.cursor ? "b".repeat(40) : commit, release: "20260917.3" } };
    },
    readResource: async () => assert.fail("search reads metadata only"),
  }, "worker-fixture");
  const client = new Client({ name: "catalog-pin-test", version: "1" });
  const [front, back] = InMemoryTransport.createLinkedPair();
  await server.connect(back); await client.connect(front);
  t.after(async () => { await client.close(); await server.close(); });
  const call = () => client.callTool({ name: "search_skills", arguments: {} });
  assert.equal(JSON.parse((await call()).content[0].text).commit, commit);
  drift = true;
  const result = await call();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /release changed during pagination/);
});

// SEP-2640 Skills Extension conformance suite for the skillar MCP server.
// Speaks raw JSON-RPC over the spawned server's stdio — no SDK client between
// the assertions and the wire. Fixture roots are built into a temp dir and
// injected via SKILLAR_SKILLS_DIRS (ids become root0, root1, ...).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist", "index.js");
const EXTENSION_ID = "io.modelcontextprotocol/skills";
const AUTHORITY = "skillar";

function sha256hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.stderr = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const { resolve, reject, timer } = this.pending.get(message.id);
          clearTimeout(timer);
          this.pending.delete(message.id);
          if (message.error) reject(new RpcError(message.error));
          else resolve(message.result);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.stderr.push(chunk));
  }

  call(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })}\n`);
  }

  async initialize() {
    const result = await this.call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "skillar-conformance", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  get stderrText() {
    return this.stderr.join("");
  }
}

class RpcError extends Error {
  constructor(error) {
    super(`${error.code}: ${error.message}`);
    this.code = error.code;
    this.data = error.data;
  }
}

function startServer(skillsDirs) {
  const child = spawn(process.execPath, [DIST], {
    env: {
      ...process.env,
      SKILLAR_ROOT: join(skillsDirs[0], ".runtime"),
      SKILLAR_SKILLS_DIRS: skillsDirs.join(":"),
      SKILLAR_URI_AUTHORITY: AUTHORITY,
      SKILLAR_STATE_DIR: join(tmpdir(), `skillar-test-state-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new RpcClient(child);
}

function stopServer(client) {
  return new Promise((resolve) => {
    client.child.on("exit", resolve);
    client.child.kill("SIGTERM");
  });
}

const ALPHA_SKILL_MD = `---
name: alpha
description: Alpha test skill
license: MIT
metadata:
  version: "1.2.3"
  tags:
    - one
    - two
---
# Alpha

Body text.
`;

const SUB_SKILL_MD = `---
name: sub-skill
description: Nested skill inside alpha
---
# Sub skill
`;

const MISMATCH_SKILL_MD = `---
name: different-name
description: Frontmatter name differs from directory name
---
# Mismatch
`;

const GAMMA_SKILL_MD = `---
name: gamma
description: Gamma test skill in the second root
---
# Gamma
`;

const BIG_SKILL_MD = `---
name: big
description: Skill that exceeds the 512-resource limit
---
# Big
`;

let fixtureRoots;
let client;
let alphaEntry;
let subSkillEntry;

before(async () => {
  const base = await mkdtemp(join(tmpdir(), "skillar-conformance-"));
  const root0 = join(base, "root0");
  const root1 = join(base, "root1");

  await mkdir(join(root0, "alpha", "references"), { recursive: true });
  await mkdir(join(root0, "alpha", "scripts"), { recursive: true });
  await mkdir(join(root0, "alpha", "sub-skill"), { recursive: true });
  await mkdir(join(root0, "mismatch-dir"), { recursive: true });
  await mkdir(join(root1, "gamma"), { recursive: true });
  await mkdir(join(root1, "big"), { recursive: true });

  await writeFile(join(root0, "alpha", "SKILL.md"), ALPHA_SKILL_MD, "utf8");
  await writeFile(join(root0, "alpha", "references", "GUIDE.md"), "# Guide\nReference content.\n", "utf8");
  await writeFile(join(root0, "alpha", "scripts", "run.sh"), "#!/bin/sh\necho run\n", "utf8");
  await writeFile(join(root0, "alpha", "sub-skill", "SKILL.md"), SUB_SKILL_MD, "utf8");
  await writeFile(join(root0, "alpha", "sub-skill", "extra.md"), "Extra supporting file.\n", "utf8");
  await writeFile(join(root0, "mismatch-dir", "SKILL.md"), MISMATCH_SKILL_MD, "utf8");
  await writeFile(join(root1, "gamma", "SKILL.md"), GAMMA_SKILL_MD, "utf8");
  await writeFile(join(root1, "big", "SKILL.md"), BIG_SKILL_MD, "utf8");
  for (let i = 1; i <= 512; i += 1) {
    await writeFile(join(root1, "big", `file-${String(i).padStart(3, "0")}.txt`), `file ${i}\n`, "utf8");
  }

  fixtureRoots = [root0, root1];
  client = startServer(fixtureRoots);
  await client.initialize();
});

after(async () => {
  await stopServer(client);
  await rm(dirname(fixtureRoots[0]), { recursive: true, force: true });
});

describe("initialize", () => {
  test("declares the io.modelcontextprotocol/skills extension with directoryRead", async () => {
    const result = await client.initialize();
    const extension = result.capabilities?.extensions?.[EXTENSION_ID];
    assert.deepEqual(extension, { directoryRead: true });
    assert.ok(result.capabilities?.resources, "resources capability must be declared");
  });
});

describe("skills/list", () => {
  test("returns conforming entries with verbatim frontmatter and complete resource manifests", async () => {
    const result = await client.call("skills/list", {});
    const skills = result.skills;
    assert.ok(Array.isArray(skills), "skills must be an array");

    alphaEntry = skills.find((s) => s.frontmatter?.name === "alpha");
    assert.ok(alphaEntry, "alpha must be listed");
    assert.equal(alphaEntry.uri, `skill://${AUTHORITY}/root0/alpha/SKILL.md`);
    assert.deepEqual(alphaEntry.frontmatter, {
      name: "alpha",
      description: "Alpha test skill",
      license: "MIT",
      metadata: { version: "1.2.3", tags: ["one", "two"] },
    });

    assert.ok(Array.isArray(alphaEntry.resources), "resources must be an array, never a string");
    const uris = alphaEntry.resources.map((r) => r.uri).sort();
    assert.deepEqual(uris, [
      `skill://${AUTHORITY}/root0/alpha/SKILL.md`,
      `skill://${AUTHORITY}/root0/alpha/references/GUIDE.md`,
      `skill://${AUTHORITY}/root0/alpha/scripts/run.sh`,
      `skill://${AUTHORITY}/root0/alpha/sub-skill/SKILL.md`,
      `skill://${AUTHORITY}/root0/alpha/sub-skill/extra.md`,
    ]);
    for (const resource of alphaEntry.resources) {
      assert.match(resource.digest, /^sha256:[0-9a-f]{64}$/, `digest format for ${resource.uri}`);
      assert.equal(typeof resource.size, "number");
      assert.ok(resource.size > 0);
    }
    const skillMd = alphaEntry.resources.find((r) => r.uri.endsWith("/SKILL.md"));
    assert.equal(skillMd.size, Buffer.byteLength(ALPHA_SKILL_MD, "utf8"));
    assert.equal(skillMd.digest, `sha256:${sha256hex(ALPHA_SKILL_MD)}`);

    subSkillEntry = skills.find((s) => s.frontmatter?.name === "sub-skill");
    assert.ok(subSkillEntry, "nested sub-skill gets its own listing entry");
    assert.equal(subSkillEntry.uri, `skill://${AUTHORITY}/root0/alpha/sub-skill/SKILL.md`);
    assert.deepEqual(
      subSkillEntry.resources.map((r) => r.uri).sort(),
      [`skill://${AUTHORITY}/root0/alpha/sub-skill/SKILL.md`, `skill://${AUTHORITY}/root0/alpha/sub-skill/extra.md`],
    );

    assert.ok(skills.some((s) => s.frontmatter?.name === "gamma"), "gamma from root1 must be listed");
    assert.ok(!skills.some((s) => s.frontmatter?.name === "different-name"), "name!=dir skill must be excluded");
    assert.ok(!skills.some((s) => s.uri.includes("mismatch-dir")), "mismatch-dir must not appear in any URI");
    assert.ok(!skills.some((s) => s.frontmatter?.name === "big"), "over-limit skill must be skipped");
    assert.match(client.stderrText, /big/, "over-limit skip must be logged to stderr");
  });
});

describe("skills/get", () => {
  test("returns the identical entry for a listed skill", async () => {
    const result = await client.call("skills/get", { uri: alphaEntry.uri });
    assert.deepEqual(result.skill, alphaEntry);
  });

  test("returns the entry for an unlisted-but-valid nested skill", async () => {
    const result = await client.call("skills/get", { uri: subSkillEntry.uri });
    assert.deepEqual(result.skill, subSkillEntry);
  });

  test("errors -32602 for an unknown skill URI", async () => {
    await assert.rejects(
      () => client.call("skills/get", { uri: `skill://${AUTHORITY}/root0/nope/SKILL.md` }),
      (error) => error.code === -32602,
    );
  });

  test("errors -32602 for a non-SKILL.md URI", async () => {
    await assert.rejects(
      () => client.call("skills/get", { uri: `skill://${AUTHORITY}/root0/alpha/references/GUIDE.md` }),
      (error) => error.code === -32602,
    );
  });
});

describe("resources/read", () => {
  test("returns SKILL.md bytes whose sha256 matches the manifest digest", async () => {
    const result = await client.call("resources/read", { uri: alphaEntry.uri });
    const content = result.contents?.[0];
    assert.ok(content, "contents[0] present");
    assert.equal(content.uri, alphaEntry.uri);
    assert.equal(content.mimeType, "text/markdown");
    assert.equal(sha256hex(content.text), alphaEntry.resources.find((r) => r.uri === alphaEntry.uri).digest.slice("sha256:".length));
  });

  test("returns supporting-file bytes whose sha256 matches the manifest digest", async () => {
    const uri = `skill://${AUTHORITY}/root0/alpha/sub-skill/extra.md`;
    const result = await client.call("resources/read", { uri });
    assert.equal(
      sha256hex(result.contents[0].text),
      alphaEntry.resources.find((r) => r.uri === uri).digest.slice("sha256:".length),
    );
  });

  test("rejects encoded traversal outside the skill directory", async () => {
    const uri = `skill://${AUTHORITY}/root0/alpha/%2e%2e/%2e%2e/root1/gamma/SKILL.md`;
    await assert.rejects(
      () => client.call("resources/read", { uri }),
      (error) => error.code === -32602,
    );
  });

  test("rejects an unknown resource URI", async () => {
    await assert.rejects(
      () => client.call("resources/read", { uri: `skill://${AUTHORITY}/root0/alpha/missing.md` }),
      (error) => error.code === -32602,
    );
  });
});

describe("resources/directory/read", () => {
  test("lists direct children of the skill root with directory mime types", async () => {
    const result = await client.call("resources/directory/read", { uri: `skill://${AUTHORITY}/root0/alpha` });
    const byName = new Map(result.resources.map((r) => [r.name, r]));
    assert.equal(result.resources.length, 4);
    assert.equal(byName.get("SKILL.md").mimeType, "text/markdown");
    assert.equal(byName.get("references").mimeType, "inode/directory");
    assert.equal(byName.get("scripts").mimeType, "inode/directory");
    assert.equal(byName.get("sub-skill").mimeType, "inode/directory");
  });

  test("lists direct children of a subdirectory", async () => {
    const result = await client.call("resources/directory/read", { uri: `skill://${AUTHORITY}/root0/alpha/references` });
    assert.deepEqual(result.resources.map((r) => r.name), ["GUIDE.md"]);
  });

  test("errors -32602 for a file URI", async () => {
    await assert.rejects(
      () => client.call("resources/directory/read", { uri: alphaEntry.uri }),
      (error) => error.code === -32602,
    );
  });

  test("errors -32602 for an unknown directory", async () => {
    await assert.rejects(
      () => client.call("resources/directory/read", { uri: `skill://${AUTHORITY}/root0/nope` }),
      (error) => error.code === -32602,
    );
  });
});

describe("legacy compatibility layer", () => {
  test("tools/call skills_list still answers with the legacy shape", async () => {
    const result = await client.call("tools/call", { name: "skills_list", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(payload), "legacy skills_list returns a bare array");
    const names = payload.map((s) => s.name);
    assert.ok(names.includes("alpha"));
    assert.ok(names.includes("different-name"), "legacy listing keeps the lenient name fallback");
    assert.ok(payload.every((s) => typeof s.uri === "string" && typeof s.sha256 === "string"));
  });

  test("tools/call resources_read still answers", async () => {
    const result = await client.call("tools/call", {
      name: "resources_read",
      arguments: { uri: `skill://${AUTHORITY}/root0/alpha/SKILL.md` },
    });
    const payload = JSON.parse(result.content[0].text);
    assert.match(payload.text, /Alpha/);
  });
});

describe("empty roots", () => {
  test("skills/list returns an empty array when no skills are served", async () => {
    const emptyBase = await mkdtemp(join(tmpdir(), "skillar-empty-"));
    const emptyRoot = join(emptyBase, "empty");
    await mkdir(emptyRoot, { recursive: true });
    const emptyClient = startServer([emptyRoot]);
    try {
      await emptyClient.initialize();
      const result = await emptyClient.call("skills/list", {});
      assert.deepEqual(result.skills, []);
    } finally {
      await stopServer(emptyClient);
      await rm(emptyBase, { recursive: true, force: true });
    }
  });
});

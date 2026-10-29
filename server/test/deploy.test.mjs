import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy, inventory } from "../deploy-runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "skillar-deploy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "server"));
  await mkdir(join(root, "skills"));
  await writeFile(join(root, "server/version"), "previous");
  await writeFile(join(root, "skills/user-content"), "preserve me");
  const stage = async id => {
    const dir = join(root, ".deploy", `stage-${id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "version"), "candidate");
    await writeFile(join(dir, "deployment.json"), JSON.stringify({ commit: "commit", artifact: "artifact", files: await inventory(dir) }));
    return { root, stage: dir, id };
  };
  let restarts = 0;
  const operations = { prepare: async () => {}, restart: async () => { restarts++; }, smoke: async () => ({ ok: true }), recoveryCheck: async () => {} };
  return { root, stage, operations, restarts: () => restarts };
}

test("deployment keeps a complete backup, preserves skills, and repeats without restarting", async t => {
  const f = await fixture(t);
  const result = await deploy(await f.stage("first"), f.operations);
  assert.equal(result.status, "deployed");
  assert.equal(await readFile(join(result.backup, "version"), "utf8"), "previous");
  assert.equal(await readFile(join(f.root, "skills/user-content"), "utf8"), "preserve me");
  assert.equal((await deploy(await f.stage("second"), f.operations)).status, "unchanged");
  assert.equal(f.restarts(), 1);
  await writeFile(join(f.root, "server/version"), "drift");
  assert.equal((await deploy(await f.stage("third"), f.operations)).status, "deployed", "matching metadata must not hide modified deployed files");
});

test("failed installation does not replace the server; failed smoke restores it", async t => {
  const f = await fixture(t);
  await assert.rejects(deploy(await f.stage("install"), { ...f.operations, prepare: async () => { throw new Error("npm failed"); } }), /failed-before-activation/);
  assert.equal(await readFile(join(f.root, "server/version"), "utf8"), "previous");
  await assert.rejects(deploy(await f.stage("smoke"), { ...f.operations, smoke: async () => { throw new Error("smoke failed"); } }), /rolled-back/);
  assert.equal(await readFile(join(f.root, "server/version"), "utf8"), "previous");
  assert.equal(await readFile(join(f.root, ".deploy/failed-smoke/version"), "utf8"), "candidate");
  assert.equal(f.restarts(), 2);
});

test("a recovery failure retains the journal and lock, preventing a blind retry", async t => {
  const f = await fixture(t);
  await assert.rejects(deploy(await f.stage("broken"), { ...f.operations, restart: async () => { throw new Error("launchd failed"); } }), /recovery-required/);
  await access(join(f.root, ".deploy/lock/owner.json"));
  assert.equal(JSON.parse(await readFile(join(f.root, ".deploy/broken.json"))).status, "recovery-required");
  await assert.rejects(deploy(await f.stage("retry"), f.operations), /EEXIST/);
  assert.equal(await readFile(join(f.root, "server/version"), "utf8"), "previous");
});

test("a tampered staging artifact is rejected before acquiring the deployment lock", async t => {
  const f = await fixture(t);
  const config = await f.stage("tampered");
  await writeFile(join(config.stage, "version"), "changed after validation");
  await assert.rejects(deploy(config, f.operations), /differs from the validated build/);
  await assert.rejects(access(join(f.root, ".deploy/lock")), /ENOENT/);
});

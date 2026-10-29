#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { inventory } from "../server/deploy-runtime.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.argv[2] ?? "macmini";
if (process.argv.length > 3 || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host)) throw new Error("Usage: scripts/deploy-macmini.sh [ssh-host]");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: repo, encoding: "utf8", stdio: "inherit", ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error ?? result.stderr ?? "see output above"}`);
  return result.stdout?.trim();
};
const git = (...args) => run("git", args, { stdio: "pipe" });
if (git("status", "--porcelain")) throw new Error("Commit or preserve local changes before deploying; the deployed commit must identify the complete source");
const commit = git("rev-parse", "HEAD");
for (const args of [["ci"], ["run", "build"], ["test"]]) run("npm", args, { cwd: join(repo, "server") });
if (git("status", "--porcelain") || git("rev-parse", "HEAD") !== commit) throw new Error("Source changed during validation; rerun from a clean commit");

const sshArgs = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const remote = command => run("ssh", [...sshArgs, command], { stdio: ["ignore", "pipe", "inherit"] });
const remoteHome = remote("printf '%s' \"$HOME\"");
const root = (process.env.SKILLAR_DEPLOY_ROOT ?? process.env.GISUL_DEPLOY_ROOT) ?? `${remoteHome}/gisul`;
const label = (process.env.SKILLAR_DEPLOY_LABEL ?? process.env.GISUL_DEPLOY_LABEL) ?? "com.iyendev.gisul-mcp";
// rsync's remote-shell path syntax needs a shell-safe, absolute destination.
if (!/^\/[A-Za-z0-9_./-]+$/.test(root) || !/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("Invalid SKILLAR_DEPLOY_ROOT or SKILLAR_DEPLOY_LABEL");
const id = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${commit.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
const stage = `${root}/.deploy/stage-${id}`;
const local = await mkdtemp(join(tmpdir(), "skillar-deploy-"));
try {
  const payload = join(local, "server");
  // Archive the validated commit so later edits cannot change the staged source.
  const archive = join(local, "source.tar");
  run("git", ["archive", "--format=tar", `--output=${archive}`, commit, "server"]);
  run("tar", ["-xf", archive, "-C", local]);
  await cp(join(repo, "server/dist"), join(payload, "dist"), { recursive: true });
  const files = await inventory(payload);
  const artifact = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  await writeFile(join(payload, "deployment.json"), JSON.stringify({ commit, artifact, files, canonicalSource: repo, createdAt: new Date().toISOString() }, null, 2) + "\n");
  remote(`mkdir -p ${quote(stage)}`);
  run("rsync", ["-a", "--delete", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=10", `${payload}/`, `${host}:${stage}/`]);
  const config = Buffer.from(JSON.stringify({ root, stage, label, id })).toString("base64");
  console.log(remote(`export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; node ${quote(`${stage}/deploy-runtime.mjs`)} ${quote(config)}`));
} catch (error) {
  // A lost SSH response does not imply a failed deployment. Do not blindly retry.
  console.error(`Inspect ${host}:${root}/.deploy/${id}.json and ${root}/.deploy/lock before retrying.`);
  throw error;
} finally {
  await rm(local, { recursive: true, force: true });
}

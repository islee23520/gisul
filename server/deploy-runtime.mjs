import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function inventory(root, relative = "") {
  const files = [];
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!relative && ["node_modules", "deployment.json"].includes(entry.name)) continue;
    const path = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else if (entry.isFile()) files.push({ path, digest: createHash("sha256").update(await readFile(join(root, path))).digest("hex"), mode: (await lstat(join(root, path))).mode & 0o777 });
    else throw new Error(`Deployment payload contains a non-regular file: ${path}`);
  }
  return files;
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error ?? result.stderr ?? ""}`);
  return result.stdout?.trim();
};
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

export async function deploy(config, operations) {
  const { root, stage, id } = config;
  if (!/^[A-Za-z0-9-]+$/.test(id) || resolve(stage) !== join(resolve(root), ".deploy", `stage-${id}`)) throw new Error("Invalid deployment staging path");
  const current = join(root, "server");
  const backup = join(root, ".deploy", `server.bak-${id}`);
  const failed = join(root, ".deploy", `failed-${id}`);
  const lock = join(root, ".deploy", "lock");
  const journal = join(root, ".deploy", `${id}.json`);
  const candidate = JSON.parse(await readFile(join(stage, "deployment.json"), "utf8"));
  if (JSON.stringify(await inventory(stage)) !== JSON.stringify(candidate.files)) throw new Error("Staged artifact differs from the validated build");
  await mkdir(lock); // Never steal a concurrent or interrupted deployment's lock.
  const state = { id, commit: candidate.commit, artifact: candidate.artifact, current, backup, stage, status: "prepared" };
  const record = async status => {
    state.status = status;
    await writeFile(`${journal}.tmp`, JSON.stringify(state, null, 2) + "\n");
    await rename(`${journal}.tmp`, journal);
  };
  let backedUp = false;
  let activated = false;
  let recovered = true;
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ id, pid: process.pid, journal }));
    await record("prepared");
    if (!await exists(current) || (await lstat(current)).isSymbolicLink()) throw new Error("Expected an existing, non-symlink server directory");
    if (await exists(join(current, "deployment.json"))) {
      const previous = JSON.parse(await readFile(join(current, "deployment.json"), "utf8"));
      if (previous.artifact === candidate.artifact && previous.commit === candidate.commit && JSON.stringify(await inventory(current)) === JSON.stringify(candidate.files)) {
        state.smoke = await operations.smoke(current);
        await record("unchanged");
        await rm(stage, { recursive: true });
        return state;
      }
    }
    await operations.prepare(stage);
    await record("activating");
    await rename(current, backup);
    backedUp = true;
    await rename(stage, current);
    activated = true;
    await operations.restart();
    state.smoke = await operations.smoke(current);
    await record("deployed");
    return state;
  } catch (error) {
    state.error = String(error);
    if (backedUp) {
      try {
        if (activated) await rename(current, failed);
        await rename(backup, current);
        await operations.restart();
        await operations.recoveryCheck(current);
        await record("rolled-back");
      } catch (rollbackError) {
        recovered = false;
        state.rollbackError = String(rollbackError);
        await record("recovery-required");
      }
    } else await record("failed-before-activation");
    throw new Error(`Deployment ${state.status}: ${error}; journal: ${journal}`);
  } finally {
    if (recovered) await rm(lock, { recursive: true, force: true });
  }
}

async function main() {
  const config = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
  if (!/^[A-Za-z0-9._-]+$/.test(config.label)) throw new Error("Invalid launchd label");
  const service = `gui/${process.getuid()}/${config.label}`;
  run("launchctl", ["print", service]);
  const plist = join(homedir(), "Library/LaunchAgents", `${config.label}.plist`);
  if (resolve(run("plutil", ["-extract", "WorkingDirectory", "raw", "-o", "-", plist])) !== join(resolve(config.root), "server")) throw new Error("launchd WorkingDirectory does not match the deployment target");
  const env = { ...process.env, ...JSON.parse(run("plutil", ["-extract", "EnvironmentVariables", "json", "-o", "-", plist])) };
  const healthUrl = `http://127.0.0.1:${env.PORT ?? 8788}/healthz`;
  const health = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        const data = await response.json();
        if (response.ok && data.ok && data.service === "skillar") return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("HTTP health check failed");
  };
  const restart = async () => {
    try { run("launchctl", ["kickstart", "-k", service], { timeout: 15000 }); }
    catch {
      // Re-query after an ambiguous restart; a failed spawn can leave kickstart waiting.
      run("launchctl", ["print", service], { timeout: 5000 });
      console.error("kickstart failed or timed out; reloading the same LaunchAgent");
      run("launchctl", ["bootout", service], { timeout: 15000 });
      run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { timeout: 15000 });
    }
  };
  const result = await deploy(config, {
    prepare: async stage => {
      await access(join(stage, "bin/skillar"), constants.X_OK);
      run("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: stage, timeout: 180000 });
    },
    restart,
    recoveryCheck: health,
    smoke: async current => {
      await health();
      const { smokeServer } = await import(pathToFileURL(join(current, "smoke-server.mjs")).href);
      return smokeServer({ root: current, env, httpUrl: healthUrl.replace("/healthz", "/mcp") });
    },
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(String(error)); process.exitCode = 1; });

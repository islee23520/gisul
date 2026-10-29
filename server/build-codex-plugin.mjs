import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../clients/codex/plugin/skillar/", import.meta.url);
await mkdir(new URL("runtime/", packageRoot), { recursive: true });
await mkdir(new URL("skills/skillar/", packageRoot), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("src/codex.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("runtime/codex.mjs", packageRoot)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
await copyFile(new URL("../clients/codex/skillar/SKILL.md", import.meta.url), new URL("skills/skillar/SKILL.md", packageRoot));
await copyFile(new URL("../LICENSE", import.meta.url), new URL("LICENSE", packageRoot));
console.log(`Built self-contained Codex plugin: ${fileURLToPath(packageRoot)}`);

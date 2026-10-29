import type { RuntimePack } from "../types.js";
import { createPiPack, resolveGajaeAgentDir } from "./omo.js";

export const gajaePack: RuntimePack = createPiPack({
  id: "gajae",
  agentDir: resolveGajaeAgentDir,
  extensionName: "skillar",
  installMarker: ".gjc",
});

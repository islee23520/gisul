// Client identity broker: per-connection clientInfo captured from the stdio
// initialize request, exposed to tool handlers as a separate advisory field.
// Skill bytes are never modified; guidance is additive only.
//
// Identity resolution order per connection:
//   1. GISUL_CLIENT_HINT env (per-process; deterministic for single-connection stdio)
//   2. initialize params.clientInfo.name
//   3. neutral (unknown)
//
// HTTP request paths construct a fresh server per request and never pass an
// initialize through ServerProtocolTransport in a way handlers can see, so HTTP
// connections stay neutral unless the env hint is set for that process.

export type ClientKind = "codex" | "openai" | "omp" | "omo" | "claude" | "unknown";

export type ClientIdentity = {
  kind: ClientKind;
  name: string | undefined;
  version: string | undefined;
  source: "env-hint" | "initialize" | "unknown";
};

export const NEUTRAL_IDENTITY: ClientIdentity = { kind: "unknown", name: undefined, version: undefined, source: "unknown" };

export function classifyClientName(rawName: string | undefined): ClientKind {
  const name = (rawName ?? "").toLowerCase();
  if (!name) return "unknown";
  if (name === "codex" || name.startsWith("codex_") || name.startsWith("codex-") || name.includes("codex_cli")) return "codex";
  if (name.includes("claude")) return "claude";
  if (name === "omp" || name.includes("oh-my-pi")) return "omp";
  if (name === "omo" || name.includes("oh-my-openagent")) return "omo";
  if (name.includes("openai") && !name.includes("codex")) return "openai";
  return "unknown";
}

export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): ClientIdentity | undefined {
  const hint = (env.GISUL_CLIENT_HINT ?? "").trim();
  if (!hint) return undefined;
  const [name, version] = hint.split("@");
  if (!name) return undefined;
  return { kind: classifyClientName(name), name, version: version || undefined, source: "env-hint" };
}

// Verified capability guidance keyed by client kind. No inference from client
// name alone: every entry names a capability we verified in this deployment.
export type ClientGuidance = {
  kind: ClientKind;
  imageGeneration: "client-tool" | "unknown";
  imageToolHint: string | undefined;
  imageViewHint: string | undefined;
  notes: string[];
};

export const GUIDANCE: Record<ClientKind, ClientGuidance> = {
  codex: {
    kind: "codex",
    imageGeneration: "client-tool",
    imageToolHint: "built-in image_gen tool; raw output lands under $CODEX_HOME/generated_images",
    imageViewHint: "view_image for local reference files",
    notes: ["Product-specific Codex guidance in skills (plugin formats, CODEX_HOME paths) is authoritative."],
  },
  openai: {
    kind: "openai",
    imageGeneration: "client-tool",
    imageToolHint: "OpenAI client image generation tooling",
    imageViewHint: undefined,
    notes: [],
  },
  omp: {
    kind: "omp",
    imageGeneration: "client-tool",
    imageToolHint: "xd://generate_image device",
    imageViewHint: "attach/read the image so it is visible in conversation context",
    notes: ["Use available image device; skill prose stays client-neutral."],
  },
  omo: {
    kind: "omo",
    imageGeneration: "unknown",
    imageToolHint: undefined,
    imageViewHint: undefined,
    notes: ["Resolve image generation via installed OMO plugins; no fixed tool name."],
  },
  claude: {
    kind: "claude",
    imageGeneration: "unknown",
    imageToolHint: undefined,
    imageViewHint: undefined,
    notes: [],
  },
  unknown: {
    kind: "unknown",
    imageGeneration: "unknown",
    imageToolHint: undefined,
    imageViewHint: undefined,
    notes: ["Use whatever image-generation capability the current client exposes; do not assume a specific tool name."],
  },
};

export function guidanceFor(identity: ClientIdentity): ClientGuidance {
  return GUIDANCE[identity.kind];
}

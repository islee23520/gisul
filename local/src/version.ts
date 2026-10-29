export class SkillarStartupError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillarStartupError";
    this.code = code;
  }
}

export const MIN_NODE: readonly [number, number] = [24, 15];

export function assertNodeVersion(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new SkillarStartupError("node_too_old", `skillar needs Node >= ${MIN_NODE.join(".")}, found ${version}`);
  }
}

export function assertPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") throw new SkillarStartupError("unsupported_platform", "skillar supports macOS and Linux");
}

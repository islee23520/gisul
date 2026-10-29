/** Persisted payloads are immutable; old rows keep their original field name. */
export function isSkillarMcpData(data: Record<string, unknown>): boolean {
  return (data.skillarMcp ?? data.gisoolMcp) === true;
}

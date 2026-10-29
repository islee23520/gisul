import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

export const MODERN_VERSION = "2026-07-28";
export const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
export const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
export const CACHE_METHODS = new Set(["server/discover", "skills/list", "skills/get", "resources/read", "resources/list", "resources/templates/list", "tools/list", "prompts/list"]);
export const cacheHints = { ttlMs: 30_000, cacheScope: "private" as const };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function modernParams(params: Record<string, unknown> = {}) {
  return { ...params, _meta: { ...(isObject(params._meta) ? params._meta : {}), [VERSION_KEY]: MODERN_VERSION, [CAPS_KEY]: {}, "io.modelcontextprotocol/clientInfo": { name: "skillar-codex-reader", version: "0.2.0" } } };
}
export function modernError(message: JSONRPCRequest) {
  const meta = message.params?._meta;
  if (!isObject(meta) || typeof meta[VERSION_KEY] !== "string" || !isObject(meta[CAPS_KEY])) return { code: -32602, message: "Required protocolVersion and clientCapabilities metadata is missing or invalid" };
  if (meta[VERSION_KEY] !== MODERN_VERSION) return { code: -32022, message: "Unsupported protocol version", data: { supported: [MODERN_VERSION], requested: meta[VERSION_KEY] } };
}
export function isModern(message: JSONRPCMessage) {
  return "method" in message && (message.method === "server/discover" || VERSION_KEY in (message.params?._meta ?? {}) || CAPS_KEY in (message.params?._meta ?? {}));
}

// Adapt the pinned SDK's transport boundary; business handlers remain shared by both eras.
export class ServerProtocolTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onerror?: Transport["onerror"];
  onclose?: Transport["onclose"];
  private legacyInitialized = false;
  private requests = new Map<string | number, { method: string; modern: boolean }>();
  // Client identity broker state: captured once from the initialize request.
  clientIdentity: { name?: string; version?: string } | undefined;
  constructor(private inner: Transport, legacyHttp = false) { this.legacyInitialized = legacyHttp; }
  async start() {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = error => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => {
      if ("method" in message && "id" in message) {
        if (message.method === "initialize") {
          this.legacyInitialized = true;
          const info = (message.params as { clientInfo?: { name?: string; version?: string } } | undefined)?.clientInfo;
          if (info && typeof info.name === "string") this.clientIdentity = { name: info.name, version: typeof info.version === "string" ? info.version : undefined };
        }
        const modern = isModern(message) || (!this.legacyInitialized && message.method !== "initialize");
        const error = modern ? modernError(message) : undefined;
        if (error) { void this.inner.send({ jsonrpc: "2.0", id: message.id, error }).catch(e => this.onerror?.(e)); return; }
        this.requests.set(message.id, { method: message.method, modern });
      }
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    if ("id" in message) {
      const request = this.requests.get(message.id!);
      this.requests.delete(message.id!);
      if (request && "result" in message) {
        message = { ...message, result: { ...message.result, resultType: "complete", ...(CACHE_METHODS.has(request.method) ? cacheHints : {}), ...(request.modern ? { _meta: { ...message.result._meta, "io.modelcontextprotocol/serverInfo": { name: "skillar", version: "0.2.0" } } } : {}) } };
      }
    }
    await this.inner.send(message, options);
  }
  async close() { this.requests.clear(); await this.inner.close(); }
}

export class NegotiatingTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onerror?: Transport["onerror"];
  onclose?: Transport["onclose"];
  modern = false;
  private probe?: JSONRPCRequest;
  private timer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string | number, string>();
  private probeId = "skillar-discovery-probe";
  constructor(private inner: Transport, private timeoutMs = 5000) {}
  async start() {
    this.inner.onclose = () => { clearTimeout(this.timer); this.onclose?.(); };
    this.inner.onerror = error => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => {
      if ("id" in message && message.id === this.probeId) {
        if (!this.probe) return; // Ignore a late probe response after fallback.
        clearTimeout(this.timer);
        const init = this.probe; this.probe = undefined;
        if ("error" in message) {
          if ([-32020, -32021, -32022].includes(message.error.code)) {
            this.onmessage?.({ ...message, id: init.id });
          } else { void this.inner.send(init).catch(error => this.onerror?.(error)); }
          return;
        }
        if (!("result" in message) || !Array.isArray(message.result.supportedVersions) || !message.result.supportedVersions.includes(MODERN_VERSION) || !isObject(message.result.capabilities)) {
          this.onmessage?.({ jsonrpc: "2.0", id: init.id, error: { code: -32603, message: "No supported modern protocol or invalid discovery result" } }); return;
        }
        try { validateResult(message.result, true, true); } catch (error) {
          this.onmessage?.({ jsonrpc: "2.0", id: init.id, error: { code: -32603, message: String(error) } }); return;
        }
        this.modern = true;
        this.inner.setProtocolVersion?.(MODERN_VERSION);
        // Synthetic legacy result is local to the SDK, never sent over the wire.
        this.onmessage?.({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2025-11-25", capabilities: message.result.capabilities, serverInfo: message.result._meta?.["io.modelcontextprotocol/serverInfo"] ?? { name: "skillar-upstream", version: "unknown" }, instructions: message.result.instructions } });
        return;
      }
      if ("id" in message) {
        const method = this.pending.get(message.id!); this.pending.delete(message.id!);
        if (method && "result" in message) {
          try { validateResult(message.result, this.modern, CACHE_METHODS.has(method)); }
          catch (error) { this.onmessage?.({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error) } }); return; }
        }
      }
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    if ("method" in message && message.method === "initialize" && "id" in message) {
      this.probe = message;
      this.timer = setTimeout(() => {
        const init = this.probe; this.probe = undefined;
        if (init) void this.inner.send(init).catch(error => this.onerror?.(error));
      }, this.timeoutMs);
      try { await this.inner.send({ jsonrpc: "2.0", id: this.probeId, method: "server/discover", params: modernParams() }); }
      catch (error) { clearTimeout(this.timer); this.probe = undefined; throw error; }
      return;
    }
    if (this.modern && "method" in message) {
      if (message.method === "notifications/initialized") return;
      if ("id" in message) message = { ...message, params: modernParams(message.params) };
    }
    if ("method" in message && "id" in message && message.method !== "initialize") this.pending.set(message.id, message.method);
    await this.inner.send(message, options);
  }
  setProtocolVersion(version: string) { this.inner.setProtocolVersion?.(this.modern ? MODERN_VERSION : version); }
  async close() { clearTimeout(this.timer); this.pending.clear(); await this.inner.close(); }
}

export function validateResult(result: Record<string, unknown>, modern: boolean, cacheable: boolean) {
  if ((modern || result.resultType !== undefined) && result.resultType !== "complete") throw new Error("Invalid or unsupported resultType");
  if (modern && cacheable && (!Number.isSafeInteger(result.ttlMs) || Number(result.ttlMs) < 0 || !["private", "public"].includes(String(result.cacheScope)))) throw new Error("Missing or invalid cache hints");
}
export function encodeHeader(value: string) {
  return /^[\x20-\x7e\t]+$/.test(value) && value.trim() === value && !/^=\?base64\?.*\?=$/.test(value) ? value : `=?base64?${Buffer.from(value).toString("base64")}?=`;
}
export function decodeHeader(value: string | undefined) {
  if (!value?.startsWith("=?base64?")) return value;
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (!match || Buffer.from(match[1], "base64").toString("base64") !== match[1]) return undefined;
  return Buffer.from(match[1], "base64").toString("utf8");
}
// Keep the SDK's JSON/SSE parser and legacy fallback, adding modern HTTP headers.
export const protocolFetch: typeof fetch = async (input, init) => {
  const message = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  if (!message || !isModern(message)) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("MCP-Protocol-Version", message.params._meta[VERSION_KEY]);
  headers.set("Mcp-Method", message.method);
  if (["tools/call", "resources/read", "prompts/get"].includes(message.method)) headers.set("Mcp-Name", encodeHeader(message.params.name ?? message.params.uri));
  const response = await fetch(input, { ...init, headers });
  if ([400, 404].includes(response.status)) {
    const body = await response.clone().json().catch(() => undefined);
    if (body?.error && body.id === message.id) {
      const parsed = JSONRPCMessageSchema.safeParse(body);
      if (parsed.success) return new Response(JSON.stringify(parsed.data), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (message.method === "server/discover") return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Legacy HTTP endpoint" } }), { headers: { "content-type": "application/json" } });
  }
  return response;
};

// One cache per bridge/client, so neither upstreams nor credentials can share entries.
export class ResponseCache {
  private entries = new Map<string, { expires: number; value: Record<string, unknown>; bytes: number }>();
  private bytes = 0;
  private generation = 0;
  constructor(private now = () => performance.now(), private maxBytes = 32 * 1024 * 1024) {}
  clear() { this.generation++; this.entries.clear(); this.bytes = 0; }
  async read<T extends Record<string, unknown>>(method: string, params: Record<string, unknown>, fetchResult: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([method, params]);
    const held = this.entries.get(key);
    if (held && this.now() < held.expires) return structuredClone(held.value) as T;
    if (held) { this.entries.delete(key); this.bytes -= held.bytes; }
    const generation = this.generation;
    const value = await fetchResult();
    validateResult(value, false, true);
    const ttl = value.ttlMs;
    if (generation === this.generation && CACHE_METHODS.has(method) && !params.inputResponses && !params.requestState && Number.isSafeInteger(ttl) && Number(ttl) > 0 && ["private", "public"].includes(String(value.cacheScope))) {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes <= this.maxBytes) {
        while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= 256)) {
          const first = this.entries.keys().next().value!; this.bytes -= this.entries.get(first)!.bytes; this.entries.delete(first);
        }
        // Concurrent misses may replace the same key.
        const previous = this.entries.get(key); if (previous) this.bytes -= previous.bytes;
        this.entries.set(key, { expires: this.now() + Number(ttl), value: structuredClone(value), bytes }); this.bytes += bytes;
      }
    }
    return value;
  }
}

/**
 * Verified wire protocol of the harness web profile (v0.1.0-rc.6):
 *
 *   unary RPC:  POST {base}/api/{method}
 *               body { type: "client-request", rpcId: <uuid>, method, payload }
 *               resp { type: "server-response", rpcId, result: { ok: true, value } | { ok: false, error } }
 *   respond:    POST {base}/api/respond            (client answers an approval/question)
 *   downlink:   /api/events.mux and /api/events.host  (WebSocket in browser, SSE in Node)
 *
 * Zero runtime dependencies on purpose: this package is the contract both apps share.
 */
import type { MethodName, Methods } from "./methods.js";

export const API_PATH = "/api";
export const MUX_EVENTS_PATH = "/api/events.mux";
export const HOST_EVENTS_PATH = "/api/events.host";
export const RESPOND_PATH = "/api/respond";

export interface ClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

export interface RpcError {
  code: string;
  message: string;
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export interface ServerResponse<T = unknown> {
  type: "server-response";
  rpcId: string;
  result: RpcResult<T>;
}

export class RpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTransportError";
  }
}

export class RpcCallError extends Error {
  readonly code: string;
  constructor(error: RpcError) {
    super(error.message);
    this.name = "RpcCallError";
    this.code = error.code;
  }
}

export interface HarnessClientOptions {
  /** e.g. "http://127.0.0.1:3080" */
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  /** default per-call timeout ms */
  timeoutMs?: number;
}

export function mintRpcId(): string {
  return globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + "-" + Math.random().toString(36).slice(2);
}

/**
 * Thin unary-RPC client for the harness API. Typed for known methods,
 * open for anything else.
 */
export class HarnessClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: HarnessClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    // 浏览器中 fetch 必须以 window 为 this 调用，否则抛 "Illegal invocation"
    this.fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Typed call for known methods. */
  call<K extends MethodName>(method: K, payload: Methods[K]["payload"]): Promise<Methods[K]["value"]>;
  /** Untyped call for anything else (new harness methods, etc.). */
  call(method: string, payload?: unknown): Promise<unknown>;
  async call(method: string, payload: unknown = {}): Promise<unknown> {
    const rpcId = mintRpcId();
    const message: ClientRequest = { type: "client-request", rpcId, method, payload };
    const url = new URL(API_PATH + "/" + method, this.baseUrl);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new RpcTransportError("transport failure for " + method + ": HTTP " + response.status);
    }
    const full = (await response.json()) as ServerResponse;
    if (full.type !== "server-response") {
      throw new RpcTransportError("unexpected envelope for " + method + ": " + JSON.stringify(full).slice(0, 200));
    }
    if (!full.result.ok) {
      throw new RpcCallError(full.result.error);
    }
    return full.result.value;
  }
}

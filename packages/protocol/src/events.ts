/**
 * Downlink event frames from the harness, verified against the live web profile.
 *
 * Two streams exist:
 *   /api/events.mux  — per-session multiplexed frames (session events, approvals, questions)
 *   /api/events.host — host-level frames (boot/profiles/etc.)
 *
 * Browser carrier: WebSocket. Node carrier: SSE (streaming fetch, "\n\n" framing) —
 * the harness client ships both; we expose one adapter that picks what the
 * environment supports.
 */

export interface AskUserQuestionItem {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  intent?: { kind: "plan-review"; approve: string } | Record<string, unknown>;
}

export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** MuxFrame union (payload slot of a mux-stream ServerRequest). */
export type MuxFrame =
  | { type: "session/event"; sessionId: string; event: unknown; view?: unknown }
  | { type: "session/subscribed"; sessionId: string; lastSeq: number }
  | {
      type: "approval/requested";
      sessionId: string;
      approvalId: string;
      toolName: string;
      callId?: string;
      reason?: string;
    }
  | { type: "approval/resolved"; sessionId: string; approvalId: string; outcome: ApprovalOutcome }
  | { type: "question/requested"; sessionId: string; questions: AskUserQuestionItem[] }
  | { type: "question/resolved"; sessionId: string; questionId: string }
  | { type: string; [k: string]: unknown }; // open tail: newer harness versions add frames

export type HostFrame = { type: string; [k: string]: unknown };

export type FrameKind = "mux" | "host";

export interface HarnessStreamOptions {
  baseUrl: string;
  kind?: FrameKind;
  /** initial subscription payload (which sessions to follow); harness default is fine for now */
  payload?: unknown;
  signal?: AbortSignal;
}

/**
 * Open the downlink stream as an async iterable of frames.
 * Uses WebSocket when available (browser, and Node 22+ with --experimental-websocket),
 * otherwise falls back to SSE over streaming fetch — the same dual path the
 * harness's own client implements.
 */
export async function* harnessFrames(options: HarnessStreamOptions): AsyncGenerator<MuxFrame | HostFrame> {
  const kind = options.kind ?? "mux";
  const path = kind === "mux" ? MUX_EVENTS_PATH : HOST_EVENTS_PATH;
  if (typeof globalThis.WebSocket !== "undefined") {
    yield* framesViaWebSocket(path, options.baseUrl, options.signal);
    return;
  }
  yield* framesViaSse(path, options.baseUrl, options.signal);
}

async function* framesViaWebSocket(path: string, baseUrl: string, signal?: AbortSignal): AsyncGenerator<MuxFrame | HostFrame> {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const inbox: (MuxFrame | HostFrame)[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const push = (frame: MuxFrame | HostFrame) => {
    inbox.push(frame);
    wake?.();
    wake = undefined;
  };
  socket.onmessage = (event) => {
    try {
      push(JSON.parse(String(event.data)));
    } catch {
      // ignore malformed frames
    }
  };
  const close = () => {
    closed = true;
    wake?.();
  };
  socket.onclose = close;
  socket.onerror = close;
  if (signal) {
    signal.addEventListener("abort", () => {
      socket.close();
      close();
    }, { once: true });
  }
  try {
    while (!closed) {
      if (inbox.length > 0) {
        const frame = inbox.shift();
        if (frame !== undefined) yield frame;
        continue;
      }
      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    socket.close();
  }
}

/** SSE fallback for Node: streaming fetch, "\n\n" frame separation, JSON payload lines. */
async function* framesViaSse(path: string, baseUrl: string, signal?: AbortSignal): AsyncGenerator<MuxFrame | HostFrame> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error("harness stream failed: HTTP " + response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const jsonLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!jsonLine) continue;
        try {
          yield JSON.parse(jsonLine.slice(5).trim());
        } catch {
          // ignore malformed frames
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

import { MUX_EVENTS_PATH, HOST_EVENTS_PATH } from "./transport.js";

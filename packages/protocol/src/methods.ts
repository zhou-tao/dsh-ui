/**
 * RPC method surface of the harness web profile (apiproxy), verified live against
 * v0.1.0-rc.6 on 2026-08-17. Wire form: POST /api/{method} with a client-request
 * envelope (see transport.ts).
 *
 * The value types below are the parts of each response we have confirmed from the
 * running server; unconfirmed fields stay unknown so the client stays compatible
 * across harness releases. Extend as you verify more.
 */

export interface HostDescribeValue {
  version: string;
  cwd: string;
  provider: string;
  model: string;
  attachedSessions: number;
  canOpenPath: boolean;
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd: string;
  agentPreset: string;
  projections: Record<string, unknown>;
}

export interface SkillEntry {
  name: string;
  description: string;
  whenToUse?: string;
  modelInvocable: boolean;
}

export interface SettingsNamespaceView {
  ns: string;
  schema: unknown;
  value: unknown;
  base?: unknown;
  user?: unknown;
  applies: "session" | "workspace" | "host" | (string & {});
}

/** Content block inside a message (text / reasoning / tool-result / …). */
export interface ContentBlock {
  type: string;
  text?: string;
  content?: unknown;
  [k: string]: unknown;
}

/** One event in a session log. Taxonomy verified live from session.history. */
export type SessionEvent =
  | {
      type: "user/message";
      seq: number;
      time: number;
      data: { role: "user"; id: string; content: ContentBlock[]; source?: unknown };
    }
  | {
      type: "assistant/message";
      seq: number;
      time: number;
      data: { turn: number; step: number; message: { role: "assistant"; content: ContentBlock[] } };
    }
  | { type: "assistant/chunk"; seq: number; time: number; data: { turn: number; step: number; chunk: unknown } }
  | {
      type: "tool/call";
      seq: number;
      time: number;
      data: { turn: number; step: number; callId: string; name: string; arguments: string };
    }
  | {
      type: "tool/result";
      seq: number;
      time: number;
      data: { turn: number; step: number; message: { source: unknown; content: ContentBlock[] } };
    }
  | { type: "turn/start"; seq: number; time: number; data: { turn: number } }
  | { type: "turn/end"; seq: number; time: number; data: { turn: number; reason?: unknown } }
  | { type: "step/start"; seq: number; time: number; data: { turn: number; step: number } }
  | { type: "step/end"; seq: number; time: number; data: { turn: number; step: number } }
  | { type: "todo/write"; seq: number; time: number; data: unknown }
  | { type: "goal/change"; seq: number; time: number; data: unknown }
  | { type: string; seq: number; time: number; data: unknown }; // open tail: newer event types

/** Item of session.history: an event wrapped by the API. */
export interface SessionHistoryEvent {
  event: SessionEvent;
}

export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title?: string;
  sessionIds: string[];
  order?: unknown[];
}

/** Typed view of every RPC method: payload in, value out. Loose by design. */
export interface Methods {
  // ---- host ----
  "host.describe": { payload: Record<string, never>; value: HostDescribeValue };
  // ---- session ----
  "session.list": { payload: Record<string, never> | { workspaceId?: string }; value: { items: SessionSummary[] } };
  "session.create": { payload: { workspaceId?: string; cwd?: string; agentPreset?: string; prompt?: string }; value: { sessionId: string } };
  "session.prompt": { payload: { sessionId: string; prompt: string }; value: unknown };
  "session.cancel": { payload: { sessionId: string }; value: { accepted: true } };
  "session.rename": { payload: { sessionId: string; title: string }; value: unknown };
  // 注意：实测 limit/afterSeq 当前被服务端忽略，返回固定尾部窗口（~4 万条），客户端自行截断
  "session.history": { payload: { sessionId: string; afterSeq?: number; limit?: number }; value: { events: SessionHistoryEvent[] } };
  "session.search": { payload: { query: string }; value: unknown };
  "session.fork": { payload: { sessionId: string }; value: unknown };
  "session.attachment": { payload: Record<string, unknown>; value: unknown };
  "session.models": { payload: { sessionId?: string }; value: unknown };
  // ---- workspace ----
  "workspace.list": { payload: Record<string, never>; value: { items: WorkspaceView[] } };
  "workspace.create": { payload: { name: string }; value: { workspace: WorkspaceView } };
  "workspace.rename": { payload: { workspaceId: string; name: string }; value: { workspace: WorkspaceView } };
  "workspace.delete": { payload: { workspaceId: string }; value: { deleted: true } };
  // ---- goal ----
  "goal.create": { payload: { sessionId: string; objective: string; maxGoalRounds?: number }; value: unknown };
  "goal.edit": { payload: { sessionId: string; ref: string; objective: string; maxGoalRounds?: number }; value: unknown };
  "goal.pause": { payload: { sessionId: string; ref: string }; value: unknown };
  "goal.resume": { payload: { sessionId: string; ref: string }; value: unknown };
  "goal.complete": { payload: { sessionId: string; ref: string }; value: unknown };
  "goal.clear": { payload: { sessionId: string }; value: { cleared: true } };
  // ---- settings ----
  "settings.describe": { payload: { ns: string }; value: SettingsNamespaceView };
  "settings.update": { payload: { ns: string; path: string[]; value: unknown }; value: unknown };
  "settings.mutate": { payload: { ns: string; path: string[]; value: unknown }; value: unknown };
  "settings.replace": { payload: { ns: string; value: unknown }; value: unknown };
  // ---- credentials ----
  "credentials.describe": { payload: { provider: string }; value: unknown };
  "credentials.set": { payload: { provider: string; key: string; value: string }; value: unknown };
  "credentials.unset": { payload: { provider: string; key: string }; value: unknown };
  // ---- llm ----
  "llm.providers": { payload: Record<string, never>; value: unknown };
  "llm.models": { payload: { provider?: string }; value: unknown };
  // ---- skill ----
  "skill.list": { payload: { sessionId: string }; value: { skills: SkillEntry[] } };
  // ---- subagent ----
  "subagent.list": { payload: { sessionId?: string }; value: unknown };
  "subagent.history": { payload: { sessionId: string; subagentId: string }; value: unknown };
  "subagent.prompt": { payload: { sessionId: string; subagentId: string; prompt: string }; value: unknown };
  "subagent.interrupt": { payload: { sessionId: string; subagentId: string }; value: unknown };
}

export type MethodName = keyof Methods;

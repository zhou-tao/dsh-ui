/**
 * 共享的会话事件 → 展示行 渲染辅助（TUI 与移动端 H5 共用）。
 * 纯逻辑、零依赖，只负责把事件变成可读文本行。
 */
import type { ContentBlock, SessionEvent } from "./methods.js";

/** 渲染结果：一行文本 + 可选色调。 */
export interface RenderLine {
  text: string;
  tone?: "dim" | "ok" | "err" | "accent";
}

/** 从消息 content blocks 中提取可读文本（递归收集 type === "text" 的块）。 */
export function textFromBlocks(blocks: unknown): string {
  const parts: string[] = [];
  const walk = (b: unknown): void => {
    if (Array.isArray(b)) {
      for (const x of b) walk(x);
      return;
    }
    if (b !== null && typeof b === "object") {
      const o = b as Record<string, unknown>;
      if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
      walk(o.content);
    }
  };
  walk(blocks);
  return parts.join("\n").trim();
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/** 会话列表展示标题（与 harness 桌面端 displayTitleOf 规则一致）：
 * 1) 持久化标题（projections.values.title）优先；2) 否则取 cwd 最后一段目录名；3) 否则回退 sessionId。 */
export function sessionDisplayTitle(s: {
  sessionId: string;
  cwd?: string;
  projections?: Record<string, unknown>;
}): string {
  const title = s.projections?.values;
  if (title && typeof (title as { title?: unknown }).title === 'string') {
    const t = (title as { title: string }).title;
    if (t.trim() !== '') return t;
  }
  if (s.cwd) {
    const base = s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (base) return base;
  }
  return s.sessionId;
}


/** 对话展示项：完整消息（user/ai 保留原始文本，供客户端做 markdown 渲染）或结构行。 */
export type ConversationItem =
  | { kind: 'user'; text: string }
  | { kind: 'ai'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'dim'; text: string }
  | { kind: 'err'; text: string };

/** 展示噪声事件：流式分片、模型请求元数据、会话标题、启动/权限快照等，渲染时跳过。 */
export const CONVERSATION_NOISE_TYPES = new Set<string>([
  'assistant/chunk',
  'step/start',
  'request/header',
  'request/context',
  'session/title',
  'session/title-llm-request',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent/inbox/spliced',
  'tool/code-dispatch',
  'tool/code-dispatch-start',
]);

/** 从历史事件组装对话（过滤噪声、截取最近 max 条可展示事件）。
 *  user/ai 文本保留 markdown 原文；结构行与 renderSessionEvent 一致。 */
export function conversationItems(events: SessionEvent[], opts: { max?: number } = {}): ConversationItem[] {
  const meaningful = events.filter((e) => !CONVERSATION_NOISE_TYPES.has(e.type));
  const tail = opts.max !== undefined ? meaningful.slice(-opts.max) : meaningful;
  const out: ConversationItem[] = [];
  for (const e of tail) {
    switch (e.type) {
      case 'user/message': {
        const d = e.data as { content?: unknown };
        const txt = textFromBlocks(d.content).trim();
        if (txt) out.push({ kind: 'user', text: txt });
        break;
      }
      case 'assistant/message': {
        const d = e.data as { message?: { content?: unknown } };
        const txt = textFromBlocks(d.message?.content).trim();
        if (txt) out.push({ kind: 'ai', text: txt });
        break;
      }
      case 'tool/call': {
        const d = e.data as { name?: string; arguments?: string };
        out.push({ kind: 'tool', text: '⚙ ' + (d.name ?? '?') + '(' + truncate(String(d.arguments ?? ''), 90) + ')' });
        break;
      }
      case 'tool/result': {
        const d = e.data as { message?: { content?: unknown } };
        out.push({ kind: 'dim', text: '  ↳ ' + truncate(textFromBlocks(d.message?.content) || '(无文本)', 220) });
        break;
      }
      case 'turn/start': {
        const d = e.data as { turn?: number };
        out.push({ kind: 'dim', text: '—— turn ' + (d.turn ?? '?') + ' ——' });
        break;
      }
      case 'turn/end': {
        const d = e.data as { turn?: number; reason?: { kind?: string } };
        out.push({ kind: 'dim', text: '—— turn ' + (d.turn ?? '?') + ' 结束' + (d.reason?.kind ? ' (' + d.reason.kind + ')' : '') + ' ——' });
        break;
      }
      case 'step/end': {
        const d = e.data as { step?: number };
        out.push({ kind: 'dim', text: '  ✓ step ' + (d.step ?? '?') });
        break;
      }
      case 'todo/write': {
        const d = e.data as { todos?: unknown[] };
        out.push({ kind: 'dim', text: '  📋 todo ×' + (Array.isArray(d.todos) ? d.todos.length : '?') });
        break;
      }
      case 'goal/change': {
        const d = e.data as { operation?: string };
        out.push({ kind: 'dim', text: '  🎯 goal ' + (d.operation ?? 'change') });
        break;
      }
      default:
        out.push({ kind: 'dim', text: '  · ' + e.type });
    }
  }
  return out;
}

/** 会话事件 → 展示行。已知噪声类型（流式分片等）返回空数组。 */
export function renderSessionEvent(e: SessionEvent): RenderLine[] {
  switch (e.type) {
    case "user/message": {
      const d = e.data as { content?: unknown };
      return [{ text: "你: " + truncate(textFromBlocks(d.content) || "(空)", 240) }];
    }
    case "assistant/message": {
      const d = e.data as { message?: { content?: unknown } };
      const txt = textFromBlocks(d.message?.content);
      return txt ? [{ text: "AI: " + truncate(txt, 400) }] : [];
    }
    case "tool/call": {
      const d = e.data as { name?: string; arguments?: string };
      return [{ text: "⚙ " + (d.name ?? "?") + "(" + truncate(String(d.arguments ?? ""), 90) + ")", tone: "accent" }];
    }
    case "tool/result": {
      const d = e.data as { message?: { content?: unknown } };
      const txt = truncate(textFromBlocks(d.message?.content) || "(无文本)", 220);
      return [{ text: "  ↳ " + txt, tone: "dim" }];
    }
    case "turn/start": {
      const d = e.data as { turn?: number };
      return [{ text: "—— turn " + (d.turn ?? "?") + " ——", tone: "dim" }];
    }
    case "turn/end": {
      const d = e.data as { turn?: number; reason?: { kind?: string } };
      const why = d.reason?.kind ? " (" + d.reason.kind + ")" : "";
      return [{ text: "—— turn " + (d.turn ?? "?") + " 结束" + why + " ——", tone: "dim" }];
    }
    case "step/end": {
      const d = e.data as { step?: number };
      return [{ text: "  ✓ step " + (d.step ?? "?"), tone: "dim" }];
    }
    case "todo/write": {
      const d = e.data as { todos?: unknown[] };
      return [{ text: "  📋 todo ×" + (Array.isArray(d.todos) ? d.todos.length : "?"), tone: "dim" }];
    }
    case "goal/change": {
      const d = e.data as { operation?: string };
      return [{ text: "  🎯 goal " + (d.operation ?? "change"), tone: "dim" }];
    }
    case "assistant/chunk":
    case "step/start":
      return [];
    default:
      return [{ text: "  · " + e.type, tone: "dim" }];
  }
}

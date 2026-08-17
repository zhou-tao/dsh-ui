import type { ContentBlock, SessionEvent } from "@dsh-ui/protocol";

/** 渲染结果：一行文本 + 可选色调（供 Ink 着色）。 */
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

/** 会话事件 → 展示行。已知噪声类型返回空数组（流式分片等）。 */
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
    // 噪声事件：流式分片、step 开始等，不渲染
    case "assistant/chunk":
    case "step/start":
      return [];
    default:
      return [{ text: "  · " + e.type, tone: "dim" }];
  }
}

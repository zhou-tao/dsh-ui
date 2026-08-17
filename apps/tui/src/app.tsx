import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  HarnessClient,
  harnessFrames,
  type HostDescribeValue,
  type MuxFrame,
  type SessionEvent,
  type SessionSummary,
} from "@dsh-ui/protocol";
import { renderSessionEvent, truncate, type RenderLine } from "./lib";
import { Input } from "./input";

interface AppProps {
  baseUrl: string;
}

type View = { kind: "list" } | { kind: "session"; sessionId: string };

const MAX_LINES_PER_SESSION = 500;
const MAX_DISPLAY_LINES = 120;

const toneColor = (tone?: string): string | undefined =>
  tone === "dim" ? "#8b949e" : tone === "ok" ? "#56d364" : tone === "err" ? "#ff7b72" : tone === "accent" ? "#79c0ff" : undefined;

export function App({ baseUrl }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [client] = useState(() => new HarnessClient({ baseUrl }));
  const [host, setHost] = useState<HostDescribeValue | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  /** 每个会话的渲染缓冲（历史尾部 + 实时追加），按 sessionId 索引 */
  const [lines, setLines] = useState<Record<string, RenderLine[]>>({});
  /** 每个会话已消费的最大 seq（实时帧按 seq 去重） */
  const [maxSeq, setMaxSeq] = useState<Record<string, number>>({});
  const [scroll, setScroll] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  // 流循环在 React 外运行，用 ref 读最新状态
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const maxSeqRef = useRef(maxSeq);
  maxSeqRef.current = maxSeq;
  const viewRef = useRef(view);
  viewRef.current = view;
  const clientRef = useRef(client);
  clientRef.current = client;

  const appendLines = (sessionId: string, add: RenderLine[]): void => {
    setLines((p) => {
      const cur = p[sessionId] ?? [];
      const next = [...cur, ...add];
      if (next.length > MAX_LINES_PER_SESSION) next.splice(0, next.length - MAX_LINES_PER_SESSION);
      return { ...p, [sessionId]: next };
    });
  };

  const handleFrame = (frame: MuxFrame): void => {
    const f = frame as Record<string, any>;
    const sid = f.sessionId as string | undefined;
    if (!sid) return;
    if (f.type === "session/event") {
      const e = f.event as SessionEvent;
      if (e && typeof e.seq === "number") {
        const m = maxSeqRef.current[sid] ?? -1;
        if (e.seq <= m) return; // 历史里已有
        setMaxSeq((p) => ({ ...p, [sid]: Math.max(p[sid] ?? -1, e.seq) }));
        const rendered = renderSessionEvent(e);
        if (rendered.length) appendLines(sid, rendered);
      } else {
        appendLines(sid, [{ text: "[event " + (e?.type ?? "?") + "]", tone: "dim" }]);
      }
    } else if (f.type === "session/subscribed") {
      setMaxSeq((p) => ({ ...p, [sid]: Math.max(p[sid] ?? -1, f.lastSeq as number) }));
    } else if (f.type === "session/queue") {
      const items = (f.items as unknown[]) ?? [];
      if (items.length) {
        const brief = items
          .map((it: any) => it?.message?.content?.[0]?.text ?? it?.id ?? "?")
          .slice(0, 3)
          .join(" | ");
        appendLines(sid, [{ text: "📬 队列: " + truncate(brief, 160), tone: "accent" }]);
      }
    } else if (f.type === "session/jobs") {
      const jobs = (f.jobs as unknown[]) ?? [];
      if (jobs.length) {
        const brief = jobs.map((j: any) => j.kind + ":" + String(j.status ?? "?")).join(", ");
        appendLines(sid, [{ text: "⚡ jobs: " + truncate(brief, 160), tone: "dim" }]);
      }
    }
  };

  // ---- 实时 mux 流：常驻，断线 2s 重连 ----
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<void> => {
      for (;;) {
        try {
          for await (const frame of harnessFrames({ baseUrl, kind: "mux" })) {
            if (cancelled) return;
            handleFrame(frame);
          }
        } catch (err) {
          if (cancelled) return;
          setStreamError(err instanceof Error ? err.message : String(err));
        }
        if (cancelled) return;
        await new Promise<void>((r) => {
          retry = setTimeout(r, 2000);
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [baseUrl]);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [h, s, w] = await Promise.all([
        client.call("host.describe", {}),
        client.call("session.list", {}),
        client.call("workspace.list", {}),
      ]);
      setHost(h as HostDescribeValue);
      const items = (s as { items: SessionSummary[] }).items ?? [];
      setSessions(items);
      setWorkspaces(((w as { items: { title?: string; workspaceId: string }[] }).items ?? []).map((x) => x.title ?? x.workspaceId));
      setSelected((prev) => Math.min(prev, Math.max(0, items.length - 1)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  /** 进入会话：拉取历史尾部（~300 条事件）渲染，并记录 maxSeq 供实时帧去重。 */
  const enterSession = async (sessionId: string): Promise<void> => {
    setView({ kind: "session", sessionId });
    setScroll(0);
    setPrompt("");
    setSending(false);
    try {
      const h = await clientRef.current.call("session.history", { sessionId });
      const evs = h.events;
      const rendered: RenderLine[] = [];
      let max = -1;
      for (const item of evs.slice(-300)) {
        const e = item.event;
        if (typeof e.seq === "number") max = Math.max(max, e.seq);
        rendered.push(...renderSessionEvent(e));
      }
      setMaxSeq((p) => ({ ...p, [sessionId]: Math.max(p[sessionId] ?? -1, max) }));
      setLines((p) => ({ ...p, [sessionId]: rendered }));
      setError(null);
    } catch (err) {
      appendLines(sessionId, [{ text: "加载历史失败: " + (err instanceof Error ? err.message : String(err)), tone: "err" }]);
    }
  };

  const sendPrompt = async (): Promise<void> => {
    const v = viewRef.current;
    if (v.kind !== "session" || !prompt.trim() || sending) return;
    const text = prompt;
    setPrompt("");
    setSending(true);
    try {
      appendLines(v.sessionId, [{ text: "你: " + truncate(text, 240) }]);
      await clientRef.current.call("session.prompt", { sessionId: v.sessionId, prompt: text });
    } catch (err) {
      appendLines(v.sessionId, [{ text: "发送失败: " + (err instanceof Error ? err.message : String(err)), tone: "err" }]);
    } finally {
      setSending(false);
    }
  };

  useInput((input, key) => {
    const v = viewRef.current;
    if (v.kind === "list") {
      if (key.ctrl && input === "c") exit();
      else if (key.upArrow) setSelected((p) => Math.max(0, p - 1));
      else if (key.downArrow) setSelected((p) => Math.min(sessionsRef.current.length - 1, p + 1));
      else if (key.return) {
        const s = sessionsRef.current[selected];
        if (s) void enterSession(s.sessionId);
      } else if (input === "r") void refresh();
      else if (input === "q") exit();
    } else {
      // 会话视图：Esc 返回、方向键滚动、Ctrl+C 退出（其余键交给输入框）
      if (key.ctrl && input === "c") exit();
      else if (key.escape) {
        setView({ kind: "list" });
        setScroll(0);
      } else if (key.upArrow) setScroll((s) => s + 1);
      else if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
      else if (key.pageUp) setScroll((s) => s + 20);
      else if (key.pageDown) setScroll((s) => Math.max(0, s - 20));
    }
  });

  // ---- 渲染 ----
  if (view.kind === "session") {
    const sessionLines = lines[view.sessionId] ?? [];
    const start = Math.max(0, sessionLines.length - MAX_DISPLAY_LINES - scroll);
    const end = Math.max(0, sessionLines.length - scroll);
    const shown = sessionLines.slice(start, end);
    const meta = sessionsRef.current.find((s) => s.sessionId === view.sessionId);
    return (
      <Box flexDirection="column" padding={1}>
        <Box justifyContent="space-between">
          <Text bold color="cyan">会话 {view.sessionId.slice(0, 8)}</Text>
          <Text dimColor>{meta ? (meta.running ? "● running" : "○ idle") : ""} · {meta?.cwd ?? ""}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {shown.map((ln, i) => (
            <Text key={start + i} color={toneColor(ln.tone)}>{ln.text}</Text>
          ))}
          {shown.length === 0 ? <Text dimColor>(暂无消息，等待中…)</Text> : null}
          {streamError ? <Text color="#ff7b72">[stream: {streamError}]</Text> : null}
        </Box>
        <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
          <Input
            value={prompt}
            onChange={setPrompt}
            onSubmit={() => void sendPrompt()}
            disabled={sending}
            placeholder={"输入消息，Enter 发送" + (sending ? "（发送中…）" : "")}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ 滚动 · PgUp/PgDn 翻页 · Esc 返回列表 · Ctrl+C 退出</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold color="cyan">DeepSeek Harness TUI</Text>
        <Text dimColor>  ·  {baseUrl}</Text>
      </Box>
      <Box marginTop={1}>
        {host ? (
          <Text dimColor>
            v{host.version} · {host.provider} / {host.model} · cwd: {host.cwd} · attached: {host.attachedSessions}
          </Text>
        ) : loading ? (
          <Text color="yellow">连接中…</Text>
        ) : null}
      </Box>
      {error ? <Text color="#ff7b72">ERROR: {error}</Text> : null}
      {streamError ? <Text color="#ff7b72">[stream: {streamError}]</Text> : null}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Workspaces</Text>
        {workspaces.length === 0 ? <Text dimColor>  (empty)</Text> : null}
        {workspaces.map((w) => (<Text key={w}>  • {w}</Text>))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Sessions  ({sessions.length})</Text>
        {sessions.length === 0 && !loading ? <Text dimColor>  (empty)</Text> : null}
        {sessions.map((s, i) => (
          <Text key={s.sessionId} color={i === selected ? "#79c0ff" : undefined}>
            {i === selected ? "> " : "  "}{s.running ? "●" : "○"} {s.sessionId.slice(0, 8)}  
            {s.running ? <Text color="#56d364">running</Text> : <Text dimColor>idle</Text>}
            {s.cwd ? <Text dimColor>  {s.cwd}</Text> : null}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ 选择会话 · Enter 进入 · r 刷新 · q 退出</Text>
      </Box>
    </Box>
  );
}

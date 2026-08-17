import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { HarnessClient, type HostDescribeValue, type SessionSummary } from "@dsh-ui/protocol";

interface AppProps {
  baseUrl: string;
}

export function App({ baseUrl }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [client] = useState(() => new HarnessClient({ baseUrl }));
  const [host, setHost] = useState<HostDescribeValue | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setSessions((s as { items: SessionSummary[] }).items ?? []);
      setWorkspaces(w.items.map((x) => x.title ?? x.workspaceId));
      setSelected((prev) => Math.min(prev, Math.max(0, (s as { items: SessionSummary[] }).items.length - 1)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    } else if (key.upArrow) {
      setSelected((p) => Math.max(0, p - 1));
    } else if (key.downArrow) {
      setSelected((p) => Math.min(sessions.length - 1, p + 1));
    } else if (key.return) {
      // 后续里程碑：进入所选 session 的会话视图（mux 事件流 / history 轮询）
    }
  });

  const sel = sessions[selected];

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

      {error ? <Text color="red">ERROR: {error}</Text> : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Workspaces</Text>
        {workspaces.length === 0 ? <Text dimColor>  (empty)</Text> : null}
        {workspaces.map((w) => (<Text key={w}>  • {w}</Text>))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Sessions  ({sessions.length})</Text>
        {sessions.length === 0 && !loading ? <Text dimColor>  (empty)</Text> : null}
        {sessions.map((s, i) => (
          <Text key={s.sessionId} color={i === selected ? "cyan" : undefined}>
            {i === selected ? "> " : "  "}{s.running ? "●" : "○"} {s.sessionId.slice(0, 8)}  
            {s.running ? <Text color="green">running</Text> : <Text dimColor>idle</Text>}
            {s.cwd ? <Text dimColor>  {s.cwd}</Text> : null}
          </Text>
        ))}
      </Box>

      {sel ? (
        <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>
            selected: {sel.sessionId} · preset={sel.agentPreset} · updated={new Date(sel.updatedAt).toISOString()}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>↑/↓ 选择会话 · r 刷新 · q 退出</Text>
      </Box>
    </Box>
  );
}

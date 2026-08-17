#!/usr/bin/env node
import { render } from "ink";
import { parseArgs } from "node:util";
import { App } from "./app";
import { HarnessClient, conversationItems } from "@dsh-ui/protocol";

const { values, positionals } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:3080" },
    once: { type: "boolean", default: false },
    session: { type: "string", default: "" },
  },
  allowPositionals: true,
});
const parsed = values as { url: string; once: boolean; session: string };
// 兼容 pnpm 脚本的 "--" 转发（--session <id> 会变成 positional）
const opts = {
  ...parsed,
  session: parsed.session || (positionals[0] === "--session" ? positionals[1] ?? "" : ""),
};

/** Non-TTY / CI 路径：拉取只读数据后以纯文本打印并退出（不依赖交互式终端）。 */
async function printOnce(baseUrl: string, sessionId?: string): Promise<void> {
  const client = new HarnessClient({ baseUrl });
  const host = await client.call("host.describe", {});
  const sessions = await client.call("session.list", {});
  const workspaces = await client.call("workspace.list", {});
  console.log("host:", JSON.stringify(host));
  const items = (sessions as { items: unknown[] }).items;
  console.log("sessions:", items.length);
  for (const s of items.slice(0, 5)) console.log("  -", JSON.stringify(s).slice(0, 140));
  console.log("workspaces:", JSON.stringify(workspaces).slice(0, 200));
  if (sessionId) {
    console.log("");
    console.log("=== session " + sessionId + " (历史尾部，已渲染) ===");
    const h = await client.call("session.history", { sessionId, maxMessages: 60 });
    for (const it of conversationItems(h.events.map((x) => x.event), { max: 80 })) console.log(it.text);
  }
}

// 非 TTY（CI / 管道 / 无终端环境）自动走一次性打印模式，避免 Ink raw mode 报错。
const headless = opts.once || !process.stdin.isTTY;

if (headless) {
  printOnce(opts.url, opts.session || undefined).catch((err) => {
    console.error("dsh-tui:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  render(<App baseUrl={opts.url} />);
}

#!/usr/bin/env node
import { render } from "ink";
import { parseArgs } from "node:util";
import { App } from "./app";
import { HarnessClient } from "@dsh-ui/protocol";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:3080" },
    once: { type: "boolean", default: false },
  },
});
const opts = values as { url: string; once: boolean };

/** Non-TTY / CI 路径：拉取只读数据后以纯文本打印并退出（不依赖交互式终端）。 */
async function printOnce(baseUrl: string): Promise<void> {
  const client = new HarnessClient({ baseUrl });
  const host = await client.call("host.describe", {});
  const sessions = await client.call("session.list", {});
  const workspaces = await client.call("workspace.list", {});
  console.log("host:", JSON.stringify(host));
  const items = (sessions as { items: unknown[] }).items;
  console.log("sessions:", items.length);
  for (const s of items.slice(0, 5)) console.log("  -", JSON.stringify(s).slice(0, 140));
  console.log("workspaces:", JSON.stringify(workspaces).slice(0, 200));
}

// 非 TTY（CI / 管道 / 无终端环境）自动走一次性打印模式，避免 Ink raw mode 报错。
const headless = opts.once || !process.stdin.isTTY;

if (headless) {
  printOnce(opts.url).catch((err) => {
    console.error("dsh-tui:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  render(<App baseUrl={opts.url} />);
}

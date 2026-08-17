import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";

const DEFAULT_PORT = 3080;
const URL_LINE = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/;

export interface HarnessHandle {
  /** Base URL of the running harness web profile, e.g. http://127.0.0.1:3080 */
  baseUrl: string;
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Spawn `dsh --profile web` and wait for its web server.
 *
 * The harness prints a URL line on boot; we prefer parsing it, and fall back
 * to the default port after a grace period. If the port is already taken the
 * harness itself fails fast (EADDRINUSE) — surfaced as a friendly error.
 */
export async function ensureHarness(): Promise<HarnessHandle> {
  if (current && !current.stopped) return current.handle;

  const cmd = process.platform === "win32" ? "dsh.cmd" : "dsh";
  const child: ChildProcess = spawn(cmd, ["--profile", "web"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let baseUrl: string | undefined;
  let stderr = "";
  let resolveReady: () => void = () => {};
  let rejectReady: (e: Error) => void = () => {};
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

  const onData = (text: string) => {
    if (baseUrl) return;
    const m = text.match(URL_LINE);
    if (m) {
      baseUrl = m[0];
      resolveReady();
    }
  };
  child.stdout?.on("data", (c: Buffer) => onData(c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
    onData(c.toString("utf8"));
  });

  // Fallback: assume the default port if the URL line never appears.
  const fallback = setTimeout(() => {
    if (!baseUrl) {
      baseUrl = "http://127.0.0.1:" + DEFAULT_PORT;
      resolveReady();
    }
  }, 2500);

  child.on("error", (err) => rejectReady(err));
  child.on("exit", (code) => {
    if (baseUrl) return;
    clearTimeout(fallback);
    const hint = stderr.includes("EADDRINUSE")
      ? "端口 " + DEFAULT_PORT + " 已被占用（另一个 harness 实例可能已在运行）"
      : "退出码 " + (code ?? "?") + "：" + (stderr.trim().slice(-400) || "无输出");
    rejectReady(new Error("dsh 启动失败。" + hint));
  });

  try {
    await ready;
  } catch (err) {
    child.kill();
    throw err;
  }
  clearTimeout(fallback);

  const handle: HarnessHandle = {
    baseUrl: baseUrl!,
    exited,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
      current = undefined;
    },
  };
  current = { handle, stopped: false };
  void exited.then(() => {
    if (current?.handle === handle) current = undefined;
  });
  return handle;
}

interface ManagedHandle {
  handle: HarnessHandle;
  stopped: boolean;
}

// ---- module-level singleton (one harness per extension host) ----
let current: ManagedHandle | undefined;

export async function stopHarness(): Promise<boolean> {
  if (!current) {
    void vscode.window.showInformationMessage("DeepSeek Harness 未在运行");
    return false;
  }
  const m = current;
  m.stopped = true;
  await m.handle.stop();
  void vscode.window.showInformationMessage("DeepSeek Harness 已停止");
  return true;
}

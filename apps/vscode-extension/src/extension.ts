import * as vscode from "vscode";
import { ensureHarness, stopHarness } from "./harness";
import { openHarnessPanel } from "./webview";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand("dsh-ui.open", async () => {
      try {
        const harness = await ensureHarness();
        await openHarnessPanel(context, harness);
      } catch (err) {
        void vscode.window.showErrorMessage("无法启动 DeepSeek Harness：" + (err instanceof Error ? err.message : String(err)));
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("dsh-ui.stop", () => stopHarness()),
  );
}

export async function deactivate(): Promise<void> {
  // 扩展停用时回收 harness 子进程
  await stopHarness();
}

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { HarnessClient, RpcCallError, RpcTransportError } from "@dsh-ui/protocol";
import type { HarnessHandle } from "./harness";

interface ApiRequest {
  type: "api";
  reqId: string;
  method: string;
  payload: unknown;
}

interface ApiResult {
  type: "api-result";
  reqId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Open the harness UI panel. The webview NEVER talks to the network directly:
 * every API call is relayed through the extension host (postMessage -> fetch ->
 * postMessage), so the webview CSP stays strict and the panel works regardless
 * of webview network policies.
 */
export async function openHarnessPanel(context: vscode.ExtensionContext, harness: HarnessHandle): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "dshUi.harness",
    "DeepSeek Harness",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = renderPanelHtml(panel.webview.cspSource, harness.baseUrl);
  const client = new HarnessClient({ baseUrl: harness.baseUrl });

  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    const m = msg as { type?: string };
    if (m?.type === "open-external") {
      void vscode.env.openExternal(vscode.Uri.parse(harness.baseUrl));
      return;
    }
    const req = msg as ApiRequest;
    if (req?.type !== "api") return;
    try {
      const value = await client.call(req.method, req.payload ?? {});
      const result: ApiResult = { type: "api-result", reqId: req.reqId, ok: true, value };
      await panel.webview.postMessage(result);
    } catch (err) {
      const result: ApiResult = {
        type: "api-result",
        reqId: req.reqId,
        ok: false,
        error: err instanceof RpcCallError || err instanceof RpcTransportError ? err.message : String(err),
      };
      await panel.webview.postMessage(result);
    }
  });

  // 面板关闭不杀 harness：它是可共享的本地服务，扩展停用时才回收
}

function renderPanelHtml(cspSource: string, baseUrl: string): string {
  const template = fs.readFileSync(path.join(__dirname, "..", "media", "panel.html"), "utf8");
  return template
    .replaceAll("{{NONCE}}", getNonce())
    .replaceAll("{{CSP_SOURCE}}", cspSource)
    .replaceAll("{{BASE_URL}}", baseUrl);
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

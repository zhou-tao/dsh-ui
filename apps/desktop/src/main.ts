import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import QRCode from "qrcode";
import "./styles.css";

interface HarnessStatus { running: boolean; url: string | null; }
interface HostInfo { version: string; provider: string; model: string; cwd: string; attachedSessions: number; }

const content = document.getElementById("content") as HTMLElement;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let hostInfo: HostInfo | null = null;
let lanIp = "";
let bridgeUp = false;

async function loadState(): Promise<void> {
  const s = await invoke<HarnessStatus>("harness_status").catch(() => null);
  hostInfo = s?.running
    ? { version: "?", provider: "harness", model: "", cwd: "", attachedSessions: 0 }
    : null;
  lanIp = (await invoke<string | null>("lan_ip").catch(() => null)) ?? "";
  bridgeUp = await invoke<boolean>("bridge_running").catch(() => false);
}

async function renderQrCard(): Promise<string> {
  if (!lanIp) {
    return '<div class="qr-note err">未获取到局域网 IP（请检查网络）</div>';
  }
  const url = "http://" + lanIp + ":4173";
  if (!bridgeUp) {
    return (
      '<div class="qr-note err">桥接服务未运行</div>' +
      '<div class="url-line">' + esc(url) + '</div>' +
      '<button id="startBridge" class="primary">启动桥接服务</button>'
    );
  }
  return (
    '<div class="qr-note ok">手机扫码连接（同一 Wi-Fi）</div>' +
    '<div class="url-line">' + esc(url) + '</div>' +
    '<canvas id="qr"></canvas>'
  );
}

async function paintQr(): Promise<void> {
  const canvas = document.getElementById("qr") as HTMLCanvasElement | null;
  if (!canvas || !lanIp) return;
  await QRCode.toCanvas(canvas, "http://" + lanIp + ":4173", {
    width: 200,
    margin: 1,
    color: { dark: "#e6edf3", light: "#101a2e" },
  });
}

async function renderLanding(): Promise<void> {
  await loadState();
  const h = hostInfo;
  content.innerHTML =
    '<section class="panel">' +
      '<h2>DeepSeek Harness 桌面端</h2>' +
      '<p class="muted small">' + (h ? esc(h.provider + " / " + h.model + " · 会话 " + h.attachedSessions) : "harness 状态未知") + '</p>' +
      '<h3>📱 手机互联</h3>' +
      (await renderQrCard()) +
      '<div class="row">' +
        '<button id="goHarness" class="primary">进入 harness 界面</button>' +
        '<button id="refresh">刷新</button>' +
      '</div>' +
    '</section>';
  await paintQr();
  document.getElementById("goHarness")?.addEventListener("click", () => {
    void invoke("start_harness").catch((e) => alert(String(e)));
  });
  document.getElementById("refresh")?.addEventListener("click", () => void renderLanding());
  document.getElementById("startBridge")?.addEventListener("click", async () => {
    const btn = document.getElementById("startBridge") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      await invoke("start_bridge");
      bridgeUp = true;
      void renderLanding();
    } catch (e) {
      alert("启动失败: " + String(e));
      if (btn) btn.disabled = false;
    }
  });
}

void renderLanding();

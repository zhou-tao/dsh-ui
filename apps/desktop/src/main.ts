import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import QRCode from "qrcode";
import "./styles.css";

interface HarnessStatus {
  running: boolean;
  url: string | null;
}

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const detailEl = document.getElementById("detail") as HTMLParagraphElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;

function setStatus(text: string, tone: "idle" | "ok" | "err" = "idle") {
  statusEl.textContent = text;
  statusEl.className = "status " + tone;
}

// start_harness 幂等：harness 已在运行 → 直接导航；未运行 → spawn dsh 并等待就绪后导航。
async function boot() {
  startBtn.hidden = true;
  startBtn.disabled = true;
  setStatus("正在连接 harness…");
  try {
    const s = await invoke<HarnessStatus>("start_harness");
    if (s.running && s.url) {
      setStatus("harness 就绪，正在打开界面…", "ok");
      detailEl.textContent = s.url;
    } else {
      setStatus("启动失败：未返回运行状态", "err");
      startBtn.hidden = false;
    }
  } catch (err) {
    setStatus("启动失败: " + String(err), "err");
    startBtn.hidden = false;
  } finally {
    startBtn.disabled = false;
  }
}

// ---------- 手机互联（扫码窗口，?qr=1） ----------
async function qrView() {
  document.title = "手机互联";
  const title = document.querySelector("h1");
  if (title) title.textContent = "手机互联";
  startBtn.hidden = true;
  setStatus("正在获取局域网信息…");
  let ip = "";
  try {
    ip = (await invoke<string | null>("lan_ip")) ?? "";
  } catch {
    ip = "";
  }
  const bridgeUp = await invoke<boolean>("bridge_running").catch(() => false);
  const url = "http://" + ip + ":4173";
  if (ip && bridgeUp) {
    setStatus("手机扫码连接", "ok");
    detailEl.textContent = url;
    const canvas = document.createElement("canvas");
    canvas.id = "qr";
    canvas.style.width = "220px";
    canvas.style.height = "220px";
    canvas.style.margin = "12px auto";
    document.querySelector(".card")?.append(canvas);
    try {
      await QRCode.toCanvas(canvas, url, { width: 220, margin: 1, color: { dark: "#e6edf3", light: "#101a2e" } });
    } catch {
      setStatus("二维码生成失败", "err");
    }
    const hint = document.createElement("p");
    hint.className = "detail";
    hint.textContent = "手机连同一 Wi-Fi，扫二维码打开 H5 互联页";
    document.querySelector(".card")?.append(hint);
  } else if (ip) {
    setStatus(bridgeUp ? "桥接已运行" : "桥接服务未运行", bridgeUp ? "ok" : "err");
    detailEl.textContent = url;
    const btn = document.createElement("button");
    btn.id = "start";
    btn.textContent = "启动桥接服务";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await invoke<boolean>("start_bridge");
        location.reload();
      } catch (err) {
        setStatus("启动失败: " + String(err), "err");
        btn.disabled = false;
      }
    });
    document.querySelector(".card")?.append(btn);
  } else {
    setStatus("未获取到局域网 IP（请检查网络）", "err");
  }
}

// 扫码窗口按窗口 label 识别（比 URL query 可靠：release 下 query 可能被丢弃）
if (getCurrentWindow().label === "mobile-qr") {
  void qrView();
} else {
  startBtn.addEventListener("click", () => void boot());
  void boot();
}

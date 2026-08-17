import { invoke } from "@tauri-apps/api/core";
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

async function refresh() {
  try {
    const s = await invoke<HarnessStatus>("harness_status");
    if (s.running && s.url) {
      setStatus("harness 已在运行，正在打开界面…", "ok");
      detailEl.textContent = s.url;
      // Rust 侧已把主窗口导航到 harness UI；此页面随即被替换
      startBtn.hidden = true;
      return;
    }
    setStatus("harness 未运行");
    startBtn.hidden = false;
  } catch (err) {
    setStatus("无法连接 Tauri 后端: " + String(err), "err");
    startBtn.hidden = false;
  }
}

async function start() {
  startBtn.disabled = true;
  setStatus("正在启动 harness…");
  try {
    const s = await invoke<HarnessStatus>("start_harness");
    if (s.running && s.url) {
      setStatus("harness 已启动，正在打开界面…", "ok");
      detailEl.textContent = s.url;
    } else {
      setStatus("启动失败：未返回运行状态", "err");
    }
  } catch (err) {
    setStatus("启动失败: " + String(err), "err");
    startBtn.disabled = false;
  }
}

startBtn.addEventListener("click", start);
void refresh();

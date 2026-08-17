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
      // Rust 侧已把主窗口导航到 harness UI；此页面随即被替换
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

startBtn.addEventListener("click", () => void boot());
void boot();

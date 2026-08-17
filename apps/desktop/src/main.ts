import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import QRCode from 'qrcode';
import './styles.css';

interface HarnessStatus { running: boolean; url: string | null; }
interface TunnelInfo { url: string | null; token: string | null; running: boolean; }

const content = document.getElementById('content') as HTMLElement;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let lanIp = '';
let bridgeUp = false;

async function loadState(): Promise<void> {
  lanIp = (await invoke<string | null>('lan_ip').catch(() => null)) ?? '';
  bridgeUp = await invoke<boolean>('bridge_running').catch(() => false);
}

async function drawQr(url: string): Promise<void> {
  const canvas = document.getElementById('qr') as HTMLCanvasElement | null;
  if (!canvas) return;
  await QRCode.toCanvas(canvas, url, { width: 180, margin: 1, color: { dark: '#e6edf3', light: '#101a2e' } });
}

// ---------- 主窗口：启动即自动进入 harness 首页（失败则显示重试） ----------
async function renderLanding(): Promise<void> {
  content.innerHTML =
    '<section class="panel">' +
      '<h2>DeepSeek Harness UI</h2>' +
      '<p class="muted small">正在进入 harness 界面…</p>' +
    '</section>';
  try {
    await invoke('start_harness');
  } catch (e) {
    content.innerHTML =
      '<section class="panel">' +
        '<h2>DeepSeek Harness UI</h2>' +
        '<p class="muted small err">启动失败: ' + esc(String(e)) + '</p>' +
        '<div class="row"><button id="retry" class="primary">重试</button></div>' +
      '</section>';
    document.getElementById('retry')?.addEventListener('click', () => void renderLanding());
  }
}

// ---------- 扫码窗口：局域网二维码 + 公网访问 ----------
async function renderQrWindow(): Promise<void> {
  await loadState();
  const lanUrl = lanIp ? 'http://' + lanIp + ':4173' : '';
  let tunnelHtml = '<button id="tunnelBtn" class="primary">开启公网访问（无需同 Wi-Fi）</button>';
  try {
    const t = (await invoke<string>('tunnel_status')) as string;
    const info = JSON.parse(t) as TunnelInfo;
    if (info.url && info.running) {
      const pub = info.url + '?token=' + esc(info.token ?? '');
      tunnelHtml =
        '<div class="qr-note ok">公网已开启 · 扫码即可在任何网络访问</div>' +
        '<div class="url-line">' + pub + '</div>' +
        '<canvas id="tqr"></canvas>';
    }
  } catch { /* 桥接未运行 */ }
  content.innerHTML =
    '<section class="panel">' +
      '<h2>📱 手机互联</h2>' +
      '<h3>同一 Wi-Fi</h3>' +
      (bridgeUp && lanUrl
        ? '<div class="qr-note ok">扫码连接（需同一 Wi-Fi）</div><div class="url-line">' + lanUrl + '</div><canvas id="qr"></canvas>'
        : '<div class="qr-note err">桥接服务未运行</div><button id="startBridge" class="primary">启动桥接服务</button>') +
      '<h3>🌐 任意网络</h3>' +
      tunnelHtml +
      '<div class="row"><button id="refresh">刷新</button></div>' +
    '</section>';
  if (lanUrl) await drawQr(lanUrl);
  const tqr = document.getElementById('tqr') as HTMLCanvasElement | null;
  if (tqr) {
    try {
      const t = (await invoke<string>('tunnel_status')) as string;
      const info = JSON.parse(t) as TunnelInfo;
      if (info.url) await QRCode.toCanvas(tqr, info.url + '?token=' + (info.token ?? ''), { width: 180, margin: 1, color: { dark: '#e6edf3', light: '#101a2e' } });
    } catch { /* ignore */ }
  }
  document.getElementById('startBridge')?.addEventListener('click', async () => {
    const btn = document.getElementById('startBridge') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try { await invoke('start_bridge'); void renderQrWindow(); }
    catch (e) { alert('启动失败: ' + String(e)); if (btn) btn.disabled = false; }
  });
  document.getElementById('tunnelBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('tunnelBtn') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = '正在开启（约 20s）…'; }
    try {
      await invoke('start_tunnel');
      void renderQrWindow();
    } catch (e) { alert('开启失败: ' + String(e)); if (btn) btn.disabled = false; }
  });
  document.getElementById('refresh')?.addEventListener('click', () => void renderQrWindow());
}

if (getCurrentWindow().label === 'mobile-qr') {
  void renderQrWindow();
} else {
  void renderLanding();
}

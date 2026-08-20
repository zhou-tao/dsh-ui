// DeepSeek Harness 手机互联桥接服务
// - 监听 0.0.0.0（局域网可达），同源托管 H5，服务端代理 /api/* 到 harness（session.history 响应自动过滤流式分片等噪声，大幅缩小手机端传输量）
// - 可选：cloudflared 快速隧道（公网访问，无需同 Wi-Fi）+ 访问令牌（Cookie 机制，H5 零改动）
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { qrSvg } from './qr-svg.js';

const HARNESS = process.env.HARNESS_URL ?? 'http://127.0.0.1:3080';
const PORT = Number(process.env.PORT ?? 4173);
// H5 静态产物定位，兼容两种布局（issue #6）：
// - dev/独立运行：dist-server/../dist（apps/mobile-h5/dist）
// - 桌面 bundle：Contents/Resources/resources/dist（与 mobile-bridge.js 同目录）
// 优先同目录，其次父级，都找不到时报错而不是静默 404。
const DIST = [join(import.meta.dirname, 'dist'), join(import.meta.dirname, '..', 'dist')]
  .find((p) => existsSync(p))
  ?? (() => { throw new Error('未找到 H5 dist：' + import.meta.dirname); })();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

// ---- 隧道与令牌状态 ----
let tunnelUrl: string | null = null;
let tunnelToken: string | null = null;
let tunnelProc: ReturnType<typeof spawn> | null = null;

// ---- 手机连接感知：记录最近一次来自"手机"的请求 ----
// 局域网直连：remoteAddress 非 loopback；公网隧道：cloudflared 本地转发，但带 Cf-Connecting-Ip 头。
let lastClientAt: number | null = null;

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function noteClient(req: IncomingMessage): void {
  const remote = req.socket.remoteAddress ?? '';
  // 隧道（cloudflared）本地转发时 remoteAddress 是 loopback，但会带 Cf-Connecting-IP / X-Forwarded-* 头
  const proxied =
    typeof req.headers['cf-connecting-ip'] === 'string' ||
    typeof req.headers['x-forwarded-for'] === 'string' ||
    typeof req.headers['x-forwarded-proto'] === 'string';
  if (proxied || !isLoopback(remote)) {
    lastClientAt = Date.now();
  }
}

function connectedNow(): boolean {
  return lastClientAt !== null && Date.now() - lastClientAt < 180_000; // 3 分钟内有手机访问
}

/** 局域网 IP（供桌面端弹窗直接用 HTTP 获取，无需再走 Tauri IPC）。 */
function lanIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

// ---- 历史响应瘦身：session.history / subagent.history 全量事件中 ~99% 是流式分片等展示噪声，
// 手机端经公网隧道下载极慢。桥接层直接过滤后再转发（对手机侧透明，仅保留展示所需事件）。----
const HISTORY_NOISE_TYPES = new Set([
  'assistant/chunk',
  'step/start',
  'request/header',
  'request/context',
  'session/title',
  'session/title-llm-request',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent/inbox/spliced',
  'tool/code-dispatch',
  'tool/code-dispatch-start',
]);

const TRIM_TOOL_ARG = 240; // tool/call arguments 截断（展示只用名称+截断参数）
const TRIM_TOOL_RESULT = 400; // tool/result 文本截断（展示只显示前 220 字符）

type SlimEvent = { type?: string; data?: Record<string, any> };

/** 只保留顶层 text 块（丢弃 reasoning / tool-call / image——移动端展示只用文本）。 */
function textBlocksOnly(blocks: unknown[]): unknown[] {
  return blocks.filter((b) => b !== null && typeof b === 'object' && (b as { type?: string }).type === 'text');
}

/** 递归收集全部 text 块文本（tool/result 的 tool-result 块嵌套 content）。 */
function collectText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { for (const x of node) collectText(x, out); }
  else if (node !== null && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.type === 'text' && typeof o.text === 'string') out.push(o.text);
    collectText(o.content, out);
  }
  return out;
}

/** 就地瘦身单个事件：只保留手机端展示所需字段。 */
function slimEvent(ev: SlimEvent): void {
  // sourceEventSeqs：分块溯源 seq 列表（GUI 分组用），手机端展示不需要（占历史响应 ~40%）
  delete ev.sourceEventSeqs;
  const d = ev.data;
  if (!d) return;
  if (ev.type === 'user/message' || ev.type === 'assistant/message') {
    const blocks: unknown[] = d.message?.content ?? d.content;
    if (Array.isArray(blocks)) {
      const text = textBlocksOnly(blocks);
      if (Array.isArray(d.message?.content)) d.message.content = text;
      else if (Array.isArray(d.content)) d.content = text;
    }
  } else if (ev.type === 'tool/call') {
    if (typeof d.arguments === 'string' && d.arguments.length > TRIM_TOOL_ARG) {
      d.arguments = d.arguments.slice(0, TRIM_TOOL_ARG) + '…';
    }
  } else if (ev.type === 'tool/result') {
    const blocks: unknown[] = d.message?.content;
    if (Array.isArray(blocks)) {
      const txt = collectText(blocks).join('\n').trim();
      d.message.content = [{ type: 'text', text: txt.length > TRIM_TOOL_RESULT ? txt.slice(0, TRIM_TOOL_RESULT) + '…' : txt }];
    }
  }
}

function slimHistoryResponse(text: string): string | null {
  try {
    const env = JSON.parse(text) as {
      type?: string;
      result?: { ok?: boolean; value?: { events?: { event?: SlimEvent }[] } };
    };
    if (env?.type === 'server-response' && env.result?.ok === true && Array.isArray(env.result.value?.events)) {
      const kept: { event?: SlimEvent }[] = [];
      for (const it of env.result.value.events) {
        const t = it?.event?.type ?? '';
        if (HISTORY_NOISE_TYPES.has(t)) continue; // 噪声事件直接丢弃
        delete (it as { view?: unknown }).view; // 事件展示卡片（presenter view），手机端用不到
        slimEvent(it.event as SlimEvent); // 就地瘦身
        kept.push(it);
      }
      env.result.value.events = kept;
      return JSON.stringify(env);
    }
  } catch {
    /* 非 JSON 或解析失败：原样转发 */
  }
  return null;
}

function tokenOk(req: IncomingMessage): boolean {
  if (!tunnelToken) return true; // 未开启公网访问：不强制令牌
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams.get('token');
  if (q === tunnelToken) return true;
  const cookies = (req.headers.cookie ?? '').split(';').map((c) => c.trim());
  return cookies.some((c) => c === 'dsh_token=' + tunnelToken);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 启动 cloudflared 快速隧道并解析公网 URL
async function startTunnel(): Promise<void> {
  if (tunnelProc) return;
  tunnelToken = randomBytes(16).toString('hex');
  let proc;
  try {
    // 注意：不要加 --protocol http2（实测导致 Cloudflare 530，默认 http1 正常）
    proc = spawn('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:' + PORT, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    tunnelToken = null;
    throw new Error('cloudflared 未安装或不在 PATH 中（请先安装：brew install cloudflared）');
  }
  tunnelProc = proc;
  tunnelProc.stdout?.on('data', (c: Buffer) => {
    const m = String(c).match(/https?:\/\/[a-z0-9.-]+\.trycloudflare\.com/);
    if (m && !tunnelUrl) tunnelUrl = m[0];
  });
  tunnelProc.stderr?.on('data', (c: Buffer) => {
    const m = String(c).match(/https?:\/\/[a-z0-9.-]+\.trycloudflare\.com/);
    if (m && !tunnelUrl) tunnelUrl = m[0];
  });
  tunnelProc.on('exit', () => { tunnelProc = null; tunnelUrl = null; });
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  noteClient(req);
  if (!tokenOk(req)) {
    json(res, 403, { error: 'forbidden: missing or invalid token' });
    return;
  }
  try {
    const body = await readBody(req);
    const q = req.url?.split('?')[1] ?? '';
    const upstream = await fetch(HARNESS + pathname + (q ? '?' + q : ''), {
      method: req.method ?? 'GET',
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? body : undefined,
    });
    const text = await upstream.text();
    const slim = slimHistoryResponse(text);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(slim ?? text);
  } catch (err) {
    json(res, 502, { error: 'harness 代理失败: ' + (err instanceof Error ? err.message : String(err)) });
  }
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
  noteClient(req);
  // 公网访问：URL 带 token 时种 Cookie，之后所有 /api 请求自动携带
  if (tunnelToken && url.searchParams.get('token') === tunnelToken) {
    res.setHeader('Set-Cookie', 'dsh_token=' + tunnelToken + '; Path=/; Max-Age=86400; SameSite=Lax');
  }
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = rel.split('..').join('');
  try {
    const data = await readFile(join(DIST, safe));
    res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  if (p === '/tunnel/start' && req.method === 'POST') {
    try {
      await startTunnel();
    } catch (err) {
      json(res, 500, { error: '启动公网隧道失败: ' + (err instanceof Error ? err.message : String(err)) });
      return;
    }
    const start = Date.now();
    while (!tunnelUrl && Date.now() - start < 20000) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!tunnelUrl) { json(res, 500, { error: 'cloudflared 未能在 20s 内建立隧道' }); return; }
    json(res, 200, { url: tunnelUrl, token: tunnelToken });
    return;
  }
  if (p === '/tunnel') {
    json(res, 200, { url: tunnelUrl, token: tunnelToken, running: !!tunnelProc });
    return;
  }
  if (p === '/status') {
    // 桌面端悬浮图标/弹窗轮询：CORS 放行（GET 简单请求，无预检）
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(
      JSON.stringify({
        running: true,
        connected: connectedNow(),
        lastSeenAt: lastClientAt,
        lanIp: lanIp(),
        tunnel: { url: tunnelUrl, running: !!tunnelProc },
      })
    );
    return;
  }
  if (p === '/qr') {
    // 二维码图（SVG）：供桌面端弹窗 <img> 使用（手机扫码内容由调用方传入）
    const text = url.searchParams.get('text') ?? '';
    const size = Math.min(512, Math.max(96, Number(url.searchParams.get('size')) || 240));
    if (!text) { json(res, 400, { error: 'missing text' }); return; }
    try {
      const svg = qrSvg(text, { size });
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
      res.end(svg);
    } catch (err) {
      json(res, 400, { error: 'qr failed: ' + (err instanceof Error ? err.message : String(err)) });
    }
    return;
  }
  if (p.startsWith('/api/')) {
    await handleApi(req, res, p);
    return;
  }
  await handleStatic(req, res, p, url);
});

process.on('exit', () => tunnelProc?.kill());
process.on('SIGINT', () => { tunnelProc?.kill(); process.exit(0); });
process.on('SIGTERM', () => { tunnelProc?.kill(); process.exit(0); });

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('dsh-ui 手机互联桥接服务已启动');
  console.log('  本机:   http://127.0.0.1:' + PORT);
  console.log('  局域网: http://<本机局域网IP>:' + PORT + '  （同一 Wi-Fi）');
  console.log('  代理到: ' + HARNESS);
  console.log('');
});

// DeepSeek Harness 手机互联桥接服务
// - 监听 0.0.0.0（局域网可达），同源托管 H5，服务端代理 /api/* 到 harness
// - 可选：cloudflared 快速隧道（公网访问，无需同 Wi-Fi）+ 访问令牌（Cookie 机制，H5 零改动）
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const HARNESS = process.env.HARNESS_URL ?? 'http://127.0.0.1:3080';
const PORT = Number(process.env.PORT ?? 4173);
const DIST = join(import.meta.dirname, '..', 'dist');

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
  // 注意：不要加 --protocol http2（实测导致 Cloudflare 530，默认 http1 正常）
  tunnelProc = spawn('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:' + PORT, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  } catch (err) {
    json(res, 502, { error: 'harness 代理失败: ' + (err instanceof Error ? err.message : String(err)) });
  }
}

async function handleStatic(res: ServerResponse, pathname: string, url: URL): Promise<void> {
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
    await startTunnel();
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
  if (p.startsWith('/api/')) {
    await handleApi(req, res, p);
    return;
  }
  await handleStatic(res, p, url);
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

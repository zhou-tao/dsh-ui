// DeepSeek Harness 手机互联桥接服务
// 背景：harness 绑定 127.0.0.1 且拒绝局域网 Origin，手机无法直连。
// 本服务：监听 0.0.0.0（局域网可达），同源托管 H5 静态文件，并把 /api/* 服务端代理到 harness（无 Origin 头，绕开围栏）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  try {
    const body = await readBody(req);
    const upstream = await fetch(HARNESS + pathname + (req.url?.split('?')[1] ? '?' + req.url.split('?')[1] : ''), {
      method: req.method ?? 'GET',
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? body : undefined,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(text);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('harness 代理失败: ' + (err instanceof Error ? err.message : String(err)));
  }
}

async function handleStatic(res: ServerResponse, pathname: string): Promise<void> {
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
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }
  await handleStatic(res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('dsh-ui 手机互联已启动');
  console.log('  本机:   http://127.0.0.1:' + PORT);
  console.log('  手机:   http://<本机局域网IP>:' + PORT + '  （同一 Wi-Fi）');
  console.log('  代理到: ' + HARNESS);
  console.log('');
});

// server/index.mts
import { createServer } from "http";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { readFile } from "fs/promises";
import { join, extname } from "path";
var HARNESS = process.env.HARNESS_URL ?? "http://127.0.0.1:3080";
var PORT = Number(process.env.PORT ?? 4173);
var DIST = join(import.meta.dirname, "..", "dist");
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2"
};
var tunnelUrl = null;
var tunnelToken = null;
var tunnelProc = null;
function tokenOk(req) {
  if (!tunnelToken) return true;
  const url = new URL(req.url ?? "/", "http://x");
  const q = url.searchParams.get("token");
  if (q === tunnelToken) return true;
  const cookies = (req.headers.cookie ?? "").split(";").map((c) => c.trim());
  return cookies.some((c) => c === "dsh_token=" + tunnelToken);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
async function startTunnel() {
  if (tunnelProc) return;
  tunnelToken = randomBytes(16).toString("hex");
  tunnelProc = spawn("cloudflared", ["tunnel", "--url", "http://127.0.0.1:" + PORT, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  tunnelProc.stdout?.on("data", (c) => {
    const m = String(c).match(/https?:\/\/[a-z0-9.-]+\.trycloudflare\.com/);
    if (m && !tunnelUrl) tunnelUrl = m[0];
  });
  tunnelProc.stderr?.on("data", (c) => {
    const m = String(c).match(/https?:\/\/[a-z0-9.-]+\.trycloudflare\.com/);
    if (m && !tunnelUrl) tunnelUrl = m[0];
  });
  tunnelProc.on("exit", () => {
    tunnelProc = null;
    tunnelUrl = null;
  });
}
async function handleApi(req, res, pathname) {
  if (!tokenOk(req)) {
    json(res, 403, { error: "forbidden: missing or invalid token" });
    return;
  }
  try {
    const body = await readBody(req);
    const q = req.url?.split("?")[1] ?? "";
    const upstream = await fetch(HARNESS + pathname + (q ? "?" + q : ""), {
      method: req.method ?? "GET",
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? body : void 0
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(text);
  } catch (err) {
    json(res, 502, { error: "harness \u4EE3\u7406\u5931\u8D25: " + (err instanceof Error ? err.message : String(err)) });
  }
}
async function handleStatic(res, pathname, url) {
  if (tunnelToken && url.searchParams.get("token") === tunnelToken) {
    res.setHeader("Set-Cookie", "dsh_token=" + tunnelToken + "; Path=/; Max-Age=86400; SameSite=Lax");
  }
  const rel = pathname === "/" ? "/index.html" : pathname;
  const safe = rel.split("..").join("");
  try {
    const data = await readFile(join(DIST, safe));
    res.writeHead(200, { "content-type": MIME[extname(safe)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}
var server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (p === "/tunnel/start" && req.method === "POST") {
    await startTunnel();
    const start = Date.now();
    while (!tunnelUrl && Date.now() - start < 2e4) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!tunnelUrl) {
      json(res, 500, { error: "cloudflared \u672A\u80FD\u5728 20s \u5185\u5EFA\u7ACB\u96A7\u9053" });
      return;
    }
    json(res, 200, { url: tunnelUrl, token: tunnelToken });
    return;
  }
  if (p === "/tunnel") {
    json(res, 200, { url: tunnelUrl, token: tunnelToken, running: !!tunnelProc });
    return;
  }
  if (p.startsWith("/api/")) {
    await handleApi(req, res, p);
    return;
  }
  await handleStatic(res, p, url);
});
process.on("exit", () => tunnelProc?.kill());
process.on("SIGINT", () => {
  tunnelProc?.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  tunnelProc?.kill();
  process.exit(0);
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("dsh-ui \u624B\u673A\u4E92\u8054\u6865\u63A5\u670D\u52A1\u5DF2\u542F\u52A8");
  console.log("  \u672C\u673A:   http://127.0.0.1:" + PORT);
  console.log("  \u5C40\u57DF\u7F51: http://<\u672C\u673A\u5C40\u57DF\u7F51IP>:" + PORT + "  \uFF08\u540C\u4E00 Wi-Fi\uFF09");
  console.log("  \u4EE3\u7406\u5230: " + HARNESS);
  console.log("");
});

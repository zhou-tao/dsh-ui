// server/index.mts
import { createServer } from "http";
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
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function handleApi(req, res, pathname) {
  try {
    const body = await readBody(req);
    const upstream = await fetch(HARNESS + pathname + (req.url?.split("?")[1] ? "?" + req.url.split("?")[1] : ""), {
      method: req.method ?? "GET",
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? body : void 0
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json"
    });
    res.end(text);
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("harness \u4EE3\u7406\u5931\u8D25: " + (err instanceof Error ? err.message : String(err)));
  }
}
async function handleStatic(res, pathname) {
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
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, pathname);
    return;
  }
  await handleStatic(res, pathname);
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("dsh-ui \u624B\u673A\u4E92\u8054\u5DF2\u542F\u52A8");
  console.log("  \u672C\u673A:   http://127.0.0.1:" + PORT);
  console.log("  \u624B\u673A:   http://<\u672C\u673A\u5C40\u57DF\u7F51IP>:" + PORT + "  \uFF08\u540C\u4E00 Wi-Fi\uFF09");
  console.log("  \u4EE3\u7406\u5230: " + HARNESS);
  console.log("");
});

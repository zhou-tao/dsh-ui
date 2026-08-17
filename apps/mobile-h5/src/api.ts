import { HarnessClient } from "@dsh-ui/protocol";

/** 同源 API 客户端：页面的 origin 就是桥接服务（dev: vite 代理 / prod: bridge server），无 CORS 问题。
 *  timeoutMs 放宽到 5 分钟：session.history 按 maxMessages 分页后单页仍可能数 MB，
 *  经公网隧道（cloudflared）下载较慢，默认 60s 会在中途 abort（浏览器报 "The user aborted a request."）。 */
export const client = new HarnessClient({ baseUrl: window.location.origin, timeoutMs: 300_000 });

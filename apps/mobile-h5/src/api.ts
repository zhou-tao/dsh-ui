import { HarnessClient } from "@dsh-ui/protocol";

/** 同源 API 客户端：页面的 origin 就是桥接服务（dev: vite 代理 / prod: bridge server），无 CORS 问题。 */
export const client = new HarnessClient({ baseUrl: window.location.origin });

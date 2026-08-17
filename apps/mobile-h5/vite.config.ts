import { defineConfig } from "vite";

// 开发模式：vite 起在局域网可达端口，/api 代理到 harness
// （harness 有 Origin 围栏：必须剥掉浏览器 Origin，服务端代理转发）
export default defineConfig({
  server: {
    host: true,
    port: 1422,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3080",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
          });
        },
      },
    },
  },
});

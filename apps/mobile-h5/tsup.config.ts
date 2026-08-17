import { defineConfig } from 'tsup';

// 桥接服务打包：qrcode（core 子路径）与 dijkstrajs 必须打进产物，
// 打包进桌面端后的 mobile-bridge.js 独立运行（无 node_modules）。
export default defineConfig({
  entry: ['server/index.mts'],
  format: ['esm'],
  outDir: 'dist-server',
  clean: true,
  target: 'node22',
  noExternal: ['qrcode', 'dijkstrajs'],
});

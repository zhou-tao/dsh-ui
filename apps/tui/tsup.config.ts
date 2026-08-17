import { defineConfig } from "tsup";

// 发布策略：协议包 @dsh-ui/protocol（未发布到 npm）内联进 bundle；
// ink/react 走 registry 依赖（npm i -g <tgz> 时自动安装）。
// shebang 已在 src/index.tsx 首行，无需 banner（避免重复）。
export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  noExternal: ["@dsh-ui/protocol"],
  target: "node22",
});

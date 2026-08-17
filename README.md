# dsh-ui — DeepSeek Harness UI 全家桶

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的一套 UI 客户端 monorepo：**桌面客户端**（Tauri 2）+ **终端 TUI**（Ink）+ **手机互联 H5** + **VS Code 扩展**，全部复用同一套实测过的 harness 协议。

> 桌面应用名：**DeepSeek Harness UI**（macOS / Windows） · TUI 包名：**@dsh-ui/tui**（npm）

---

## ✨ 功能特性

| 客户端 | 能力 |
| --- | --- |
| 🖥 **桌面端**（DeepSeek Harness UI） | 自动拉起 harness、原生窗口内嵌完整 Web UI；**手机互联入口**：侧边栏手机图标 + UI 弹窗（同一 Wi-Fi 局域网扫码），二维码自动加载、手机连接状态绿点 |
| 📱 **手机互联 H5** | 手机浏览器访问：会话列表**按工作区分组**、标题与桌面端一致（标题→目录名→sessionId 兜底）；会话**完整消息 + markdown 渲染**（代码块/表格/列表）；历史加载**桥接层自动瘦身**（~10MB → ~100KB）；发送消息适配最新 harness 载荷 |
| ⌨️ **终端 TUI**（@dsh-ui/tui） | Ink 交互式会话列表/会话视图/实时 mux 流/消息输入；`--once` 无 TTY 模式可跑 CI/管道；npm 可安装 |
| 🧩 **VS Code 扩展** | WebviewPanel 内代理桥（CSP 严格、无直连网络） |
| 📦 **协议包**（@dsh-ui/protocol） | 零依赖 wire 协议（信封/方法类型/事件帧），四端共享，已对活 harness 冒烟验证 |

### 手机互联工作方式（同 IP / 局域网）
- 桌面端启动即后台拉起连接服务；点手机图标打开弹窗 → **自动生成二维码**（无需任何操作）；
- 手机与电脑连**同一 Wi-Fi**，扫码 → 浏览会话 / 发消息；
- 状态圆点：手机 3 分钟内访问过桥接即显示**绿色**；
- 公网（跨 IP）互联**建设中**（原 cloudflared 隧道方案国内网络不可靠，已标记占位）。

---

## 📦 安装与使用

### 前置依赖
- Node ≥ 22、pnpm 9
- Rust 工具链（桌面端编译需要）
- harness 运行中（`dsh --profile web`，默认 127.0.0.1:3080）——各客户端自动复用已运行的 harness

### 1) 桌面端（DeepSeek Harness UI）
```bash
pnpm install
pnpm --filter @dsh-ui/desktop tauri:dev    # 开发模式
pnpm --filter @dsh-ui/desktop tauri:build  # 打包（.dmg / .msi / .exe）
```
- macOS：`DeepSeek Harness UI.app`（Apple Silicon 与 Intel 均有对应构建）；Windows：`.msi` / `.exe`
- 发布版从 **GitHub Release** 获取；未签名构建首次打开请右键 → 打开

### 2) 手机互联 H5
```bash
pnpm --filter @dsh-ui/mobile-h5 build   # 构建前端
pnpm --filter @dsh-ui/mobile-h5 start   # 启动桥接服务（默认 4173 端口，监听 0.0.0.0）
```
- 手机浏览器打开 `http://<Mac局域网IP>:4173`（IP 在桌面端弹窗二维码下方可见）
- 深链直达：`http://<IP>:4173/?session=<sessionId>`

### 3) 终端 TUI（npm 安装）
```bash
npm i -g @dsh-ui/tui     # 或 pnpm i -g @dsh-ui/tui
dsh-tui                  # 交互模式（需真实终端）
dsh-tui --once           # 无 TTY 一次性打印
dsh-tui --once -- --session <sessionId>   # 导出某会话历史渲染
```
仓库内开发：`pnpm --filter @dsh-ui/tui dev`

### 4) VS Code 扩展
```bash
pnpm --filter dsh-ui-extension compile
# F5 运行 Extension Development Host 验证
```

### 5) 一键构建 / 测试
```bash
pnpm build       # 全 workspace 构建
pnpm typecheck   # 全量类型检查
pnpm test        # 协议层单元冒烟（无需 harness）
```

---

## 🗂 项目结构

```
dsh-ui/
├── packages/protocol/       # @dsh-ui/protocol — 零依赖 wire 协议（传输层 + 方法类型 + 事件帧）
├── apps/
│   ├── desktop/             # @dsh-ui/desktop — Tauri 2 桌面端（Rust 管 harness 进程 + 手机互联注入）
│   ├── tui/                 # @dsh-ui/tui — Ink v7 终端客户端（npm 包）
│   ├── mobile-h5/           # 手机互联 H5 + 桥接服务（同源代理 /api，响应瘦身，/qr /status）
│   └── vscode-extension/    # VS Code Webview 面板客户端
├── plugins/                 # dsh 插件（抽象出的通用能力，装进 harness 即生效）
│   ├── dsh-deep-ui/         # UI 层增强：会话思考过程折叠（已工作 X 分 X 秒 + 折叠图标）
│   └── dsh-remote/          # 手机互联（H5 远程互联）：手机图标 + 扫码弹窗 + 状态绿点
└── .github/workflows/       # CI（编译/测试）+ Release（GitHub Release + npm）
```

### 技术要点
- **协议**（已实测）：unary RPC 走 `POST /api/{method}`，下行事件 WebSocket（`/api/events.mux`）；浏览器 / Node 双载体
- **手机互联桥接**：harness 绑定 127.0.0.1 且拒绝局域网 Origin → H5 由桥接同源托管，服务端代理 `/api/*`；历史响应自动过滤流式分片/元数据（10MB → ~100KB）
- **跨 IP 方案规划**：原 cloudflared 快速隧道在国内网络不可靠，已标记"建设中"；后续优先考虑 **SSH 反向隧道**（VPS + 自有域名 + Caddy 自动 HTTPS）

---

## 🔌 dsh 插件（plugins/）

把通用能力抽象为 harness 插件（client bundle，装完即生效），后续 UI 优化都在这两个插件里持续进行：

| 插件 | 能力 |
| --- | --- |
| **dsh-deep-ui** | 每轮回答结束后自动折叠 AI 思考过程（工具调用/推理/步骤），摘要「已工作 X 分 X 秒」+ 折叠图标（收起箭头向右/展开向下），横线分隔后再展示回答 |
| **dsh-remote** | 手机互联入口：侧边栏手机图标 + UI 弹窗（同 Wi-Fi 扫码）、连接状态绿点、二维码自动加载 |

### 安装 / 卸载（装进 harness profile）
```bash
pnpm plugins:install            # 写入 ~/.dsh/profiles/web 的 cordis.patch.yml + 依赖并 pnpm install
# 重启 harness（或重启桌面端 DeepSeek Harness UI）后生效
pnpm plugins:install --remove   # 卸载
```

> 插件结构：每个插件是 npm 包（`dsh.client` 声明 + `exports["./client"]` 的 ModuleLoader bundle + 空 node 半身）。
> 桌面端内置注入（inject.js）与 dsh-remote 以 `window.__dshPhoneInject` 互斥，装插件后由插件接管。

---
## 🚀 发布（CI/CD）

见 `.github/workflows/`：

- **CI**（push / PR）：`pnpm install → typecheck → test → build`
- **Release**（推送 `v*` 标签）：
  - 桌面端自动构建并上传 **GitHub Release**：macOS arm64（Apple Silicon）+ macOS x64（Intel）的 `.dmg`、Windows 的 `.msi` / `.exe`
  - TUI 自动发布 **npm**（`@dsh-ui/tui`，需 `NPM_TOKEN` secret）

```bash
git tag v0.1.0 && git push origin v0.1.0   # 触发发布
```

---

## 🤝 贡献指南

欢迎提交 Issue 与 PR！请遵循以下约定：

1. **Fork + 分支**：从 `main` 切出 `feat/xxx` 或 `fix/xxx` 分支
2. **本地校验**（提交前必须通过）：
   ```bash
   pnpm install
   pnpm typecheck   # 全量类型检查
   pnpm test        # 协议层测试
   pnpm build       # 全量构建
   ```
3. **协议改动**：涉及 harness 交互时，先对活 harness 实测（`pnpm --filter @dsh-ui/protocol smoke`），并在 `packages/protocol` 更新类型与注释
4. **提交信息**：`feat` / `fix` / `docs` / `chore` + 简述（如 `fix(desktop): 二维码自动加载`）
5. **PR**：描述改动内容、验证方式、截图（如有 UI 变更）
6. **测试**：新增逻辑尽量在 `packages/protocol` 加纯逻辑断言（`pnpm test`），不依赖 harness 即可跑

> 代码风格：TypeScript 严格模式；Rust 侧 `cargo check` 零警告；保持零不必要依赖。

---

## 📄 License

MIT

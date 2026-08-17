# dsh-ui 安装与使用指南

覆盖四个客户端：**TUI（命令行）**、**桌面端（macOS）**、**手机互联 H5**、**VS Code 扩展**。
所有客户端都要求本机有正在运行的 harness（`dsh --profile web`，默认 127.0.0.1:3080）。

## 0. 前置条件

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 22 | 所有客户端运行时（TUI / 桥接 / 扩展） |
| pnpm | 9.x | monorepo 构建 |
| Rust 工具链 | stable（≥1.85） | 仅桌面端编译 |
| `dsh` 命令 | ≥ 0.1.0-rc.6 | harness 本体（`npm i -g @deepseek-ai/dsh`） |

## 1. 终端 TUI（@dsh-ui/tui）

### 安装
```bash
# 方式 A：本地构建安装（推荐，当前未发布到 npm registry）
cd dsh-ui/apps/tui
pnpm install && pnpm build && pnpm pack   # 生成 dsh-ui-tui-0.1.0.tgz
npm i -g ./dsh-ui-tui-0.1.0.tgz

# 方式 B：monorepo 内直接运行
cd dsh-ui && pnpm --filter @dsh-ui/tui dev
```
> 已通过实测：tgz 全局安装后 `dsh-tui --once` 可对活 harness 正常返回。

### 使用
```bash
dsh-tui                     # 交互模式（真实终端）
dsh-tui --once              # 一次性打印（CI / 管道）
dsh-tui --once -- --session <id>   # 导出会话历史
dsh-tui --url http://127.0.0.1:4000 # 自定义端口
```
| 按键 | 作用 |
| --- | --- |
| ↑/↓、Enter | 列表选择 / 进入会话 |
| 输入 + Enter | 会话内发送消息（`session.prompt`） |
| ↑/↓、PgUp/PgDn | 会话内滚动历史 |
| Esc / q / Ctrl+C | 返回列表 / 退出 |

## 2. 桌面端（Tauri，macOS）

### 安装
```bash
# 构建发布包
cd dsh-ui/apps/desktop
pnpm install
pnpm tauri:build
# 产物：
#   src-tauri/target/release/bundle/macos/dsh-ui.app
#   src-tauri/target/release/bundle/dmg/dsh-ui_0.1.0_aarch64.dmg
```
双击 `.dmg` 安装（把 `dsh-ui.app` 拖入 Applications）。
> 未签名构建：首次打开如被 Gatekeeper 拦截，右键 → 打开，或 `xattr -dr com.apple.quarantine /Applications/dsh-ui.app`。

### 使用
- 启动后显示着陆页 → 点 **进入 harness 界面**（自动连接 harness，已在运行则直接导航）
- 进入界面后，**左下角有悬浮 📱 图标**（设置入口旁，带桥接状态绿点）：点击弹出扫码窗口
- 扫码窗口提供两种连接方式：
  - **同一 Wi-Fi**：显示局域网地址 + 二维码，手机扫码进入 H5
  - **任意网络（公网）**：点"开启公网访问"→ cloudflared 快速隧道（免费、免账号），生成带访问令牌的公网 URL + 二维码，手机在任何网络扫码即可
- 菜单栏/托盘：**手机互联（扫码访问）**、**打开主界面**、**退出**

## 3. 手机互联 H5（@dsh-ui/mobile-h5）

### 启动桥接服务
```bash
cd dsh-ui/apps/mobile-h5
pnpm install && pnpm build
pnpm start        # 默认 4173 端口，监听 0.0.0.0
# 或桌面端菜单"手机互联"里点"启动桥接服务"（release 版内置桥接脚本）
```

### 手机访问
1. 手机与 Mac 连**同一 Wi-Fi**
2. 手机浏览器打开 `http://<Mac局域网IP>:4173`（IP 可在扫码窗口看到）
3. 浏览会话 → 进入查看历史 → 底部输入消息发送（4s 轮询刷新）
4. 深链直达：`http://<IP>:4173/?session=<sessionId>`

> 安全提示：桥接服务无鉴权，仅建议可信局域网使用。

## 4. VS Code 扩展（dsh-ui-extension）

### 安装（本地开发方式）
```bash
cd dsh-ui/apps/vscode-extension
pnpm install && pnpm compile
# 在 VS Code 中按 F5（Extension Development Host）加载
```

### 使用
- 命令面板（Cmd+Shift+P）→ `DeepSeek Harness: Open UI`：打开面板（自动拉起 harness）
- `DeepSeek Harness: Stop Harness`：停止
- 面板内按钮：`host.describe` / `session.list` / 在浏览器打开完整界面

## 5. 常见问题

| 问题 | 处理 |
| --- | --- |
| TUI 退出后终端卡住 | 已修复（v0.1.0+ 退出时中止实时流并强制退出）；升级重装即可 |
| 手机打不开 4173 | 检查防火墙是否放行 4173；确认桥接服务监听 `0.0.0.0`（`lsof -iTCP:4173 -sTCP:LISTEN`） |
| 桌面端中文输入法异常（调试模式） | 已知：部分输入法在 tauri dev 模式有兼容问题，正式包通常正常；如仍异常请反馈 |
| 端口被占用 | harness 默认 3080 / 桥接 4173 / vite 1422，冲突时用环境变量 `PORT` 换端口并同步给客户端 |

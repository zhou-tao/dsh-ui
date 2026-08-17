# dsh-ui

deepseek-harness 的 UI 层 monorepo：**Tauri 桌面程序** + **VS Code 扩展**，共享同一套实测过的 harness 协议。

## 1. 对接方案分析（决策记录）

### 背景事实（本仓库建立时实测，harness v0.1.0-rc.6）
- harness（`@deepseek-ai/dsh`，来源 deepseek-ai/deepseek-harness）是 Cordis 4 插件架构，通过 `dsh --profile <name>` 启动 profile。
- 内置 `web` profile 已包含完整服务端：webserver（node:http）+ apiproxy（host 端 HTTP API 层）+ 前端静态资源 + 浏览器端动态 UI。
- 浏览器 UI 与 host 的传输协议（已实测验证，见 §2）：unary RPC 走 `POST /api/{method}`，下行事件走 WebSocket（浏览器）/ SSE（Node）。

### 三种候选方案
| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **A. CLI/进程调用（stdio JSONL）** | 两端统一（Tauri sidecar 与 VSCode child_process 同一套）；无端口/守护进程管理；版本解耦 | harness 目前只有一次性 `headless` 模式，交互式 UI 需自建 stdio bridge profile（新插件+自维护协议）；无法与浏览器 Web UI 并存多客户端 |
| **B. HTTP/WS 本地服务（复用 apiproxy）** | **harness 现成、已测、覆盖全**（session/workspace/goal/settings/credentials/llm/skill/subagent/host）；多客户端可同连；两端只需薄客户端+进程生命周期管理 | 需管理守护进程生命周期与 loopback 安全；VSCode webview 网络受限，需扩展宿主代理（或 CSP 放行） |
| **C. Node SDK 嵌入** | VSCode 扩展（Node 宿主）可进程内嵌入，类型安全、零 IPC | **Tauri 的 Rust 核心无法嵌入 Node SDK**，必须起 sidecar Node 进程（退化为 A）；依赖树大、版本锁死、生命周期耦合 |

### 推荐：B 为主，协议层独立成包
1. **两个客户端共享 `@dsh-ui/protocol`**：把 apiproxy 的 wire 协议（信封 + 方法 + 事件帧）固化为一个零依赖 TS 包，桌面端与扩展都只依赖它。
2. **Tauri 桌面端**：Rust 侧负责 spawn/stop `dsh --profile web` 子进程，主窗口 webview 直接加载 harness UI（原生窗口 + 进程管理 = MVP 的全部桌面职责）。
3. **VSCode 扩展**：扩展宿主 spawn/stop 同一 profile，WebviewPanel 内**代理桥**（postMessage ↔ 扩展宿主 fetch ↔ apiproxy），webview CSP 保持严格、不受网络策略影响；同时提供"在浏览器打开完整界面"。
4. 将来若需"单进程离线/仅单一客户端"，可平移为方案 A（自建 `dsh-ui` profile + stdio 桥）；若需深入定制 harness 内部，才在扩展侧考虑 C。

## 2. 已验证的 wire 协议（实测，非推测）

```
unary RPC:  POST {base}/api/{method}
            body  { "type": "client-request", "rpcId": <uuid>, "method": <string>, "payload": <any> }
            resp  { "type": "server-response", "rpcId": <uuid>, "result": { "ok": true, "value": <any> } | { "ok": false, "error": {code,message} } }
respond:    POST {base}/api/respond            (客户端回答 approval/question)
downlink:   /api/events.mux /api/events.host   (浏览器: WebSocket; Node: SSE, "\n\n" 分帧)
```

RPC 方法（35 个，命名空间：host/session/workspace/goal/settings/credentials/llm/skill/subagent）：

```
host.describe            session.create / prompt / cancel / rename / history / search / fork / attachment / models / list
workspace.create/list/rename/delete    goal.create/edit/pause/resume/complete/clear
settings.describe/update/mutate/replace   credentials.describe/set/unset
llm.providers / llm.models   skill.list   subagent.list/history/prompt/interrupt
```

实测样例（本机 `dsh --profile web` @ 127.0.0.1:3080）：
```bash
curl -X POST http://127.0.0.1:3080/api/host.describe -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"<uuid>","method":"host.describe","payload":{}}'
# -> {"type":"server-response","rpcId":"...","result":{"ok":true,"value":{"version":"0.0.1",
#     "cwd":"/Users/zhoutao","provider":"deepseek-official","model":"deepseek-v4-flash","attachedSessions":3,...}}}
```

## 3. Monorepo 结构

```
dsh-ui/
├── package.json / pnpm-workspace.yaml / turbo.json / tsconfig.base.json
├── packages/
│   └── protocol/          # @dsh-ui/protocol — 零依赖 wire 协议包（传输层 + 方法类型 + 事件帧），已冒烟验证
│       └── examples/smoke.ts   # 对活 harness 的冒烟脚本：pnpm smoke
├── apps/
│   ├── desktop/           # @dsh-ui/desktop — Tauri 2（Rust 管 harness 进程 + Vite 前端壳）
│   │   └── src-tauri/     # Cargo.toml / tauri.conf.json / capabilities / src/{main,lib}.rs / icons/
│   └── vscode-extension/  # dsh-ui-extension — spawn harness + WebviewPanel 代理桥
│       ├── src/{extension,harness,webview}.ts
│       └── media/panel.html
```

## 4. 当前状态
- ✅ protocol 包：构建通过，冒烟测试对活服务器真实返回（host.describe / session.list / workspace.list）
- ✅ VSCode 扩展：tsc 编译通过（`pnpm --filter dsh-ui-extension compile`）
- ✅ 桌面前端：vite 构建通过；Rust 侧已写好（进程管理+窗口导航），**本机缺 Rust 工具链，未编译验证**
- ⚠️ 桌面端下一步：安装 Rust（rustup），`pnpm --filter @dsh-ui/desktop tauri:dev` 首次编译验证；
  生产打包前 `pnpm tauri:icon` 生成 icns/ico，并把 harness 打包为 sidecar 二进制（externalBin）
- ⚠️ 扩展下一步：`F5` 运行 Extension Development Host 实测面板桥；接入 mux 事件流（协议包已提供 harnessFrames）

## 5. 前置依赖
- Node ≥ 22、pnpm 9（本机已具备）
- Rust 工具链（rustup + cargo，桌面端编译需要，当前缺失）
- `dsh` 命令可用（`npm i -g @deepseek-ai/dsh` 或通过 npx）

## 6. 快速开始
```bash
pnpm install
pnpm build              # 全 workspace 构建
pnpm smoke              # protocol 冒烟：需本机 harness web profile 在跑（dsh --profile web）
pnpm --filter @dsh-ui/desktop tauri:dev   # 桌面端（需 Rust）
pnpm --filter dsh-ui-extension compile    # 扩展编译
```

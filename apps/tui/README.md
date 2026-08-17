# @dsh-ui/tui — DeepSeek Harness 终端客户端

Ink v7（React）编写的 TUI，复用 `@dsh-ui/protocol` 直连 harness web profile（默认 `http://127.0.0.1:3080`）。

## 依赖
- Node ≥ 22（自带全局 WebSocket，实时流依赖它）
- pnpm 9
- harness web profile 在运行（`dsh --profile web`；不运行则 TUI 连接失败）

## 安装与启动
```bash
cd dsh-ui
pnpm install

# 交互模式（需要真实终端）
pnpm --filter @dsh-ui/tui dev

# 一次性打印模式（无 TTY / CI 也能跑）
pnpm --filter @dsh-ui/tui once

# 一次性 + 导出某个会话的历史渲染
pnpm --filter @dsh-ui/tui once -- --session <sessionId>

# 连接非默认端口
pnpm --filter @dsh-ui/tui dev -- --url http://127.0.0.1:4000
```

> 提示：非 TTY 环境（管道、CI、无终端）会自动走一次性打印模式，不会报 Ink raw mode 错误。

## 交互操作

### 会话列表视图
| 按键 | 作用 |
| --- | --- |
| ↑ / ↓ | 选择会话 |
| Enter | 进入所选会话 |
| r | 刷新列表 |
| q / Ctrl+C | 退出 |

### 会话视图
| 按键 | 作用 |
| --- | --- |
| 输入文字 + Enter | 向 agent 发送消息（`session.prompt`） |
| ↑ / ↓ | 滚动历史 |
| PgUp / PgDn | 快速翻页 |
| Esc | 返回会话列表 |
| Ctrl+C | 退出 |

## 能看到什么
- **顶部**：harness 版本 / provider / model / cwd / 挂载会话数
- **会话列表**：运行中（●）与空闲（○）会话，含 cwd
- **会话视图**：历史消息（用户消息、AI 回复、工具调用、回合/步骤进度）
- **实时流**：订阅 `/api/events.mux`（WebSocket），agent 运行中的新事件实时追加（按 seq 去重，断线自动重连）

## 参数
| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--url` | `http://127.0.0.1:3080` | harness 地址 |
| `--once` | false | 一次性打印模式（非交互） |
| `--session <id>` | 空 | 与 `--once` 搭配，导出指定会话历史 |

## 已实现 / 规划
- [x] 会话列表 / 历史渲染 / 实时事件流 / 输入发送
- [ ] approval / question 交互（`/api/respond`）
- [ ] 会话搜索 / 新建会话（`session.create`）

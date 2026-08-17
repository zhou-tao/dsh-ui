// 纯逻辑冒烟测试：format 层（事件渲染 / 对话组装 / 会话标题）不依赖 harness 即可运行。
// 用法：pnpm --filter @dsh-ui/protocol test
import { conversationItems, sessionDisplayTitle, renderSessionEvent, CONVERSATION_NOISE_TYPES } from '../dist/index.js';

let failed = 0;
function check(name, cond) {
  if (cond) { console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}

// 1) 会话标题：title 优先 → cwd 目录名 → sessionId
check('displayTitle 用持久化标题', sessionDisplayTitle({ sessionId: 's1', cwd: '/a/b', projections: { values: { title: '我的会话' } } }) === '我的会话');
check('displayTitle 无标题取 cwd 目录名', sessionDisplayTitle({ sessionId: 's1', cwd: '/a/b/c' }) === 'c');
check('displayTitle 兜底 sessionId', sessionDisplayTitle({ sessionId: 's-abc' }) === 's-abc');

// 2) 对话组装：过滤噪声、保留完整消息
const events = [
  { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '你好' }] } },
  { type: 'assistant/chunk', seq: 2, time: 2, data: { chunk: 'x' } },          // 噪声：流式分片
  { type: 'request/header', seq: 3, time: 3, data: {} },                       // 噪声：请求元数据
  { type: 'assistant/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: '# 回复\n\n- a\n- b' }] } } },
  { type: 'tool/call', seq: 5, time: 5, data: { name: 'run_code', arguments: '{"a":1}' } },
  { type: 'tool/result', seq: 6, time: 6, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
];
const items = conversationItems(events);
check('chunk 被过滤', items.filter((i) => i.text.includes('x')).length === 0);
check('request/header 被过滤', !items.some((i) => i.text.includes('request')));
check('用户消息完整', items.some((i) => i.kind === 'user' && i.text === '你好'));
check('AI 消息保留 markdown 原文', items.some((i) => i.kind === 'ai' && i.text.includes('# 回复')));
check('工具调用渲染', items.some((i) => i.kind === 'tool' && i.text.includes('run_code')));
check('工具结果嵌套文本提取', items.some((i) => i.kind === 'dim' && i.text.includes('ok')));

// 3) max 截断
const truncated = conversationItems(events, { max: 2 });
check('max 截断生效', truncated.length === 2);

// 4) renderSessionEvent 仍可用
const lines = renderSessionEvent(events[0]);
check('renderSessionEvent 用户行', lines.length === 1 && lines[0].text === '你: 你好');

// 5) 噪声集合包含 chunk
check('NOISE 含 assistant/chunk', CONVERSATION_NOISE_TYPES.has('assistant/chunk'));

console.log('');
if (failed > 0) { console.error(failed + ' 项失败'); process.exit(1); }
console.log('全部通过');

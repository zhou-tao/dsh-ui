import { marked } from 'marked';
import {
  CONVERSATION_NOISE_TYPES,
  conversationItems,
  sessionDisplayTitle,
  type ConversationItem,
  type SessionEvent,
  type SessionSummary,
  type WorkspaceView,
  type HostDescribeValue,
} from '@dsh-ui/protocol';
import { client } from './api';

// ---------- markdown ----------
marked.setOptions({ gfm: true, breaks: true });

/** 先转义再交给 marked：保证输出安全（不渲染原始 HTML），同时 markdown 语法（代码块/表格/列表等）正常渲染。 */
function md(text: string): string {
  try {
    return marked.parse(esc(text)) as string;
  } catch {
    return esc(text).replace(/\n/g, '<br>');
  }
}

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const content = $('content');
const footer = $('footer');
const titleEl = $('title');
const hostinfoEl = $('hostinfo');
const backBtn = $<HTMLButtonElement>('back');

// ---------- state ----------
type View = { kind: 'list' } | { kind: 'conv'; sessionId: string };
let view: View = { kind: 'list' };
let sessions: SessionSummary[] = [];
let workspaces: WorkspaceView[] = [];
let contentHtml = '';
let pollTimer: ReturnType<typeof setInterval> | undefined;
let historyLoading = false;
// 用户手动展开的折叠（按折叠序号持久化）：轮询重建对话后保持手动状态，不被重置
const manualFoldOpen = new Map<number, boolean>();

// ---------- helpers ----------
function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(t: number): string {
  const d = new Date(t);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function sessionTitle(s: SessionSummary): string {
  return sessionDisplayTitle(s);
}

/** 复用 harness 的 chevron-down 图标（模型选择右侧同款）：收起时箭头向右、展开时向下（CSS 旋转）。 */
const CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="' +
  'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z' +
  '" fill="currentColor"/></svg>';

function itemHtml(it: ConversationItem): string {
  switch (it.kind) {
    // 我的消息：右侧气泡（仿桌面端 dsh：浅蓝底、圆角 22px、最宽 82%）
    case 'user':
      return '<div class="msg-row user"><div class="bubble">' + md(it.text) + '</div></div>';
    // AI 消息：左侧 markdown 文本（无标签）
    case 'ai':
      return '<div class="msg-row ai"><div class="ai-body">' + md(it.text) + '</div></div>';
    case 'tool':
      return '<div class="msg-row tool">' + esc(it.text) + '</div>';
    case 'dim':
      return '<div class="msg-row dim">' + esc(it.text) + '</div>';
    case 'err':
      return '<div class="msg-row err">' + esc(it.text) + '</div>';
  }
}

/** 已工作时长（与 harness "Deep diving..." 时钟同一格式：X秒 / X分YY秒）。 */
function fmtElapsed(sec: number): string {
  if (sec <= 0) return '';
  if (sec < 60) return sec + '秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + '分' + (s < 10 ? '0' + s : '' + s) + '秒';
}

/** 折叠头部文案：已工作 + 时长（无时长时仅"已工作"）。 */
function workLabel(sec: number): string {
  return sec > 0 ? '已工作 ' + fmtElapsed(sec) : '已工作';
}

// ---------- 按轮次分组（我的提问 → 思考过程 → 回答） ----------
interface TurnGroup {
  user: ConversationItem[]; // 本轮我的消息（气泡）
  process: ConversationItem[]; // 思考过程（工具调用/步骤等，可折叠）
  answer: ConversationItem | null; // 最终回答（回答下方展示）
  seconds: number; // 已工作时长（秒）
  startMs: number; // 本轮开始时间戳（思考中实时计时锚点）
}

function groupConversation(events: SessionEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let cur: TurnGroup | null = null;
  let firstTime = 0;
  let lastTime = 0;
  const close = (): void => {
    if (!cur) return;
    cur.seconds = firstTime && lastTime ? Math.max(0, Math.round((lastTime - firstTime) / 1000)) : 0;
    groups.push(cur);
    cur = null;
  };
  for (const ev of events) {
    if (CONVERSATION_NOISE_TYPES.has(ev.type)) continue;
    const t = typeof ev.time === 'number' ? ev.time : 0;
    if (ev.type === 'user/message') {
      close();
      cur = { user: [], process: [], answer: null, seconds: 0, startMs: t };
      firstTime = t;
      lastTime = t;
    } else {
      if (!cur) {
        cur = { user: [], process: [], answer: null, seconds: 0, startMs: t };
        firstTime = t;
        lastTime = t;
      }
      if (t) lastTime = t;
    }
    for (const it of conversationItems([ev])) {
      if (it.kind === 'user') cur.user.push(it);
      else if (it.kind === 'ai') {
        // 多个回答时，前面的回答并入思考过程
        if (cur.answer) cur.process.push(cur.answer);
        cur.answer = it;
      } else cur.process.push(it);
    }
  }
  close();
  return groups;
}

function turnHtml(g: TurnGroup): string {
  const parts: string[] = [];
  for (const u of g.user) parts.push(itemHtml(u));
  if (g.process.length > 0) {
    const foldBody = g.process.map(itemHtml).join('');
    if (g.answer) {
      // 已完成轮次：默认收起（无 open），下方横线隔开，再展示回答
      parts.push(
        '<div class="turn-fold" data-seconds="' + g.seconds + '">' +
          '<button type="button" class="fold-head">' +
            '<span class="chev">' + CHEVRON_SVG + '</span>' +
            '<span class="fold-label">' + workLabel(g.seconds) + '</span>' +
          '</button>' +
          '<div class="fold-body" hidden>' + foldBody + '</div>' +
        '</div>' +
        '<div class="turn-divider"></div>'
      );
    } else {
      // 思考中：默认展开 + 头部「已工作 X秒」实时计时（data-start 供计时器刷新）
      parts.push(
        '<div class="turn-fold live open" data-start="' + (g.startMs || '') + '">' +
          '<button type="button" class="fold-head">' +
            '<span class="chev">' + CHEVRON_SVG + '</span>' +
            '<span class="fold-label">已工作 <span class="fold-time"></span></span>' +
          '</button>' +
          '<div class="fold-body">' + foldBody + '</div>' +
        '</div>'
      );
    }
  }
  if (g.answer) parts.push(itemHtml(g.answer));
  return parts.join('');
}

/** 思考中的折叠：每秒刷新「已工作 X秒」。 */
function startLiveTicker(): void {
  setInterval(() => {
    const now = Date.now();
    for (const fold of content.querySelectorAll<HTMLElement>('.turn-fold.live[data-start]')) {
      const start = Number(fold.dataset.start);
      if (!start) continue;
      const t = fold.querySelector('.fold-time');
      if (!t) continue;
      t.textContent = fmtElapsed(Math.max(0, Math.round((now - start) / 1000)));
    }
  }, 1000);
}

/** 绑定折叠开关：点击折叠头部切换展开/收起，并记录手动状态（按序号）。 */
function bindFolds(): void {
  let idx = 0;
  for (const el of content.querySelectorAll('.turn-fold')) {
    const fold = el as HTMLElement;
    const head = fold.querySelector('.fold-head');
    if (!head || (head as HTMLElement).dataset.bound) { idx++; continue; }
    (head as HTMLElement).dataset.bound = '1';
    const thisIdx = idx;
    head.addEventListener('click', () => {
      const body = fold.querySelector('.fold-body') as HTMLElement | null;
      fold.classList.toggle('open');
      if (body) body.hidden = !body.hidden;
      manualFoldOpen.set(thisIdx, fold.classList.contains('open'));
    });
    idx++;
  }
}

/** 轮询重建后恢复用户手动展开状态（未手动操作过的折叠保持默认：进行中展开、已完成收起）。 */
function restoreManualFolds(): void {
  let idx = 0;
  for (const f of content.querySelectorAll<HTMLElement>('.turn-fold')) {
    if (manualFoldOpen.has(idx)) {
      const wantOpen = manualFoldOpen.get(idx) === true;
      f.classList.toggle('open', wantOpen);
      const body = f.querySelector<HTMLElement>('.fold-body');
      if (body) body.hidden = !wantOpen;
    }
    idx++;
  }
  // 清理已不存在的序号
  for (const k of manualFoldOpen.keys()) if (k >= idx) manualFoldOpen.delete(k);
}

// ---------- rendering ----------
function renderList(): void {
  backBtn.hidden = true;
  titleEl.textContent = 'DeepSeek Harness';
  footer.innerHTML = '';
  if (sessions.length === 0) {
    content.innerHTML = '<div class="empty">没有会话</div>';
    return;
  }

  // 按工作区分组：桌面端（harness sidebar）以 workspace 为组、组内按 workspace 的 sessionIds 顺序展示
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const used = new Set<string>();
  const groups: { title: string; path: string; members: SessionSummary[] }[] = [];
  for (const w of workspaces) {
    const members = (w.sessionIds ?? [])
      .map((id) => byId.get(id))
      .filter((s): s is SessionSummary => !!s);
    if (members.length === 0) continue;
    groups.push({ title: w.title || (w.path.split(/[\\/]+/).pop() || w.workspaceId), path: w.path, members });
    for (const s of members) used.add(s.sessionId);
  }
  const ungrouped = sessions.filter((s) => !used.has(s.sessionId));
  if (ungrouped.length > 0) {
    groups.push({ title: '未分组', path: '', members: ungrouped });
  }

  const groupHtml = (g: { title: string; path: string; members: SessionSummary[] }): string =>
    '<div class="ws-group">' +
      '<div class="ws-head">' +
        '<span class="ws-title">' + esc(g.title) + '</span>' +
        '<span class="ws-count">' + g.members.length + '</span>' +
      '</div>' +
      (g.path ? '<div class="ws-path">' + esc(g.path) + '</div>' : '') +
      g.members
        .map(
          (s) =>
            '<div class="session-card" data-sid="' + esc(s.sessionId) + '">' +
              '<div class="session-top">' +
                '<span class="session-title">' + esc(sessionTitle(s)) + '</span>' +
                '<span class="badge ' + (s.running ? 'running' : 'idle') + '">' + (s.running ? '运行中' : '空闲') + '</span>' +
              '</div>' +
              '<div class="session-time">更新于 ' + fmtTime(s.updatedAt) + '</div>' +
            '</div>'
        )
        .join('') +
    '</div>';

  content.innerHTML = groups.map(groupHtml).join('');
  for (const el of content.querySelectorAll('.session-card')) {
    el.addEventListener('click', () => {
      const sid = (el as HTMLElement).dataset.sid ?? '';
      if (sid) void openConversation(sid);
    });
  }
}

async function openConversation(sessionId: string): Promise<void> {
  view = { kind: 'conv', sessionId };
  backBtn.hidden = false;
  const s = sessions.find((x) => x.sessionId === sessionId);
  titleEl.textContent = s ? sessionTitle(s) : '会话 ' + sessionId.slice(0, 8);
  contentHtml = '';
  content.innerHTML = '<div class="empty"><span class="spin"></span> 加载中…</div>';
  renderInputBar();
  await loadHistory(sessionId);
  startPolling(sessionId);
}

async function loadHistory(sessionId: string): Promise<void> {
  if (historyLoading) return; // 防重入：轮询与手动重试并发时不叠加请求
  historyLoading = true;
  try {
    // maxMessages 分页 + 桥接层过滤流式分片：手机端下载量从 ~6MB 降到 ~100KB
    const h = await client.call('session.history', { sessionId, maxMessages: 60 });
    const groups = groupConversation(h.events.map((it) => it.event));
    contentHtml = groups.map(turnHtml).join('');
    renderLines();
  } catch (err) {
    content.innerHTML =
      '<div class="status-line err">加载失败: ' + esc(err instanceof Error ? err.message : String(err)) + '</div>' +
      '<div class="retry-row"><button id="retry" class="retry">重试</button></div>';
    const btn = document.getElementById('retry');
    if (btn) btn.addEventListener('click', () => void openConversation(sessionId));
  } finally {
    historyLoading = false;
  }
}

function renderLines(): void {
  if (!contentHtml) {
    content.innerHTML = '<div class="empty">暂无消息</div>';
    return;
  }
  content.innerHTML = contentHtml;
  content.scrollTop = content.scrollHeight;
  bindFolds();
  restoreManualFolds();
}

function renderInputBar(): void {
  footer.innerHTML =
    '<div class="inputbar"><textarea id="input" rows="1" placeholder="输入消息…"></textarea><button id="send">发送</button></div>';
  const input = $<HTMLTextAreaElement>('input');
  const send = $<HTMLButtonElement>('send');
  const doSend = (): void => {
    void sendPrompt(input.value);
  };
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    // 仅拦截 Enter 发送；复制/粘贴/剪切等快捷键保持默认行为
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      doSend();
    }
  });
  input.focus();
}

async function sendPrompt(text: string): Promise<void> {
  if (view.kind !== 'conv' || !text.trim()) return;
  const input = $<HTMLTextAreaElement>('input');
  const send = $<HTMLButtonElement>('send');
  send.disabled = true;
  input.value = '';
  contentHtml += itemHtml({ kind: 'user', text: text.trim() });
  renderLines();
  try {
    // 当前 harness 载荷：content 数组 + mode=queue（排队发送）
    await client.call('session.prompt', {
      sessionId: view.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: text.trim() }],
    });
  } catch (err) {
    contentHtml += itemHtml({ kind: 'err', text: '发送失败: ' + (err instanceof Error ? err.message : String(err)) });
    renderLines();
  } finally {
    send.disabled = false;
    input.focus();
  }
}

function startPolling(sessionId: string): void {
  stopPolling();
  pollTimer = setInterval(() => {
    if (view.kind === 'conv' && view.sessionId === sessionId && !historyLoading) {
      void loadHistory(sessionId);
    }
  }, 10000);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

// ---------- boot ----------
async function boot(): Promise<void> {
  try {
    const [host, s, w] = await Promise.all([
      client.call('host.describe', {}),
      client.call('session.list', {}),
      client.call('workspace.list', {}),
    ]);
    const h = host as HostDescribeValue;
    sessions = (s as { items: SessionSummary[] }).items ?? [];
    workspaces = (w as { items: WorkspaceView[] }).items ?? [];
    hostinfoEl.textContent =
      h.provider + ' / ' + h.model + ' · 工作区 ' + workspaces.length + ' · 会话 ' + sessions.length + ' · ' + h.cwd;
    const target = new URLSearchParams(location.search).get('session');
    if (target && sessions.some((x) => x.sessionId === target)) {
      void openConversation(target);
    } else {
      renderList();
    }
  } catch (err) {
    content.innerHTML =
      '<div class="status-line err">无法连接 harness: ' + esc(err instanceof Error ? err.message : String(err)) + '</div>';
  }
}

startLiveTicker();

backBtn.addEventListener('click', () => {
  stopPolling();
  view = { kind: 'list' };
  footer.innerHTML = '';
  renderList();
});

void boot();

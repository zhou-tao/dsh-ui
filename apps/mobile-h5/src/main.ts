import {
  renderSessionEvent,
  type RenderLine,
  type SessionSummary,
  type HostDescribeValue,
} from '@dsh-ui/protocol';
import { client } from './api';

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
let lines: RenderLine[] = [];
let pollTimer: ReturnType<typeof setInterval> | undefined;

// ---------- helpers ----------
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(t: number): string {
  const d = new Date(t);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function lineHtml(ln: RenderLine): string {
  const cls = ln.tone === 'dim' ? 'msg dim' : 'msg ' + (ln.tone === 'accent' ? 'tool' : 'ai');
  return '<div class="' + cls + '">' + esc(ln.text) + '</div>';
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
  content.innerHTML = sessions
    .map((s) =>
      '<div class="session-card" data-sid="' + esc(s.sessionId) + '">' +
        '<div class="session-top">' +
          '<span class="session-id">' + esc(s.sessionId) + '</span>' +
          '<span class="badge ' + (s.running ? 'running' : 'idle') + '">' + (s.running ? '运行中' : '空闲') + '</span>' +
        '</div>' +
        '<div class="session-cwd">' + esc(s.cwd ?? '') + '</div>' +
        '<div class="session-time">更新于 ' + fmtTime(s.updatedAt) + '</div>' +
      '</div>'
    )
    .join('');
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
  titleEl.textContent = '会话 ' + sessionId.slice(0, 8);
  lines = [];
  content.innerHTML = '<div class="empty"><span class="spin"></span> 加载中…</div>';
  renderInputBar();
  await loadHistory(sessionId);
  startPolling(sessionId);
}

async function loadHistory(sessionId: string): Promise<void> {
  try {
    const h = await client.call('session.history', { sessionId });
    lines = [];
    for (const item of h.events.slice(-200)) {
      lines.push(...renderSessionEvent(item.event));
    }
    renderLines();
  } catch (err) {
    content.innerHTML = '<div class="status-line err">加载失败: ' + esc(err instanceof Error ? err.message : String(err)) + '</div>';
  }
}

function renderLines(): void {
  if (lines.length === 0) {
    content.innerHTML = '<div class="empty">暂无消息</div>';
    return;
  }
  content.innerHTML = lines.map(lineHtml).join('');
  content.scrollTop = content.scrollHeight;
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
    if (e.key === 'Enter' && !e.shiftKey) {
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
  lines.push({ text: '你: ' + text.trim() });
  renderLines();
  try {
    await client.call('session.prompt', { sessionId: view.sessionId, prompt: text.trim() });
  } catch (err) {
    lines.push({ text: '发送失败: ' + (err instanceof Error ? err.message : String(err)), tone: 'err' });
    renderLines();
  } finally {
    send.disabled = false;
    input.focus();
  }
}

function startPolling(sessionId: string): void {
  stopPolling();
  pollTimer = setInterval(() => {
    if (view.kind === 'conv' && view.sessionId === sessionId) {
      void loadHistory(sessionId);
    }
  }, 4000);
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
    const [host, s] = await Promise.all([
      client.call('host.describe', {}),
      client.call('session.list', {}),
    ]);
    const h = host as HostDescribeValue;
    sessions = (s as { items: SessionSummary[] }).items ?? [];
    hostinfoEl.textContent = h.provider + ' / ' + h.model + ' · 会话 ' + sessions.length + ' · ' + h.cwd;
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

backBtn.addEventListener('click', () => {
  stopPolling();
  view = { kind: 'list' };
  footer.innerHTML = '';
  renderList();
});

void boot();

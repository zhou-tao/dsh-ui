// dsh-ui 桌面端注入脚本（嵌入 harness 页面）：
// 1) 手机互联悬浮图标（FAB）：与设置图标同尺寸、无底、hover 圆形高亮；位置与设置图标镜像（右缘距右分界线 == 设置图标左缘距左边界）；右上角小圆点默认隐藏、手机已连接时显示绿色；
// 2) 手机互联 UI 层弹窗（替代原系统级独立窗口）：扫码连接（局域网 / 公网隧道），样式参考移动端远程控制弹窗。
(() => {
  if (window.__dshPhoneInject) return;
  window.__dshPhoneInject = true;

  const BRIDGE = 'http://127.0.0.1:4173'; // 桥接服务（与 lib.rs BRIDGE_PORT 保持一致）
  const STALE_MS = 180000; // 与桥接 /status 的 connected 窗口一致（3 分钟）
  const state = { bridgeUp: false, lanIp: '', connected: false, tunnelUrl: '', tunnelToken: '', tunnelRunning: false, loading: false };

  // ---------- Tauri invoke 助手 ----------
  function tauriInvoke(cmd, args) {
    try {
      const t = window.__TAURI_INTERNALS__;
      if (t && typeof t.invoke === 'function') return t.invoke(cmd, args);
    } catch (e) { /* ignore */ }
    return Promise.reject(new Error('no tauri invoke: ' + cmd));
  }

  // ---------- DOM 工具 ----------
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'style' && attrs[k] && typeof attrs[k] === 'object') Object.assign(n.style, attrs[k]);
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    if (children) for (const ch of [].concat(children)) if (ch != null) n.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch);
    return n;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ======================================================================
  // 1) 悬浮图标 FAB
  // ======================================================================
  const fab = el('div', {
    id: 'dsh-phone-fab',
    title: '手机互联（扫码连接）',
    'aria-label': '手机互联',
    role: 'button',
    style: {
      position: 'fixed',
      zIndex: '2147483000',
      width: '28px', // 与侧边栏设置图标按钮一致
      height: '28px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      color: '#5b9dff',
      background: 'transparent',
      borderRadius: '50%', // 圆形：hover 高亮区域为圆形
      userSelect: 'none',
      pointerEvents: 'auto',
      transition: 'background .12s ease, transform .12s ease, opacity .12s ease',
    },
  });
  fab.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>' +
    '<line x1="12" y1="18" x2="12.01" y2="18"></line></svg>';
  const dot = el('span', {
    id: 'dsh-phone-dot',
    style: {
      position: 'absolute',
      top: '2px',
      right: '2px',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      border: '1.5px solid #0b1220',
      background: '#22c55e',
      display: 'none', // 默认不展示；手机已连接（3 分钟内有过访问）时显示绿色
      boxShadow: '0 0 0 1px rgba(34,197,94,.35)',
    },
  });
  fab.appendChild(dot);

  function placeFab() {
    const area = document.querySelector('.hHd-Xa_settingsArea, [class*="settingsArea"]');
    let btn = null;
    if (area) {
      const btns = area.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        const a = (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '') + (b.textContent || '');
        if (/设置|settings/i.test(a)) { btn = b; break; }
      }
      if (!btn && btns.length) btn = btns[btns.length - 1];
    }
    const anchor = btn ?? area;
    if (!anchor || !document.body.contains(fab)) {
      if (!document.body.contains(fab)) document.body.appendChild(fab);
      return;
    }
    const r = anchor.getBoundingClientRect();
    const areaRect = area ? area.getBoundingClientRect() : null;
    const S = 28;
    if (areaRect) {
      // 左侧边距 = 设置图标左缘到设置区左缘的距离；FAB 右缘到右侧分界线的距离与之镜像一致
      const leftGap = r.left - areaRect.left;
      fab.style.left = Math.max(4, areaRect.right - leftGap - S) + 'px';
    } else {
      fab.style.left = Math.max(6, r.right + 6 - 100) + 'px';
    }
    fab.style.top = (r.top + r.height / 2 - S / 2) + 'px';
    fab.style.bottom = 'auto';
    fab.style.position = 'fixed';
  }
  fab.addEventListener('mouseenter', () => { fab.style.transform = 'scale(1.08)'; fab.style.background = 'rgba(255,255,255,.09)'; });
  fab.addEventListener('mouseleave', () => { fab.style.transform = 'scale(1)'; fab.style.background = 'transparent'; });

  // ======================================================================
  // 2) 手机互联 UI 层弹窗
  // ======================================================================
  let modalRoot = null;
  // 状态条元素必须在 IIFE 作用域声明（buildModal 只负责赋值），
  // renderModal / startBridge / startTunnel 才能访问——之前声明在 buildModal 内部导致 ReferenceError，状态一直卡在"正在检测…"
  let statusPill = null;
  let statusDot = null;
  let statusText = null;
  let pillSpinner = null;

  function setStatus(kind, text) {
    if (!statusText) return;
    statusText.textContent = text;
    if (kind === 'loading') {
      if (pillSpinner) pillSpinner.style.display = 'inline-block';
      if (statusDot) statusDot.style.display = 'none';
    } else {
      if (pillSpinner) pillSpinner.style.display = 'none';
      if (statusDot) { statusDot.style.display = 'inline-block'; statusDot.style.background = kind === 'connected' ? '#22c55e' : kind === 'err' ? '#f59e0b' : '#64748b'; }
    }
  }

  function openModal() {
    if (!modalRoot) buildModal();
    modalRoot.style.display = 'flex';
    void ensureReady();
  }

  /** 连接服务是否可达（纯 HTTP 探测，不依赖 Tauri IPC）。 */
  async function bridgeReachable() {
    try {
      const res = await fetch(BRIDGE + '/status', { cache: 'no-store' });
      if (!res.ok) return false;
      const s = await res.json();
      return !!s.running;
    } catch (e) { return false; }
  }

  /** 打开弹窗后自动准备（全程无需用户点击）：连接服务未运行则尝试自动启动（最多重试 2 次）→ 自动生成二维码。
   *  状态与二维码全部走本地 HTTP（/status、/qr），Tauri invoke 仅作为"启动服务"的尽力而为兜底。 */
  async function ensureReady() {
    state.loading = true;
    if (modalRoot) renderModal(); // 立即显示 loading UI
    let up = await bridgeReachable();
    if (!up) {
      for (let i = 0; i < 2 && !up; i++) {
        setStatus('loading', '正在准备连接…');
        try { await tauriInvoke('start_bridge'); } catch (e) { /* 应用未就绪时忽略，继续重试 */ }
        await new Promise((r) => setTimeout(r, 900));
        up = await bridgeReachable();
      }
      if (!up) {
        state.loading = false;
        setStatus('err', '连接准备失败，请检查网络后重试');
        if (modalRoot) renderModal();
        return;
      }
    }
    await refreshStatus();
  }
  function closeModal() {
    if (modalRoot) modalRoot.style.display = 'none';
  }

  function buildModal() {
    modalRoot = el('div', {
      id: 'dsh-phone-modal',
      style: {
        position: 'fixed', inset: '0', zIndex: '2147483001',
        display: 'none', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(2,6,17,.62)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      },
    });

    const card = el('div', {
      style: {
        width: 'min(380px, calc(100vw - 48px))',
        maxHeight: 'calc(100dvh - 48px)', overflowY: 'auto',
        background: 'linear-gradient(180deg, #131e36 0%, #0d1626 100%)',
        border: '1px solid rgba(148,163,184,.16)',
        borderRadius: '16px',
        boxShadow: '0 24px 70px rgba(0,0,0,.55), 0 2px 12px rgba(0,0,0,.4)',
        color: '#e6edf3',
      },
    });

    // ---- 头部：渐变横幅 + 手机图标 + 标题 ----
    const header = el('div', {
      style: {
        position: 'relative',
        padding: '22px 20px 16px',
        background: 'linear-gradient(135deg, rgba(61,126,255,.24) 0%, rgba(106,92,255,.16) 55%, rgba(34,197,94,.10) 100%)',
        borderBottom: '1px solid rgba(148,163,184,.12)',
      },
    });
    const closeBtn = el('button', {
      'aria-label': '关闭',
      style: {
        position: 'absolute', top: '12px', right: '12px',
        width: '28px', height: '28px', border: '0', borderRadius: '8px',
        background: 'rgba(255,255,255,.08)', color: '#9fb0c8', cursor: 'pointer',
        fontSize: '16px', lineHeight: '1',
      },
      onclick: closeModal,
    }, '✕');
    const headRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [
      el('div', {
        style: {
          width: '42px', height: '42px', flex: 'none', borderRadius: '12px',
          background: 'linear-gradient(135deg, #3d7eff, #6a5cff)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 6px 16px rgba(61,126,255,.35)',
        },
        html:
          '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
          '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>' +
          '<line x1="12" y1="18" x2="12.01" y2="18"></line></svg>',
      }),
      el('div', {}, [
        el('div', { style: { fontSize: '16px', fontWeight: '600' } }, '手机互联'),
        el('div', { style: { fontSize: '12px', color: '#8b98ad', marginTop: '2px' } }, '手机扫码后即可浏览会话、发送消息'),
      ]),
    ]);
    header.appendChild(closeBtn);
    header.appendChild(headRow);
    card.appendChild(header);

    // ---- 状态条 ----
    statusPill = el('div', {
      style: {
        margin: '14px 20px 0', padding: '8px 12px', borderRadius: '10px',
        background: 'rgba(148,163,184,.08)', border: '1px solid rgba(148,163,184,.14)',
        display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: '#b7c3d6',
      },
    });
    pillSpinner = el('span', { style: { display: 'none', flex: 'none' } });
    statusDot = el('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: '#64748b', flex: 'none' } });
    statusText = el('span', {}, '正在检测…');
    statusPill.appendChild(pillSpinner);
    statusPill.appendChild(statusDot);
    statusPill.appendChild(statusText);
    card.appendChild(statusPill);

    // ---- 局域网（同一 Wi-Fi） ----
    const lanSection = el('div', { style: { padding: '16px 20px 6px' } }, [
      el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } }, [
        el('div', { style: { fontSize: '13px', fontWeight: '600', color: '#79c0ff' } }, '同一 Wi-Fi'),
        el('div', { style: { fontSize: '11px', color: '#64748b' } }, '手机与电脑连接同一网络'),
      ]),
    ]);
    card.appendChild(lanSection);

    const lanBody = el('div', { id: 'dsh-modal-lan-body', style: { padding: '0 20px 6px' } });
    card.appendChild(lanBody);

    // ---- 任意网络（公网）· 建设中 ----
    const pubSection = el('div', { style: { padding: '10px 20px 6px' } }, [
      el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } }, [
        el('div', { style: { fontSize: '13px', fontWeight: '600', color: '#64748b' } }, '任意网络（公网）'),
        el('span', { style: { fontSize: '11px', color: '#8b98ad', border: '1px solid rgba(148,163,184,.25)', borderRadius: '999px', padding: '1px 8px' } }, '建设中…'),
      ]),
    ]);
    card.appendChild(pubSection);
    const pubBody = el('div', { id: 'dsh-modal-pub-body', style: { padding: '0 20px 6px' } });
    card.appendChild(pubBody);

    // ---- 底部操作 ----
    const foot = el('div', {
      style: {
        display: 'flex', gap: '10px', justifyContent: 'center',
        padding: '14px 20px 18px', borderTop: '1px solid rgba(148,163,184,.1)', marginTop: '8px',
      },
    });
    const refreshBtn = el('button', {
      style: btnStyle('ghost'),
      onclick: () => refreshStatus(),
    }, '刷新状态');
    foot.appendChild(refreshBtn);
    card.appendChild(foot);

    const hint = el('div', {
      style: { padding: '0 20px 16px', fontSize: '11px', color: '#64748b', textAlign: 'center', lineHeight: 1.6 },
      html: '公网互联建设中 · 局域网访问无鉴权（仅限可信网络）',
    });
    card.appendChild(hint);

    modalRoot.appendChild(card);
    modalRoot.addEventListener('click', (e) => { if (e.target === modalRoot) closeModal(); });
    document.body.appendChild(modalRoot);

    // ESC 关闭
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalRoot.style.display === 'flex') closeModal(); });
  }

  function btnStyle(kind) {
    const base = {
      padding: '8px 16px', borderRadius: '10px', fontSize: '13px', cursor: 'pointer',
      border: '1px solid rgba(148,163,184,.2)', color: '#e6edf3', background: 'rgba(148,163,184,.1)',
      transition: 'filter .12s ease',
    };
    if (kind === 'primary') {
      base.background = 'linear-gradient(135deg, #3d7eff, #5a6cff)';
      base.border = '1px solid rgba(61,126,255,.6)';
      base.color = '#fff';
      base.fontWeight = '600';
    }
    return base;
  }

  function qrBox(url, size) {
    const box = el('div', {
      style: {
        margin: '10px 0 8px', background: '#fff', borderRadius: '12px', padding: '8px',
        display: 'inline-block', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
      },
    });
    const img = el('img', {
      src: BRIDGE + '/qr?text=' + encodeURIComponent(url) + '&size=' + (size || 200),
      alt: '二维码', width: String(size || 200), height: String(size || 200),
      style: { display: 'block', borderRadius: '6px' },
    });
    box.appendChild(img);
    return box;
  }

  function urlLine(url) {
    return el('div', {
      style: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px',
        color: '#9ecbff', wordBreak: 'break-all', margin: '4px 0',
        background: 'rgba(9,14,26,.6)', border: '1px solid rgba(148,163,184,.12)',
        borderRadius: '8px', padding: '6px 8px',
      },
    }, url);
  }

  function placeholder(text) {
    return el('div', {
      style: { fontSize: '12.5px', color: '#8b98ad', padding: '14px 0', lineHeight: 1.7 },
    }, text);
  }

  // ======================================================================
  // dsh 同款 loading spinner（复用左侧会话列表的加载样式：20px 圆环 + 主题色上缘 + 0.8s 旋转）
  // ======================================================================
  function ensureSpinStyle() {
    if (document.getElementById('dsh-phone-spin-style')) return;
    const st = document.createElement('style');
    st.id = 'dsh-phone-spin-style';
    st.textContent = '@keyframes dsh-phone-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(st);
  }
  function spinner(size) {
    ensureSpinStyle();
    return el('span', {
      style: {
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        border: '2px solid var(--dsw-alias-border-l2, rgba(148,163,184,.25))',
        borderTopColor: 'var(--dsw-alias-brand-primary, #3964fe)',
        animation: 'dsh-phone-spin .8s linear infinite',
        display: 'inline-block', flex: 'none',
      },
    });
  }
  function loadingBlock(text) {
    return el('div', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '18px 0', color: '#8b98ad', fontSize: '13px' },
    }, [spinner(20), el('span', {}, text)]);
  }
  function msg(e) {
    return e && e.message ? e.message : String(e);
  }

  // ======================================================================
  // 状态刷新
  // ======================================================================
  async function refreshStatus(quiet) {
    // quiet（后台轮询）：不切换 loading、不重建二维码内容，避免弹窗每 5s 闪一下；
    // 非 quiet（打开弹窗/手动刷新）：先显示 loading，再渲染二维码。
    if (!quiet) {
      state.loading = true;
      if (modalRoot && modalRoot.style.display === 'flex') renderModal();
    }
    // 连接服务状态 + 局域网 IP + 手机连接状态：全部来自桥接 /status（纯 HTTP，不依赖 Tauri IPC）
    try {
      const res = await fetch(BRIDGE + '/status', { cache: 'no-store' });
      if (res.ok) {
        const s = await res.json();
        state.bridgeUp = !!s.running;
        state.connected = !!s.connected;
        state.lanIp = (s.lanIp && String(s.lanIp)) || '';
      } else {
        state.bridgeUp = false;
        state.connected = false;
      }
    } catch (e) {
      state.bridgeUp = false;
      state.connected = false;
    }
    state.loading = false;
    renderFab();
    if (modalRoot && modalRoot.style.display === 'flex') {
      if (quiet) renderPill(); // 轮询只更新状态条/圆点
      else renderModal();
    }
  }

  /** 只更新状态条（不触碰二维码内容）。 */
  function renderPill() {
    if (state.connected) setStatus('connected', '手机已连接 ✓');
    else if (state.bridgeUp) setStatus('idle', '等待手机扫码…');
    else setStatus('err', '连接准备失败，请重试');
  }

  function renderFab() {
    // 圆点：默认隐藏；手机已连接（3 分钟内访问过桥接）时显示绿色
    if (state.connected) {
      dot.style.display = 'block';
      dot.style.background = '#22c55e';
    } else {
      dot.style.display = 'none';
    }
    fab.style.opacity = state.bridgeUp ? '1' : '.75';
  }

  function renderModal() {
    // 仅当二维码尚未就绪时才显示 loading（轮询期间内容保持不变，避免闪烁）
    const showLoading = state.loading && !(state.bridgeUp && state.lanIp);
    // 状态条
    if (showLoading) {
      setStatus('loading', '正在生成二维码…');
    } else if (state.connected) {
      setStatus('connected', '手机已连接 ✓');
    } else if (state.bridgeUp) {
      setStatus('idle', '等待手机扫码…');
    } else {
      setStatus('err', '连接准备失败，请重试');
    }

    // 局域网区
    const lanBody = document.getElementById('dsh-modal-lan-body');
    if (!lanBody) return;
    lanBody.innerHTML = '';
    if (showLoading) {
      lanBody.appendChild(loadingBlock('正在加载二维码…'));
    } else if (!state.bridgeUp) {
      lanBody.appendChild(placeholder('连接服务未就绪，请稍后重试。'));
    } else if (state.lanIp) {
      const lanUrl = 'http://' + state.lanIp + ':4173';
      lanBody.appendChild(el('div', { style: { textAlign: 'center' } }, [qrBox(lanUrl, 200)]));
      lanBody.appendChild(urlLine(lanUrl));
    } else {
      lanBody.appendChild(placeholder('未能获取局域网 IP，请检查网络连接。'));
    }

    // 公网区（建设中）
    const pubBody = document.getElementById('dsh-modal-pub-body');
    if (!pubBody) return;
    pubBody.innerHTML = '';
    pubBody.appendChild(
      el('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', color: '#64748b', fontSize: '12.5px', padding: '10px 0' },
        html: '<span style="flex:none">🚧</span><span>公网互联建设中，敬请期待<br>（当前支持同一 Wi-Fi 局域网互联）</span>',
      })
    );


  }

  // ======================================================================
  // 动作
  // ======================================================================
  // ======================================================================
  // 挂载 & 轮询
  // ======================================================================
  document.body.appendChild(fab);
  fab.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openModal(); });
  fab.addEventListener('touchend', (e) => { e.preventDefault(); openModal(); });

  // 暴露给 Tauri 菜单/托盘（open_mobile_qr 通过 eval 调用）
  window.__dshPhoneModal = { open: openModal, close: closeModal, refresh: refreshStatus };

  // 定位（侧边栏 DOM 就绪后生效；侧边栏折叠/展开时重新定位）
  let tries = 0;
  const timer = setInterval(() => { if (placeFab() || ++tries > 40) clearInterval(timer); }, 500);
  window.addEventListener('resize', placeFab);
  setTimeout(placeFab, 800);
  setTimeout(placeFab, 3000);
  try {
    const mo = new MutationObserver(() => placeFab());
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  } catch (e) { /* ignore */ }

  // 状态轮询：每 5s quiet 更新圆点/状态条（不重建二维码，避免弹窗闪烁）
  refreshStatus();
  setInterval(() => refreshStatus(true), 5000);
})();

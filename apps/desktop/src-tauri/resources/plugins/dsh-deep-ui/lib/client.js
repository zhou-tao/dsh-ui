// dsh-deep-ui — UI 层增强客户端插件。
// 能力：
//   - 思考中：折叠块默认展开，头部「已工作 X秒/X分YY秒」实时计时（与 harness
//     "Deep diving..." 计时同一格式；Deep diving 行自身的时钟隐藏，避免重复）；
//   - 输出回答时：自动折叠收起（保留「已工作 + 最终时长」摘要 + 折叠图标），
//     下方横线隔开后再展示回答结果；
//   - 展开态不再显示左侧竖线。
//
// 实现说明（针对 dsh-web-app rc.6 的真实 DOM）：
// 会话列表为 column[data-chat-flow] > 子行，节点 flowItem 带 data-chat-flow-kind
// （user / context / assistant-step / tool-call / turn-tail / turn-error / compaction…），
// turnStatus（"Deep diving..."）是无 kind 的列子行。折叠引擎按行工作：
//   - 用户边界 = kind=user（及 steering）的行；
//   - 思考过程 = 用户行之后、下一用户行之前的所有过程行（含无 kind 的 turnStatus）；
//   - 回答 = 段内最后一个含 markdown 正文的 assistant-step（turn-tail 只是"用时"元数据行）；
//   - 无回答且有 shimmer（思考中）→ 展开 + 实时计时；回答出现 → 收起 + 冻结时长。
// React 后续渲染的新行会被 reconcile 收进折叠体，避免逃逸。
// DOM 层实现（对 harness 会话列做增量包裹），后续 UI 优化持续在此插件进行。
window.__ModuleLoader__.load({
  id: 'dsh-deep-ui',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var inject = [];

    // ---------- 折叠样式（与 dsh 主题令牌一致） ----------
    (function () {
      var tagId = 'dsh-deep-ui-css';
      if (document.querySelector('style[data-dsh-deep-ui-css="' + tagId + '"]')) return;
      var st = document.createElement('style');
      st.setAttribute('data-dsh-deep-ui-css', tagId);
      st.textContent = '.dsh-deep-ui-fold{margin:6px 0 2px}.dsh-deep-ui-fold-head{' +
        'display:inline-flex;align-items:center;gap:5px;background:none;border:0;' +
        'color:var(--dsw-alias-label-secondary,#8b949e);font:var(--dsw-font-s-strong-13,12px/1.5 system-ui);' +
        'cursor:pointer;padding:4px 6px;border-radius:7px;max-width:100%}' +
        '.dsh-deep-ui-fold-head:hover{color:var(--dsw-alias-label-primary,#e6edf3);background:var(--dsw-alias-interactive-bg-hover,rgba(148,163,184,.1))}' +
        '.dsh-deep-ui-fold-chev{display:inline-flex;flex:none;transition:transform .15s ease;transform:rotate(-90deg)}' +
        '.dsh-deep-ui-fold.open .dsh-deep-ui-fold-chev{transform:rotate(0deg)}' +
        '.dsh-deep-ui-fold-body{display:none;margin:2px 0 6px 6px}' +
        '.dsh-deep-ui-fold.open .dsh-deep-ui-fold-body{display:block}' +
        '.dsh-deep-ui-fold-divider{border:0;border-top:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,.22));margin:10px 0 4px}' +
        '.dsh-deep-ui-fold-body>*{margin:6px 0;min-width:0}' +
        '.dsh-deep-ui-fold-body>[data-chat-flow-kind]{width:100%}' +
        // 隐藏 "Deep diving..." 自带的实时时钟（避免与折叠头部的已工作计时重复）
        '[class*="turnStatusClock"]{display:none!important}';
      document.head.appendChild(st);
    })();

    // ---------- 折叠引擎（列行级别） ----------
    (function () {
      var COLUMN_SEL = '[data-chat-flow]';
      // 用户边界 kind：一段"用户提问→AI 思考→回答"的起点
      var BOUNDARY_KINDS = { user: 1, steering: 1 };
      // 思考过程 kind：会被收进折叠区
      var PROCESS_KINDS = {
        context: 1, 'assistant-step': 1, 'tool-call': 1, command: 1,
        'turn-error': 1, 'turn-max-tokens': 1, 'model-retry': 1,
        compaction: 1, 'manual-compaction': 1, unknown: 1,
        todo: 1, goal: 1, reasoning: 1, think: 1
      };
      var observer = null;
      var timer = null;
      var ticker = null;

      function kindOf(el) {
        return el && el.getAttribute ? el.getAttribute('data-chat-flow-kind') : null;
      }

      function isBoundary(el) {
        var k = kindOf(el);
        return !!k && !!BOUNDARY_KINDS[k];
      }

      // 过程行判定：已知过程 kind（turnStatus "Deep diving..."/steering 等无 kind 行
      // 留在列内，作为 React 插入回答行的锚点，不收进折叠体）。
      function isProcess(el) {
        if (!el || !el.getAttribute) return false;
        var k = el.getAttribute('data-chat-flow-kind');
        return !!k && !!PROCESS_KINDS[k];
      }

      // 回答行：assistant-step 且内部渲染了 markdown 正文
      // （区别于 Think/推理步骤 —— 推理行含 ReasoningRow，无 markdown 类）。
      function isAnswerRow(el) {
        if (!el || !el.querySelector) return false;
        var k = el.getAttribute ? el.getAttribute('data-chat-flow-kind') : null;
        if (k !== 'assistant-step') return false;
        return !!el.querySelector('[class*="markdown"]');
      }

      // 从段内的 turn-tail（"用时 X秒/X分YY秒"）解析最终时长（毫秒）；无则 0
      function turnTailSeconds(seg) {
        for (var i = 0; i < seg.length; i++) {
          var k = seg[i].getAttribute ? seg[i].getAttribute('data-chat-flow-kind') : null;
          if (k !== 'turn-tail') continue;
          var txt = seg[i].innerText || '';
          var m = txt.match(/用时\s*(\d+)\s*分\s*(\d+)?\s*秒/) || txt.match(/用时\s*(\d+)\s*秒/);
          if (m) {
            if (m[2] != null) return Number(m[1]) * 60 + Number(m[2]);
            return Number(m[1]);
          }
        }
        return 0;
      }

      // 已工作时长：与 harness "Deep diving..." 时钟同一格式（{seconds}秒 / {minutes}分{seconds}秒）
      function fmtElapsed(ms) {
        if (!ms || ms <= 0) return '';
        var total = Math.max(0, Math.floor(ms / 1000));
        var m = Math.floor(total / 60), s = total % 60;
        return m > 0 ? m + '分' + (s < 10 ? '0' + s : '' + s) + '秒' : s + '秒';
      }

      function chevronSvg() {
        return '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="' +
          'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z' +
          '" fill="currentColor"/></svg>';
      }

      // 进行中判定：元素自身（turnStatus 行）或其后代任一 turnStatus 仍在 shimmer 动画
      function hasRunningShimmer(el) {
        if (!el) return false;
        var cands = [];
        if (el.matches && el.matches('[class*="turnStatus"]')) cands.push(el);
        if (el.querySelectorAll) {
          var sub = el.querySelectorAll('[class*="turnStatus"]');
          for (var i = 0; i < sub.length; i++) cands.push(sub[i]);
        }
        for (var j = 0; j < cands.length; j++) {
          var anim = getComputedStyle(cands[j]).animationName;
          if (anim && String(anim).indexOf('shimmer') >= 0) return true;
        }
        return false;
      }

      function elapsedFor(user) {
        var t = Number(user.getAttribute('data-dsh-ts'));
        return t ? Math.max(0, Date.now() - t) : 0;
      }

      function setFoldTime(fold, ms) {
        var t = fold.querySelector('.dsh-deep-ui-fold-time');
        if (!t) return;
        t.textContent = fmtElapsed(ms);
      }

      // 用户行之后的段（止于下一用户边界；排除自己的折叠块）
      function segmentOf(user) {
        var column = user.parentElement;
        if (!column || !column.hasAttribute('data-chat-flow')) return null;
        var children = Array.prototype.slice.call(column.children);
        var idx = children.indexOf(user);
        if (idx < 0) return null;
        var seg = [];
        for (var i = idx + 1; i < children.length; i++) {
          var c = children[i];
          if (c.classList && c.classList.contains('dsh-deep-ui-fold')) continue;
          if (isBoundary(c)) break;
          seg.push(c);
        }
        return { column: column, seg: seg };
      }

      function buildFold(user) {
        var fold = document.createElement('div');
        fold.className = 'dsh-deep-ui-fold';
        var head = document.createElement('button');
        head.type = 'button';
        head.className = 'dsh-deep-ui-fold-head';
        head.title = '点击展开/收起思考过程';
        head.innerHTML = '<span class="dsh-deep-ui-fold-chev">' + chevronSvg() +
          '</span><span class="dsh-deep-ui-fold-label">已工作 <span class="dsh-deep-ui-fold-time"></span></span>';
        var body = document.createElement('div');
        body.className = 'dsh-deep-ui-fold-body';
        var divider = document.createElement('div');
        divider.className = 'dsh-deep-ui-fold-divider';
        fold.appendChild(head);
        fold.appendChild(body);
        fold.appendChild(divider);
        head.addEventListener('click', function () { fold.classList.toggle('open'); });
        // 插到段内第一个"回答行"之前；思考中无回答则追加到列尾
        var column = user.parentElement;
        var ins = null;
        var n = user.nextElementSibling;
        while (n) {
          if (isBoundary(n)) break;
          if (n.classList && n.classList.contains('dsh-deep-ui-fold')) { n = n.nextElementSibling; continue; }
          if (isAnswerRow(n)) { ins = n; break; }
          n = n.nextElementSibling;
        }
        if (ins) column.insertBefore(fold, ins); else column.appendChild(fold);
        return fold;
      }

      // 更新一个用户行的折叠状态：收过程行 → 按"思考中/已出回答"切换展开与计时
      function updateFold(user) {
        var segInfo = segmentOf(user);
        if (!segInfo) return;
        var column = segInfo.column;
        var seg = segInfo.seg;
        if (seg.length < 1) return;
        // 回答 = 段内最后一个"assistant-step + markdown 正文"行（turn-tail 只是元数据行）
        var answerIdx = -1;
        for (var j = seg.length - 1; j >= 0; j--) {
          if (isAnswerRow(seg[j])) { answerIdx = j; break; }
        }
        // 思考过程 = 回答之前的已知过程 kind 行；无回答（思考中）则取全部过程行
        var processRows = [];
        var upper = answerIdx === -1 ? seg.length : answerIdx;
        for (var p2 = 0; p2 < upper; p2++) {
          if (isProcess(seg[p2])) processRows.push(seg[p2]);
        }
        var running = false;
        for (var q = 0; q < seg.length; q++) {
          if (hasRunningShimmer(seg[q])) { running = true; break; }
        }
        // 回答行存在（段内任意位置）即视为已输出回答；无回答且 shimmer 中视为思考中
        var hasAnswer = answerIdx >= 0;
        var fold = user._dshFold;
        if (!fold && processRows.length > 0 && (hasAnswer || running)) {
          fold = buildFold(user);
          user.setAttribute('data-dsh-folded', '1');
          user._dshFold = fold;
          fold._dshUser = user;
        }
        if (!fold) return;
        var body = fold.querySelector('.dsh-deep-ui-fold-body');
        if (!body) return;
        for (var r = 0; r < processRows.length; r++) {
          if (processRows[r].parentElement !== body) body.appendChild(processRows[r]);
        }
        if (hasAnswer) {
          // 已输出回答：仅在此次"思考中→出回答"转换时自动收起一次 + 冻结最终时长
          // （优先取 turn-tail 的"用时"，回退实时计时）+ 把折叠块重定位到回答行之前。
          // 之后不再强制收起：用户手动展开的折叠保持展开（背景 mutation 不再干扰）。
          user.removeAttribute('data-dsh-live');
          if (!fold._dshFinalized) {
            fold._dshFinalized = true;
            fold.classList.remove('open');
            var tt = turnTailSeconds(seg);
            fold._dshFrozen = tt > 0 ? tt * 1000 : elapsedFor(user);
            setFoldTime(fold, fold._dshFrozen);
            var answerEl = seg[answerIdx];
            if (answerEl && answerEl.parentElement === column && fold.nextElementSibling !== answerEl) {
              column.insertBefore(fold, answerEl);
            }
          }
        } else if (running) {
          // 思考中：默认展开 + 实时计时
          user.setAttribute('data-dsh-live', '1');
          fold.classList.add('open');
          setFoldTime(fold, elapsedFor(user));
        } else {
          // 未运行也无回答（如被打断）：冻结但保持展开
          user.removeAttribute('data-dsh-live');
          fold.classList.add('open');
          if (fold._dshFrozen == null) fold._dshFrozen = elapsedFor(user);
          setFoldTime(fold, fold._dshFrozen);
        }
      }

      // 每秒刷新所有"思考中"折叠的实时时长
      function tickFolds() {
        var users = document.querySelectorAll('[data-chat-flow-kind="user"][data-dsh-live]');
        for (var i = 0; i < users.length; i++) {
          var fold = users[i]._dshFold;
          if (fold && fold.isConnected) setFoldTime(fold, elapsedFor(users[i]));
        }
      }

      function startTicker() {
        if (ticker) return;
        ticker = setInterval(tickFolds, 1000);
      }

      function process() {
        var column = document.querySelector(COLUMN_SEL);
        if (!column) return;
        var users = column.querySelectorAll('[data-chat-flow-kind="user"]');
        for (var i = 0; i < users.length; i++) {
          if (!users[i].getAttribute('data-dsh-ts')) {
            users[i].setAttribute('data-dsh-ts', String(Date.now()));
          }
          try { updateFold(users[i]); } catch (e) { /* 单个段落失败不影响其他 */ }
        }
      }

      function start() {
        if (observer) return;
        observer = new MutationObserver(function () {
          clearTimeout(timer);
          timer = setTimeout(process, 600);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        startTicker();
        setTimeout(process, 800);
        setTimeout(process, 3000);
      }

      exports.start = start;
    })();

    function apply(ctx) {
      exports.start();
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

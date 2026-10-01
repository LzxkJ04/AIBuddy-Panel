/* ─────────────────────────────────────────────
   AIBuddy Panel · 顶栏通知中心（vue-next-admin 风格）
   铃铛图标钮 + 未读红点角标（error / warn）+ 右对齐下拉面板
   （最近 8 条网关运行事件：时间 HH:mm:ss / 级别圆点 / 分类 / 两行消息）。

   数据源：GET /api/logs?limit=8&offset=0（同源 fetch，默认带 cookie 会话；
   未登录返回 401 / 网络失败一律静默，列表显示「暂无事件」，绝不抛异常）。
   响应形态先兼容再取数：data.items / data.entries / data 数组 /
   顶层 items / entries / list / 裸数组都认；字段缺了用占位显示。

   未读判定：localStorage（aibuddy-notify-read）存最近一次查看的
   最大条目 id 与时间，超过即算未读；打开下拉即标记已读。
   首轮成功拉到数据时把当前水位记为已读（与 app.js 导航徽标同一约定，
   否则一装上就挂着一串历史错误）；日志被清空（id 回落）时水位跟着回落。

   节奏：每 60 秒轮询一次；页面不可见（document.hidden）时跳过；
   回到前台立即补拉一次。

   结构约定照 ui/js/prefs.js 的 ensureTopbarButtons：铃铛放在**独立容器**
   里插到 #topbar-status 之前（app.js 的 renderTopbarStatus 会整体重写它，
   不能插进去），再挂 MutationObserver 兜底自愈。
   下拉面板挂在 document.body 上用 fixed 定位 —— .main 是 overflow:hidden，
   挂在顶栏里会被裁掉。颜色一律走 tokens.css 变量（样式见 css/notify-center.css），
   深浅主题自动成立。
   ───────────────────────────────────────────── */

(function () {
  'use strict';

  /* ── 常量 ─────────────────────────────────── */
  var READ_KEY = 'aibuddy-notify-read';   // 已读水位：{ id, ts }（localStorage JSON）
  var POLL_MS = 60000;                    // 轮询间隔
  var FETCH_N = 8;                        // 面板最多展示条数
  var FETCH_TIMEOUT_MS = 8000;            // 单次请求兜底超时
  var PAGE_KEY = 'workbuddy-desktop-page';// 与 prefs.js / app.js 共用的当前页记忆键

  /* ── 内联 SVG 图标（stroke 风格与全站偏好 UI 一致，不用 emoji）── */
  function svg(path, size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      path + '</svg>';
  }
  var ICON = {
    /* lucide bell */
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    /* lucide rotate-cw */
    refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'
  };

  /* ── 小工具 ───────────────────────────────── */
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function numOf(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  /* 毫秒时间戳归一：秒（<1e12）×1000；字符串数字 / ISO 串都试着解析；解析不了给 0 */
  function normTs(v) {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? (v < 1e12 ? v * 1000 : v) : 0;
    if (typeof v === 'string') {
      if (/^\d+$/.test(v)) { var n = Number(v); return n < 1e12 ? n * 1000 : n; }
      var p = Date.parse(v);
      return isFinite(p) ? p : 0;
    }
    return 0;
  }
  function hhmmss(ms) {
    if (!ms) return '--:--:--';
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '--:--:--';
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* ── 响应形态兼容：从信封里捞出事件数组 ───── */
  function pickList(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload)) return payload;
    var d = payload.data;
    if (Array.isArray(d)) return d;
    if (d && typeof d === 'object') {
      if (Array.isArray(d.items)) return d.items;
      if (Array.isArray(d.entries)) return d.entries;
      if (Array.isArray(d.list)) return d.list;
    }
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.entries)) return payload.entries;
    if (Array.isArray(payload.list)) return payload.list;
    return [];
  }
  /* 单条归一：level 归一成 info/warn/error/debug，其余字段缺了给占位 */
  function normItem(raw) {
    raw = (raw && typeof raw === 'object') ? raw : {};
    var level = String(raw.level || raw.lvl || 'info').toLowerCase();
    if (level === 'warning') level = 'warn';
    else if (level === 'err') level = 'error';
    else if (['info', 'warn', 'error', 'debug'].indexOf(level) < 0) level = 'info';
    var msg = raw.message;
    if (msg === undefined || msg === null) msg = raw.text;
    if (msg === undefined || msg === null) msg = raw.msg;
    return {
      id: numOf(raw.id),
      ts: normTs(raw.ts !== undefined ? raw.ts : raw.time),
      level: level,
      category: String(raw.category || raw.cat || '').trim(),
      message: String(msg).trim()
    };
  }

  /* ── 已读水位 ─────────────────────────────── */
  function readWatermark() {
    try {
      var raw = JSON.parse(localStorage.getItem(READ_KEY) || 'null');
      if (raw && typeof raw === 'object') return { id: numOf(raw.id), ts: numOf(raw.ts) };
    } catch (e) {}
    return null; // null = 从未记录（首轮）
  }
  function writeWatermark(id, ts) {
    try { localStorage.setItem(READ_KEY, JSON.stringify({ id: id || 0, ts: ts || 0 })); } catch (e) {}
  }
  function maxOf(list) {
    var id = 0, ts = 0;
    list.forEach(function (it) { if (it.id > id) id = it.id; if (it.ts > ts) ts = it.ts; });
    return { id: id, ts: ts };
  }

  /* ── 运行期状态 ───────────────────────────── */
  var holder = null;      // 顶栏独立容器（自愈单位）
  var bellBtn = null;     // 铃铛按钮
  var badge = null;       // 红点角标
  var pop = null;         // 下拉面板（挂 body）
  var listEl = null;      // 列表容器
  var refreshBtn = null;  // 面板标题行的刷新钮
  var items = [];         // 最近一次成功拉到的事件（已归一、已排序、最多 8 条）
  var openState = false;
  var inflight = false;

  /* ── 未读计算与角标 ───────────────────────── */
  function unreadCount() {
    var wm = readWatermark();
    if (!wm) return 0; // 首轮水位未落盘前不报未读（firstRunSeed 落盘后才开始算）
    var n = 0;
    items.forEach(function (it) {
      if (it.level !== 'error' && it.level !== 'warn') return;
      var newer = (it.id > 0 && it.id > wm.id) || (it.id <= 0 && it.ts > wm.ts);
      if (newer) n++;
    });
    return n;
  }
  function paintBadge(n) {
    if (!badge || !bellBtn) return;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.add('on');
      bellBtn.title = '通知中心（' + n + ' 条未读告警）';
    } else {
      badge.classList.remove('on');
      bellBtn.title = '通知中心';
    }
  }
  /* 轮询后的未读刷新：顺带处理「日志被清空（id 回落）」——水位跟着回落，
     否则新日志的 id 永远小于水位，角标从此不再出现（口径同 app.js） */
  function updateBadge() {
    var wm = readWatermark();
    var mx = maxOf(items);
    if (wm && mx.id > 0 && mx.id < wm.id) {
      writeWatermark(mx.id, mx.ts);
      wm = readWatermark();
    }
    paintBadge(unreadCount());
  }
  /* 打开下拉即标记已读：水位推进到当前最大。没有数据时不动水位
     （拉取失败不能把水位抹成 0）。 */
  function markRead() {
    if (!items.length) { paintBadge(0); return; }
    var m = maxOf(items);
    var wm = readWatermark();
    if (!wm || m.id > wm.id || m.ts > wm.ts || m.id < wm.id) writeWatermark(m.id, m.ts);
    paintBadge(0);
  }
  /* 首轮成功：把当前水位记为已读，历史错误不追着新用户响 */
  function firstRunSeed() {
    if (readWatermark() !== null) return;
    var m = maxOf(items);
    writeWatermark(m.id, m.ts);
  }

  /* ── 拉取（静默失败）───────────────────────── */
  function fetchLogs() {
    if (inflight) return;
    inflight = true;
    if (refreshBtn) refreshBtn.classList.add('busy');
    var opts = { method: 'GET', headers: { 'Accept': 'application/json' } };
    try {
      if (typeof AbortController === 'function') {
        var ac = new AbortController();
        setTimeout(function () { try { ac.abort(); } catch (e) {} }, FETCH_TIMEOUT_MS);
        opts.signal = ac.signal;
      }
    } catch (e) { /* 老环境没有 AbortController 就不设超时 */ }
    fetch('/api/logs?limit=' + FETCH_N + '&offset=0', opts)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status); // 401 / 5xx 都走静默分支
        return res.json();
      })
      .then(function (json) {
        items = pickList(json).map(normItem);
        items.sort(function (a, b) { return (b.ts - a.ts) || (b.id - a.id); });
        items = items.slice(0, FETCH_N);
        firstRunSeed();
        if (openState) { renderList(); place(); markRead(); } // 人正看着：直接算已读
        else updateBadge();
      })
      .catch(function () {
        /* 401（未登录）/ 网络失败 / 超时：静默。列表空着就画「暂无事件」；
           已有旧数据则保留展示，不让一次网络抖动清空面板。 */
        if (openState) renderList();
      })
      .then(function () { // 兜底收尾（成功失败都走）
        inflight = false;
        if (refreshBtn) refreshBtn.classList.remove('busy');
      });
  }

  /* ── 面板渲染 ─────────────────────────────── */
  function renderList() {
    if (!listEl) return;
    listEl.textContent = '';
    if (!items.length) {
      var emp = el('div', 'nc-empty');
      emp.textContent = '暂无事件';
      listEl.appendChild(emp);
      return;
    }
    items.forEach(function (it) {
      var row = el('div', 'nc-item lv-' + it.level);
      var dot = el('span', 'nc-dot lv-' + it.level); // 口径与 page-logs.css 的 .log-dot 一致
      row.appendChild(dot);
      var main = el('div', 'nc-item-main');
      var top = el('div', 'nc-item-top');
      var cat = el('span', 'nc-cat');
      cat.textContent = it.category || '通用'; // 分类缺失给占位
      var time = el('span', 'nc-time');
      time.textContent = hhmmss(it.ts);
      top.appendChild(cat);
      top.appendChild(time);
      var msg = el('div', 'nc-msg');
      msg.textContent = it.message || '（无内容）'; // 消息缺失给占位；textContent 天然防注入
      if (it.message) msg.title = it.message;
      main.appendChild(top);
      main.appendChild(msg);
      row.appendChild(main);
      listEl.appendChild(row);
    });
  }

  /* fixed 定位：右缘对齐铃铛右缘，挂在顶栏下方；下方放不下就翻到按钮上方 */
  function place() {
    if (!pop || !bellBtn || !pop.classList.contains('open')) return;
    var r = bellBtn.getBoundingClientRect();
    var w = pop.offsetWidth || 340;
    var h = pop.offsetHeight || 300;
    var right = Math.max(8, window.innerWidth - r.right);
    if (right + w > window.innerWidth - 8) right = Math.max(8, window.innerWidth - w - 8);
    pop.style.right = right + 'px';
    var top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    pop.style.top = top + 'px';
  }

  function buildPop() {
    if (pop) return pop;
    pop = el('div', 'nc-pop');
    pop.id = 'nc-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '通知中心');
    var head = el('div', 'nc-pop-head');
    var title = el('b', 'nc-title');
    title.textContent = '最近事件';
    var sp = el('span', 'nc-head-sp');
    refreshBtn = el('button', 'nc-refresh');
    refreshBtn.type = 'button';
    refreshBtn.title = '刷新';
    refreshBtn.setAttribute('aria-label', '刷新事件');
    refreshBtn.innerHTML = svg(ICON.refresh, 13);
    refreshBtn.addEventListener('click', function () { fetchLogs(); });
    head.appendChild(title);
    head.appendChild(sp);
    head.appendChild(refreshBtn);
    listEl = el('div', 'nc-list');
    var foot = el('div', 'nc-foot');
    var viewAll = el('button', 'nc-viewall');
    viewAll.type = 'button';
    viewAll.textContent = '查看全部';
    viewAll.addEventListener('click', onViewAll);
    foot.appendChild(viewAll);
    pop.appendChild(head);
    pop.appendChild(listEl);
    pop.appendChild(foot);
    document.body.appendChild(pop);
    return pop;
  }

  /* 「查看全部」：跳日志页并关闭面板（口径同 prefs.js 的 go()：
     先落 localStorage 记忆键，再调 app.js 暴露的 showPage） */
  function onViewAll() {
    close();
    try { localStorage.setItem(PAGE_KEY, 'logs'); } catch (e) {}
    var fn = (window.wbApp && window.wbApp.showPage) || window.showPage;
    if (typeof fn === 'function') { try { fn('logs'); } catch (e) {} }
  }

  /* ── 开 / 关 ──────────────────────────────── */
  function onDocClick(e) {
    if (!openState) return;
    var t = e.target;
    if (pop && pop.contains(t)) return;
    if (bellBtn && bellBtn.contains(t)) return;
    close();
  }
  function onKey(e) {
    if (e.key === 'Escape' && openState) { e.preventDefault(); close(); }
  }
  function onResize() { place(); }

  function open() {
    buildPop();
    if (openState) { place(); return; }
    openState = true;
    pop.classList.add('open');
    if (bellBtn) bellBtn.classList.add('on');
    renderList();   // 先画（空数据=「暂无事件」占位），拉到新数据后重画
    place();
    markRead();     // 打开下拉即标记已读
    fetchLogs();    // 打开即拉最新，完成后再 markRead 一次（见 fetchLogs）
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
  }
  function close() {
    openState = false;
    if (pop) pop.classList.remove('open');
    if (bellBtn) bellBtn.classList.remove('on');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
  }

  /* ── 顶栏铃铛（独立容器 + MutationObserver 自愈）── */
  function ensureButton() {
    // 不插进 #topbar-status（app.js 的 renderTopbarStatus 会整体重写它），
    // 用独立容器插在它前面；再挂 MutationObserver 兜底自愈
    var bar = document.getElementById('topbar-status');
    if (!bar) return;
    if (holder && holder.parentNode) return; // 已插好，别动
    if (!holder) {
      holder = el('div', 'nc-holder');
      holder.id = 'nc-buttons';
    }
    if (!bellBtn) {
      bellBtn = el('button', 'tb-icon-btn nc-btn');
      bellBtn.id = 'nc-btn-bell';
      bellBtn.type = 'button';
      bellBtn.title = '通知中心';
      bellBtn.setAttribute('aria-label', '通知中心');
      bellBtn.setAttribute('aria-haspopup', 'dialog');
      bellBtn.innerHTML = svg(ICON.bell, 15);
      badge = el('span', 'nc-badge');
      badge.setAttribute('aria-hidden', 'true');
      bellBtn.appendChild(badge);
      bellBtn.addEventListener('click', function () {
        if (openState) close();
        else open();
      });
    }
    holder.textContent = '';
    holder.appendChild(bellBtn);
    bar.parentNode.insertBefore(holder, bar);
    // 自愈：状态徽标重写把容器冲掉时重新插回（只管「在不在 DOM」，
    // 不管顺序 —— prefs.js 的自愈也插在 topbar-status 前，两边都校顺序会互相打架）
    if (!ensureButton._mo) {
      ensureButton._mo = new MutationObserver(function () {
        var b2 = document.getElementById('topbar-status');
        var h2 = (holder && holder.parentNode) ? holder : document.getElementById('nc-buttons');
        if (!h2 && b2) { ensureButton(); return; }          // 容器被整个冲掉：重建
        if (h2 && h2.parentNode) return;                     // 还在 DOM 里：不干预
        if (b2 && h2) b2.parentNode.insertBefore(h2, b2);    // 被摘下来了：插回
        else if (h2 && h2.parentNode) h2.parentNode.removeChild(h2); // 顶栏没了就别硬塞
      });
      ensureButton._mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  /* ── 轮询 ─────────────────────────────────── */
  function tick() {
    if (document.hidden) return; // 页面不可见：跳过这一轮
    fetchLogs();
  }
  function startPolling() {
    if (startPolling._timer) return;
    startPolling._timer = setInterval(tick, POLL_MS);
    // 回到前台立即补拉一次（隐藏期间的轮询都被跳过了）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) tick();
    });
  }

  /* ── 启动 ─────────────────────────────────── */
  function boot() {
    ensureButton();
    startPolling();
    // 首拉延后一拍：给登录态 / app.js 的启动请求让路，也避开与其首屏请求撞车
    setTimeout(tick, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  /* 供外部（调试 / 其它模块）使用：手动刷新与开关面板 */
  window.wbNotifyCenter = {
    refresh: function () { fetchLogs(); },
    open: open,
    close: close,
    unread: unreadCount
  };
})();

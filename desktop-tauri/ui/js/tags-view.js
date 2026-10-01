/* ─────────────────────────────────────────────
   AIBuddy Panel · TagsView 页签栏（vue-next-admin 式）
   内容区顶部一条页签栏：当前页高亮（主色文字 + 主色软底 + 主色描边）、
   每个页签可单独关闭（×）、右侧「全部关闭」；首页（overview）固定
   不可关。页签清单持久化在 localStorage（aibuddy-tags），刷新后保留。

   接线方式（不改 index.html / app.js）：
   · DOM 由本文件动态注入 —— .main 内、.content 之前；
   · 页面切换靠包装 window.showPage 捕获（先记页签再调原函数），
     wbApp.showPage 换成访问器，谁读都拿到包装器、谁赋值都被接住；
   · 另在捕获阶段监听 .nav-item[data-page] 点击兜底（record 幂等，
     双触发无副作用）。
   ───────────────────────────────────────────── */

(function () {
  'use strict';

  var STORAGE_KEY = 'aibuddy-tags';        // 页签清单（数组 of page id）
  var PAGE_KEY = 'workbuddy-desktop-page'; // app.js 记忆的当前页
  var HOME = 'overview';                   // 首页页签固定不可关

  // 与 app.js 的 PAGES 保持一致（那边是脚本内常量读不到，改动时两处同步）
  var PAGES = ['overview', 'accounts', 'gateway', 'proxies', 'keys', 'docs', 'logs', 'tasks', 'requests', 'settings'];
  // 与 app.js 的 PAGE_LABELS 保持一致；优先取侧栏导航上的现成文案，取不到才退回这张表
  var LABELS = {
    overview: '报表',
    accounts: '账号',
    gateway: '模型管理',
    proxies: '网络代理',
    keys: '网关 Key',
    docs: '文档',
    logs: '日志',
    tasks: '定时任务',
    requests: '请求日志',
    settings: '设置',
  };

  var tags = loadTags(); // 页签 id 有序清单，overview 永远在第一位
  var current = HOME;    // 当前激活页签
  var root = null;       // .tags-view 容器
  var scrollEl = null;   // 左侧页签滚动区
  var installed = false; // showPage 包装是否已装上
  // 被包装的原 showPage；wbApp.showPage / window.showPage 被重新赋值时更新到这里
  var rawHolder = { fn: null };

  /* ── 存取 ─────────────────────────────────── */

  /** 读存档：非法 id 丢弃、去重；overview 永远第一（且唯一一份） */
  function loadTags() {
    var out = [HOME];
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(raw)) {
        raw.forEach(function (id) {
          if (typeof id === 'string' && PAGES.indexOf(id) !== -1 && out.indexOf(id) === -1) out.push(id);
        });
      }
    } catch (e) { /* 存档坏了就回到默认：只剩首页 */ }
    return out;
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tags)); } catch (e) { /* 隐私模式等场景忽略 */ }
  }

  /** 非法页名归一到 overview（与 app.js 的 showPage 同一取向） */
  function normalize(name) {
    return typeof name === 'string' && PAGES.indexOf(name) !== -1 ? name : HOME;
  }

  /** 页签文案：优先侧栏导航的 label（与界面天然同步），退回内置表 */
  function labelOf(page) {
    var item = document.querySelector('.nav-item[data-page="' + page + '"] .label');
    var text = item && item.textContent && item.textContent.trim();
    return text || LABELS[page] || page;
  }

  /* ── DOM ──────────────────────────────────── */

  /** 构建 .tags-view 并插到 .main 内、.content 之前；成功返回 true */
  function buildDom() {
    if (scrollEl) return true; // 已建好
    var main = document.querySelector('.main');
    var content = main && main.querySelector('.content');
    if (!main || !content) return false;

    root = document.createElement('div');
    root.className = 'tags-view';

    scrollEl = document.createElement('div');
    scrollEl.className = 'tags-scroll';
    scrollEl.setAttribute('role', 'tablist');
    scrollEl.setAttribute('aria-label', '页签栏');

    var ops = document.createElement('button');
    ops.type = 'button';
    ops.className = 'tags-ops';
    ops.textContent = '全部关闭';
    ops.title = '关闭除首页外的全部页签';
    ops.addEventListener('click', closeAll);

    root.appendChild(scrollEl);
    root.appendChild(ops);
    main.insertBefore(root, content);

    // 事件委托：页签重建（整表重建式重绘）不用逐个绑
    root.addEventListener('click', onRootClick);
    root.addEventListener('contextmenu', onRootContextmenu);
    root.addEventListener('keydown', onRootKeydown);
    return true;
  }

  /** 重绘页签（数量少，整表重建最省心）；激活项滚进可视区 */
  function render() {
    if (!scrollEl) return;
    scrollEl.textContent = '';
    tags.forEach(function (page) {
      var tag = document.createElement('div');
      // tag 内还要放关闭按钮，button 嵌 button 不合法，用 div + role/tabindex
      tag.className = 'tag' + (page === current ? ' active' : '') + (page === HOME ? ' home' : '');
      tag.setAttribute('role', 'tab');
      tag.setAttribute('aria-selected', page === current ? 'true' : 'false');
      tag.tabIndex = 0;
      tag.dataset.page = page;
      tag.title = page === HOME ? labelOf(page) + '（固定不可关闭）' : labelOf(page);

      var label = document.createElement('span');
      label.className = 'tag-label';
      label.textContent = labelOf(page);
      tag.appendChild(label);

      if (page !== HOME) {
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'tag-close';
        close.textContent = '\u00d7';
        close.title = '关闭页签';
        close.setAttribute('aria-label', '关闭「' + labelOf(page) + '」页签');
        tag.appendChild(close);
      }
      scrollEl.appendChild(tag);
    });

    var active = scrollEl.querySelector('.tag.active');
    if (active) revealTag(active);
  }

  /** 把激活页签水平滚进可视区（手动算 scrollLeft，避免 scrollIntoView 带动页面竖滚） */
  function revealTag(el) {
    if (!scrollEl) return;
    var left = el.offsetLeft; // CSS 里 .tags-scroll 是 position:relative，offsetLeft 相对它
    var right = left + el.offsetWidth;
    if (left < scrollEl.scrollLeft) {
      scrollEl.scrollLeft = left;
    } else if (right > scrollEl.scrollLeft + scrollEl.clientWidth) {
      scrollEl.scrollLeft = right - scrollEl.clientWidth;
    }
  }

  /* ── 行为 ─────────────────────────────────── */

  /** 记录一次页面切换（包装器与导航兜底都会调；同页重复调用无副作用） */
  function record(name) {
    var page = normalize(name);
    if (tags.indexOf(page) === -1) tags.push(page);
    current = page;
    persist();
    render();
  }

  /** 切页：正常路径全走 showPage（已是包装器）；实在不可用才手工兜底 */
  function go(page) {
    if (typeof window.showPage === 'function') {
      window.showPage(page);
      return;
    }
    manualSwitch(page);
  }

  /** 仅当 showPage 完全不可用时才用的兜底切换（正常路径永远不会走到） */
  function manualSwitch(page) {
    page = normalize(page);
    document.querySelectorAll('.page').forEach(function (el) {
      el.classList.toggle('active', el.dataset.page === page);
    });
    document.querySelectorAll('.nav-item').forEach(function (el) {
      el.classList.toggle('active', el.dataset.page === page);
    });
    var crumb = document.getElementById('crumb-page');
    if (crumb) crumb.textContent = labelOf(page);
    try { localStorage.setItem(PAGE_KEY, page); } catch (e) { /* 忽略 */ }
    current = page;
  }

  /** 关一个页签：首页拒关；关当前页 → 跳相邻（优先右邻，没有就左邻）；关别的页不动当前 */
  function close(page) {
    page = normalize(page);
    if (page === HOME) return;
    var idx = tags.indexOf(page);
    if (idx === -1) return;
    tags.splice(idx, 1);
    if (page === current) {
      var next = tags[idx] || tags[idx - 1] || HOME;
      persist();
      render();
      go(next);
      return;
    }
    persist();
    render();
  }

  /** 全部关闭：回到只剩首页，并跳回首页 */
  function closeAll() {
    tags = [HOME];
    persist();
    render();
    if (current !== HOME) go(HOME);
  }

  /* ── 右键菜单（vue-next-admin 式：刷新 / 关闭当前 / 关闭其它 / 全部关闭）── */
  var ctxMenu = null;
  function closeCtxMenu() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
  }
  function openCtxMenu(page, x, y) {
    closeCtxMenu();
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'tags-ctx-menu';
    var items = [];
    if (page === current) items.push(['refresh', '刷新']);
    items.push(['maximize', document.body.classList.contains('pref-content-max') ? '退出内容全屏' : '当前页全屏']);
    if (page !== HOME) {
      items.push(['close', '关闭当前']);
      items.push(['others', '关闭其它']);
    }
    items.push(['all', '全部关闭']);
    items.forEach(function (it) {
      var mi = document.createElement('div');
      mi.className = 'tags-ctx-item' + (it[0] === 'all' ? ' danger' : '');
      mi.textContent = it[1];
      mi.addEventListener('click', function () {
        closeCtxMenu();
        if (it[0] === 'refresh') {
          // 重进当前页：各页的 showPage 会重新拉数据
          go(page);
        } else if (it[0] === 'maximize') {
          toggleContentMax();
        } else if (it[0] === 'close') {
          close(page);
        } else if (it[0] === 'others') {
          tags = tags.filter(function (t) { return t === page || t === HOME; });
          if (tags.indexOf(page) === -1) tags.unshift(page);
          persist(); render();
        } else {
          closeAll();
        }
      });
      ctxMenu.appendChild(mi);
    });
    ctxMenu.style.left = Math.min(x, window.innerWidth - 150) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - items.length * 36 - 16) + 'px';
    document.body.appendChild(ctxMenu);
  }
  /** 内容区全屏：藏侧栏 / 顶栏 / 页签栏，Esc 或再触发一次退出 */
  function toggleContentMax() {
    var on = document.body.classList.toggle('pref-content-max');
    try { localStorage.setItem('aibuddy-content-max', on ? '1' : '0'); } catch (e) {}
  }
  (function restoreContentMax() {
    try { if (localStorage.getItem('aibuddy-content-max') === '1') document.body.classList.add('pref-content-max'); } catch (e) {}
  })();
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('pref-content-max')) toggleContentMax();
  });

  function onRootContextmenu(event) {
    var tag = event.target.closest && event.target.closest('.tag');
    if (!tag) return;
    event.preventDefault();
    openCtxMenu(tag.dataset.page, event.clientX, event.clientY);
  }
  document.addEventListener('click', function (e) {
    if (ctxMenu && !ctxMenu.contains(e.target)) closeCtxMenu();
  });
  window.addEventListener('blur', closeCtxMenu);

  /* ── 事件 ─────────────────────────────────── */

  function onRootClick(event) {
    var closeBtn = event.target.closest && event.target.closest('.tag-close');
    if (closeBtn) {
      var owner = closeBtn.closest('.tag');
      if (owner) close(owner.dataset.page);
      return;
    }
    var tag = event.target.closest && event.target.closest('.tag');
    if (tag) go(tag.dataset.page);
  }

  function onRootKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.classList && event.target.classList.contains('tag-close')) return;
    var tag = event.target.closest && event.target.closest('.tag');
    if (tag) {
      event.preventDefault();
      go(tag.dataset.page);
    }
  }

  /* ── 包装 window.showPage ─────────────────── */

  /**
   * 把包装器装到 window.showPage 与 wbApp.showPage 上。
   * app.js 是经典脚本，顶层 function 声明的全局绑定可以用 defineProperty
   * 无缝替换成访问器：app.js 里的裸调用 showPage(...) 与别处读
   * wbApp.showPage（搜索跳转等）从此拿到的都是包装器；对两者直接赋值
   * 也会被 setter 接住，当成新的原函数继续包 —— 谁都绕不出去。
   */
  function installWrapper() {
    if (installed) return true;
    var raw = typeof window.showPage === 'function' ? window.showPage
      : (window.wbApp && typeof window.wbApp.showPage === 'function' ? window.wbApp.showPage : null);
    if (!raw) return false; // app.js 还没跑（正常接线顺序不会发生），交给轮询重试
    rawHolder.fn = raw;

    function wrapped(name) {
      if (typeof name === 'string') record(name); // 先记页签，再调原函数
      if (typeof rawHolder.fn === 'function') return rawHolder.fn.apply(this, arguments);
    }

    try {
      Object.defineProperty(window, 'showPage', {
        configurable: true,
        enumerable: true,
        get: function () { return wrapped; },
        set: function (fn) { if (typeof fn === 'function') rawHolder.fn = fn; },
      });
    } catch (e) {
      window.showPage = wrapped; // 极老引擎退回普通赋值，至少 window 路径生效
    }

    if (window.wbApp) {
      try {
        Object.defineProperty(window.wbApp, 'showPage', {
          configurable: true,
          enumerable: true,
          get: function () { return wrapped; },
          set: function (fn) { if (typeof fn === 'function') rawHolder.fn = fn; },
        });
      } catch (e) {
        try { window.wbApp.showPage = wrapped; } catch (e2) { /* 忽略 */ }
      }
    }
    installed = true;
    return true;
  }

  /** 装包装器；若 app.js 未就绪则短轮询等它（最多约 8 秒） */
  function tryInstall() {
    if (installWrapper()) return;
    var tries = 0;
    var timer = setInterval(function () {
      if (installed || !installWrapper() && ++tries <= 80) return;
      clearInterval(timer);
    }, 100);
  }

  // 兜底：万一哪条路径绕过了包装器（比如别的脚本缓存了原函数引用），
  // 在捕获阶段记下侧栏导航点击。record 幂等，与包装器双触发无副作用。
  document.addEventListener('click', function (event) {
    var item = event.target.closest && event.target.closest('.nav-item[data-page]');
    if (item) record(item.dataset.page);
  }, true);

  /* ── 启动 ─────────────────────────────────── */

  /** 初始页签对齐：启动时的 showPage(…, {persist:false}) 发生在本脚本之前、
   *  包装器捕获不到，这里按「当前激活区块 > app.js 记忆」补记当前页 */
  function syncCurrent() {
    var stored = null;
    try { stored = localStorage.getItem(PAGE_KEY); } catch (e) { /* 忽略 */ }
    var activeEl = document.querySelector('.page.active[data-page]');
    current = normalize((activeEl && activeEl.dataset.page) || stored || HOME);
    if (tags.indexOf(current) === -1) tags.push(current);
    persist();
  }

  function start() {
    if (!buildDom()) {
      // .main 还不在（极端时序）：DOMContentLoaded 再试一次
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
      }
      return;
    }
    syncCurrent();
    render();
    tryInstall();
  }

  // 调试/外部控制出口：wbTagsView.open('settings') 等
  window.wbTagsView = {
    open: function (page) { record(page); go(page); },
    close: close,
    closeAll: closeAll,
    list: function () { return tags.slice(); },
  };

  start();
})();

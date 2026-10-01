/* ─────────────────────────────────────────────
   AIBuddy Panel · 偏好设置系统（照 vue-next-admin 偏好抽屉复刻）
   右侧抽屉 · 三个页签：
     外观  主题三卡（真 SVG 图标）/ 深色侧栏 / 深色顶栏 / 灰色模式 / 色弱模式 /
           12 色主题板（圆点 + 名称）/ 自定义主题色
     布局  布局模式四卡（迷你布局示意图，当前仅「垂直」可用）/ 内容宽度
     通用  动态标题 / 页面切换进度条 / 页面切换动画（无·淡入·滑入）/ 水印
   页脚  复制偏好 / 导入偏好 / 恢复默认
   附带：顶栏快捷按钮（自愈）、Ctrl+K 快速跳页、切页进度条、欢迎横幅、
         canvas 平铺水印、页面切换动画驱动。
   全部持久化在 localStorage（aibuddy-prefs），刷新即生效。
   ───────────────────────────────────────────── */

(function () {
  'use strict';

  /* ── 偏好存取 ─────────────────────────────── */
  var KEY = 'aibuddy-prefs';
  var DEFAULTS = {
    theme: 'system',          // light | dark | system（与应用主题共用一个值）
    darkSidebar: false,
    darkTopbar: false,
    primary: '',              // 空 = 用 tokens.css 默认紫罗兰
    contentWidth: 'fluid',    // fluid | boxed
    dynamicTitle: true,
    progressbar: true,
    layout: 'vertical',       // 布局模式：当前只有 vertical 真实生效
    filter: '',               // 灰色 / 色弱滤镜：'' | gray | weak（互斥）
    watermark: false,         // 平铺水印
    pageAnim: 'none'          // 页面切换动画：none | fade | slide
  };
  function sanitize(p) {
    // 越界值一律拉回合法档位，防止脏数据把界面锁死
    if (['light', 'dark', 'system'].indexOf(p.theme) < 0) p.theme = 'system';
    if (['fluid', 'boxed'].indexOf(p.contentWidth) < 0) p.contentWidth = 'fluid';
    if (p.layout !== 'vertical') p.layout = 'vertical'; // 其余形态尚未支持
    if (['', 'gray', 'weak'].indexOf(p.filter) < 0) p.filter = '';
    if (['none', 'fade', 'slide'].indexOf(p.pageAnim) < 0) p.pageAnim = 'none';
    p.darkSidebar = !!p.darkSidebar;
    p.darkTopbar = !!p.darkTopbar;
    p.dynamicTitle = !!p.dynamicTitle;
    p.progressbar = !!p.progressbar;
    p.watermark = !!p.watermark;
    if (typeof p.primary !== 'string') p.primary = '';
    return p;
  }
  function load() {
    var p;
    try { p = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch (e) { p = Object.assign({}, DEFAULTS); }
    return sanitize(p);
  }
  function save(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {}
  }
  var prefs = load();

  /* ── 12 色内置主题板（圆点 + 名称）────────── */
  var PRIMARY_PRESETS = [
    ['#2563eb', '默认蓝'], ['#7c5cfc', '紫罗兰'], ['#ec4899', '樱花粉'],
    ['#eab308', '柠檬黄'], ['#3b82f6', '天蓝'], ['#10b981', '浅绿'],
    ['#3f3f46', '锌灰'], ['#0d9488', '深绿'], ['#1d4ed8', '深蓝'],
    ['#f97316', '橙黄'], ['#e11d48', '玫红'], ['#27272a', '中性']
  ];

  /* ── 内联 SVG 图标（全站偏好 UI 一律 SVG，不用 emoji）── */
  function svg(path, size, extra) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra ? ' ' + extra : '') + '>' + path + '</svg>';
  }
  var P = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2m0 15v2M4.6 4.6l1.4 1.4m12 12 1.4 1.4M2.5 12h2m15 0h2M4.6 19.4l1.4-1.4m12-12 1.4-1.4"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    /* 跟随系统 = 显示器 + 屏内月牙 */
    sysMoon: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M9 20.5h6M12 16.5v4"/><g transform="translate(11.5 5.3) scale(0.4)"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="currentColor" stroke="none"/></g>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
    chevR: '<path d="m9 5 7 7-7 7"/>'
  };

  /* 迷你布局示意图：灰块 = aside / header / main（内联 SVG，颜色走 currentColor 适配深浅主题） */
  function miniLayout(kind) {
    function r(x, y, w, h, o) {
      return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="1.8" fill="currentColor" opacity="' + o + '"/>';
    }
    function dots(cx, cy) {
      var s = '';
      [0, 4.5, 9].forEach(function (dx) {
        s += '<circle cx="' + (cx + dx) + '" cy="' + cy + '" r="1.5" fill="currentColor" opacity=".6"/>';
      });
      return s;
    }
    var inner = '';
    if (kind === 'vertical') {
      // 左侧通栏 aside，header 只盖在主区上（本面板当前形态）
      inner = r(2, 2, 11, 30, .5) + r(16, 2, 30, 9, .26) + r(16, 14, 30, 18, .12);
    } else if (kind === 'classic') {
      // 通栏 header，下面 aside + main
      inner = r(2, 2, 44, 8, .26) + r(2, 13, 11, 19, .5) + r(16, 13, 30, 19, .12);
    } else if (kind === 'horizontal') {
      // 厚 header（带导航点），无 aside
      inner = r(2, 2, 44, 11, .35) + dots(29, 7.5) + r(2, 16, 44, 16, .12);
    } else if (kind === 'mix') {
      // 通栏 header（带导航点），下面窄 aside + main
      inner = r(2, 2, 44, 8, .26) + dots(33, 6) + r(2, 13, 9, 19, .5) + r(14, 13, 32, 19, .12);
    }
    return '<svg class="pref-mini" viewBox="0 0 48 34" aria-hidden="true">' + inner + '</svg>';
  }
  /* 内容宽度迷你图 */
  function miniWidth(kind) {
    var rect = kind === 'fluid'
      ? '<rect x="2" y="9" width="44" height="16" rx="1.8" fill="currentColor" opacity=".3"/>'
      : '<rect x="11" y="9" width="26" height="16" rx="1.8" fill="currentColor" opacity=".3"/>';
    return '<svg class="pref-mini" viewBox="0 0 48 34" aria-hidden="true">' + rect + '</svg>';
  }

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  /* ── 应用偏好到文档 ───────────────────────── */
  var syncThemeBtnRef = function () {};
  function apply() {
    var root = document.documentElement;
    root.setAttribute('data-theme', prefs.theme);
    root.setAttribute('data-pref-sidebar', prefs.darkSidebar ? 'dark' : 'light');
    root.setAttribute('data-pref-topbar', prefs.darkTopbar ? 'dark' : 'light');
    root.setAttribute('data-pref-width', prefs.contentWidth);
    root.setAttribute('data-pref-layout', prefs.layout);
    root.setAttribute('data-pref-filter', prefs.filter || '');
    root.setAttribute('data-pref-anim', prefs.pageAnim || 'none');
    if (prefs.primary) {
      var c = prefs.primary;
      root.style.setProperty('--primary', c);
      root.style.setProperty('--ui-primary', c);
      // 派生色全部用 color-mix 跟随：明暗两套主题下 hover / 柔和底 / 描边 / 前景都成立
      root.style.setProperty('--primary-hover', 'color-mix(in srgb, ' + c + ' 86%, var(--text))');
      root.style.setProperty('--ui-primary-hover', 'color-mix(in srgb, ' + c + ' 86%, var(--text))');
      root.style.setProperty('--primary-soft', 'color-mix(in srgb, ' + c + ' 14%, transparent)');
      root.style.setProperty('--primary-bd', 'color-mix(in srgb, ' + c + ' 38%, transparent)');
      root.style.setProperty('--primary-fg', 'color-mix(in srgb, ' + c + ' 70%, var(--text))');
    } else {
      ['--primary', '--ui-primary', '--primary-hover', '--ui-primary-hover',
        '--primary-soft', '--primary-bd', '--primary-fg'].forEach(function (v) {
          root.style.removeProperty(v);
        });
    }
    // 动态标题：页面名写进 document.title
    if (window.__aibuddyTitleBase) {
      document.title = prefs.dynamicTitle
        ? (window.__aibuddyTitleBase.currentPage
          ? window.__aibuddyTitleBase.currentPage + ' · ' + window.__aibuddyTitleBase.brand
          : window.__aibuddyTitleBase.brand)
        : window.__aibuddyTitleBase.brand;
    }
    applyWatermark();
    try { syncThemeBtnRef(); } catch (e) {}
    document.dispatchEvent(new CustomEvent('aibuddy-prefs-changed', { detail: prefs }));
  }

  /* ── 平铺水印：canvas 生成半透明文字瓦片，fixed 全屏不挡交互 ── */
  function applyWatermark() {
    var old = document.getElementById('pref-watermark');
    if (!prefs.watermark) { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
    var brand = 'AIBuddy Panel';
    var h1 = document.querySelector('.brand-text h1');
    if (h1 && h1.textContent.trim()) brand = h1.textContent.trim();
    var d = new Date();
    var ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    var text = brand + ' · ' + ds;
    var w = 280, h = 170;
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-20 * Math.PI / 180);
    ctx.font = '13px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(127,127,127,0.18)'; // 中性灰：浅色 / 深色主题下都低调可见
    ctx.fillText(text, 0, 0);
    var url = canvas.toDataURL('image/png');
    var node = old || el('div');
    node.id = 'pref-watermark';
    node.setAttribute('aria-hidden', 'true');
    node.style.backgroundImage = 'url(' + url + ')';
    if (!old) document.body.appendChild(node);
  }

  /* ── 顶栏快捷按钮（独立容器 + MutationObserver 自愈）── */
  function ensureTopbarButtons() {
    // 不插进 #topbar-status（app.js 的 renderTopbarStatus 会整体重写它，按钮会被冲掉），
    // 用独立容器插在它前面；再挂 MutationObserver 兜底自愈
    var bar = document.getElementById('topbar-status');
    if (!bar || document.getElementById('pref-btn-prefs')) return;
    var holder = document.getElementById('pref-buttons');
    var fresh = false;
    if (!holder) {
      holder = el('div');
      holder.id = 'pref-buttons';
      holder.style.cssText = 'display:flex;align-items:center;gap:7px';
      fresh = true;
    }
    var mk = function (id, cls, title, html) {
      var b = el('button', cls);
      b.id = id; b.type = 'button'; b.title = title; b.innerHTML = html;
      return b;
    };
    var btnTheme = mk('pref-btn-theme', 'tb-icon-btn', '', svg(P.moon, 15));
    btnTheme.addEventListener('click', function () {
      var order = ['light', 'dark', 'system'];
      var next = order[(order.indexOf(prefs.theme) + 1) % 3];
      prefs.theme = next; save(prefs); apply(); syncThemeBtn();
      toast('主题：' + (next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统'));
    });
    var btnSearch = mk('pref-btn-search', 'tb-icon-btn', '搜索页面（Ctrl+K）', svg(P.search, 15));
    btnSearch.addEventListener('click', openSearchDialog);
    var btnPrefs = mk('pref-btn-prefs', 'tb-icon-btn', '偏好设置', svg(P.gear, 15));
    btnPrefs.addEventListener('click', openDrawer);
    var burger = mk('pref-hamburger', 'tb-icon-btn pref-hamburger', '打开 / 收起菜单', svg(P.menu, 15));
    burger.addEventListener('click', function () {
      document.body.classList.toggle('pref-mobile-open');
    });
    if (fresh) {
      // 手机端选中菜单后自动收起抽屉；点侧栏外的暗色遮罩（body 的 ::after，
      // 点击会落在 body 上）也收起
      document.addEventListener('click', function (e) {
        if (!document.body.classList.contains('pref-mobile-open')) return;
        var item = e.target.closest && e.target.closest('.nav-item[data-page]');
        if (item || e.target === document.body) {
          document.body.classList.remove('pref-mobile-open');
        }
      });
    }
    holder.textContent = '';
    holder.appendChild(burger);
    holder.appendChild(btnSearch);
    holder.appendChild(btnTheme);
    holder.appendChild(btnPrefs);
    bar.parentNode.insertBefore(holder, bar);
    // 自愈：状态徽标重写把容器冲掉时重新插回（每次都重新找 #topbar-status，
    // 防止 app.js 把状态条节点整个换掉后旧引用失效）
    if (!ensureTopbarButtons._mo) {
      ensureTopbarButtons._mo = new MutationObserver(function () {
        if (document.getElementById('pref-btn-prefs')) return;
        var b2 = document.getElementById('topbar-status');
        var h2 = document.getElementById('pref-buttons');
        if (b2 && h2 && b2.parentNode) b2.parentNode.insertBefore(h2, b2);
        else if (h2 && h2.parentNode) h2.parentNode.removeChild(h2); // 顶栏没了就别硬塞
      });
      ensureTopbarButtons._mo.observe(document.body, { childList: true, subtree: true });
    }
    function syncThemeBtn() {
      btnTheme.innerHTML = prefs.theme === 'dark' ? svg(P.sun, 15) : svg(P.moon, 15);
      btnTheme.title = '当前：' + (prefs.theme === 'light' ? '浅色' : prefs.theme === 'dark' ? '深色' : '跟随系统') + '（点击切换）';
    }
    syncThemeBtn();
    syncThemeBtnRef = syncThemeBtn; // 抽屉里切主题时同步顶栏图标
  }

  function toast(msg, type) {
    var host = document.querySelector('.content-inner') || document.body;
    var t = el('div', 'pref-toast' + (type === 'err' ? ' err' : ''));
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2200);
  }

  /* ── Ctrl+K 快速跳页（键盘上下选择 / 回车跳转 / Esc 关闭）── */
  var PAGES = [
    ['overview', '报表'], ['accounts', '账号'], ['gateway', '模型管理'],
    ['proxies', '网络代理'], ['keys', '网关 Key'], ['docs', '文档'],
    ['requests', '请求日志'], ['logs', '日志'], ['tasks', '定时任务'], ['settings', '设置']
  ];
  function openSearchDialog() {
    if (document.getElementById('pref-search-mask')) return;
    var mask = el('div', 'pref-mask');
    mask.id = 'pref-search-mask';
    var box = el('div', 'pref-search-box');
    box.innerHTML =
      '<div class="pref-search-head">' + svg(P.search, 15) +
      '<input id="pref-search-input" placeholder="搜索页面，回车跳转…" autocomplete="off" spellcheck="false">' +
      '<kbd class="pref-search-kbd">Ctrl K</kbd></div>' +
      '<div class="pref-search-list"></div>' +
      '<div class="pref-search-foot"><span><kbd class="pref-search-kbd">上下键</kbd> 选择</span><span><kbd class="pref-search-kbd">回车</kbd> 跳转</span><span><kbd class="pref-search-kbd">Esc</kbd> 关闭</span></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    var input = box.querySelector('input');
    var list = box.querySelector('.pref-search-list');
    var items = [];
    var sel = 0;
    function paint() {
      items.forEach(function (it, i) { it.el.classList.toggle('sel', i === sel); });
    }
    function render(q) {
      q = (q || '').trim().toLowerCase();
      list.innerHTML = '';
      items = PAGES.filter(function (p) {
        return !q || p[1].toLowerCase().indexOf(q) >= 0 || p[0].indexOf(q) >= 0;
      }).map(function (p) {
        var item = el('div', 'pref-search-item');
        item.innerHTML = '<span>' + p[1] + '</span><span class="pref-search-key">' + p[0] + '</span>';
        item.addEventListener('click', function () { go(p[0]); });
        list.appendChild(item);
        return { el: item, page: p[0] };
      });
      sel = 0;
      if (!items.length) list.innerHTML = '<div class="pref-search-item muted">没有匹配的页面</div>';
      paint();
    }
    function go(page) {
      close(); localStorage.setItem('workbuddy-desktop-page', page);
      var fn = (window.wbApp && window.wbApp.showPage) || window.showPage;
      if (typeof fn === 'function') fn(page);
    }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); sel = (sel + 1) % items.length; paint(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) items[sel].el.click(); }
    }
    input.addEventListener('input', function () { render(input.value); });
    document.addEventListener('keydown', onKey, true);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    render('');
    input.focus();
  }
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); openSearchDialog();
    }
  });

  /* ── 偏好设置抽屉 ─────────────────────────── */
  function openDrawer() {
    if (document.getElementById('pref-drawer-mask')) return;
    prefs = load();
    var mask = el('div', 'pref-mask');
    mask.id = 'pref-drawer-mask';
    var drawer = el('div', 'pref-drawer');
    drawer.innerHTML =
      '<div class="pref-head"><div class="pref-head-t"><b>偏好设置</b><span class="pref-sub">自定义界面 · 实时生效</span></div>' +
      '<button class="pref-close" type="button" title="关闭">' + svg(P.x, 13) + '</button></div>' +
      '<div class="pref-tabs">' +
      '<button type="button" data-tab="look" class="on">外观</button>' +
      '<button type="button" data-tab="layout">布局</button>' +
      '<button type="button" data-tab="general">通用</button>' +
      '</div>' +
      '<div class="pref-body"></div>' +
      '<div class="pref-foot">' +
      '<button type="button" class="pref-act primary" id="pref-copy">复制偏好</button>' +
      '<button type="button" class="pref-act" id="pref-paste">导入偏好</button>' +
      '<button type="button" class="pref-act danger" id="pref-reset">恢复默认</button>' +
      '</div>';
    mask.appendChild(drawer);
    document.body.appendChild(mask);
    var body = drawer.querySelector('.pref-body');
    var tabs = drawer.querySelectorAll('.pref-tabs button');
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        tabs.forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        renderTab(t.dataset.tab);
      });
    });
    function close() {
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey, true);
    drawer.querySelector('.pref-close').addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

    /* 组装小件 */
    function row(label, control, hint) {
      var d = el('div', 'pref-row');
      var main = el('div', 'pref-row-main');
      var lab = el('div', 'pref-row-label');
      lab.textContent = label;
      main.appendChild(lab);
      if (hint) {
        var h = el('div', 'pref-row-hint');
        h.textContent = hint;
        main.appendChild(h);
      }
      d.appendChild(main);
      var ctl = el('div', 'pref-row-ctl');
      ctl.appendChild(control);
      d.appendChild(ctl);
      return d;
    }
    function toggle(get, set) {
      var b = el('button', 'pref-switch' + (get() ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-checked', get() ? 'true' : 'false');
      b.addEventListener('click', function () {
        set(!get());
        b.classList.toggle('on', get());
        b.setAttribute('aria-checked', get() ? 'true' : 'false');
      });
      return b;
    }
    function section(title) {
      var h = el('div', 'pref-section');
      h.textContent = title;
      return h;
    }
    function hint(text) {
      var h = el('div', 'pref-row-hint');
      h.textContent = text;
      return h;
    }

    function renderTab(tabName) {
      body.innerHTML = '';
      body.scrollTop = 0;
      if (tabName === 'look') {
        body.appendChild(section('主题'));
        var cards = el('div', 'pref-theme-cards');
        [['light', '浅色', P.sun], ['dark', '深色', P.moon], ['system', '跟随系统', P.sysMoon]]
          .forEach(function (t) {
            var c = el('button', 'pref-theme-card' + (prefs.theme === t[0] ? ' on' : ''));
            c.type = 'button';
            c.innerHTML = '<span class="ico">' + svg(t[2], 22) + '</span><span>' + t[1] + '</span>';
            c.addEventListener('click', function () {
              prefs.theme = t[0]; save(prefs); apply();
              cards.querySelectorAll('.pref-theme-card').forEach(function (x) { x.classList.remove('on'); });
              c.classList.add('on');
              toast('主题：' + t[1]);
            });
            cards.appendChild(c);
          });
        body.appendChild(cards);
        body.appendChild(row('深色侧边栏', toggle(function () { return prefs.darkSidebar; },
          function (v) { prefs.darkSidebar = v; save(prefs); apply(); }), '仅把侧边栏换成深色，内容区跟随当前主题'));
        body.appendChild(row('深色顶栏', toggle(function () { return prefs.darkTopbar; },
          function (v) { prefs.darkTopbar = v; save(prefs); apply(); }), '仅把顶栏换成深色，内容区跟随当前主题'));
        // 灰色 / 色弱两个滤镜互斥：开一个自动关另一个
        var swGray = toggle(function () { return prefs.filter === 'gray'; },
          function (v) { prefs.filter = v ? 'gray' : ''; save(prefs); apply(); });
        var swWeak = toggle(function () { return prefs.filter === 'weak'; },
          function (v) { prefs.filter = v ? 'weak' : ''; save(prefs); apply(); });
        swGray.addEventListener('click', function () {
          if (prefs.filter === 'gray') { swWeak.classList.remove('on'); swWeak.setAttribute('aria-checked', 'false'); }
        });
        swWeak.addEventListener('click', function () {
          if (prefs.filter === 'weak') { swGray.classList.remove('on'); swGray.setAttribute('aria-checked', 'false'); }
        });
        body.appendChild(row('灰色模式', swGray, '页面整体去色，只保留明暗层级（适合打印 / 专注场景）'));
        body.appendChild(row('色弱模式', swWeak, '反转明度并回旋色相，提升颜色之间的辨识度'));
        body.appendChild(section('内置主题色'));
        var sw = el('div', 'pref-palette');
        PRIMARY_PRESETS.forEach(function (p) {
          var b = el('button', 'pref-palette-item' + (prefs.primary && prefs.primary.toLowerCase() === p[0] ? ' on' : ''));
          b.type = 'button';
          b.title = p[0];
          b.style.setProperty('--sw', p[0]);
          b.innerHTML = '<span class="dot" style="background:' + p[0] + '"></span><span class="name">' + p[1] + '</span>';
          b.addEventListener('click', function () {
            prefs.primary = p[0]; save(prefs); apply();
            sw.querySelectorAll('.pref-palette-item').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            hexEl.textContent = p[0];
            colorInput.value = p[0];
          });
          sw.appendChild(b);
        });
        body.appendChild(sw);
        var custom = el('div', 'pref-custom');
        var labC = el('span'); labC.textContent = '自定义';
        var colorInput = el('input');
        colorInput.type = 'color';
        colorInput.value = prefs.primary || '#7c5cfc';
        var hexEl = el('span', 'hex mono');
        hexEl.textContent = prefs.primary || '跟随默认';
        colorInput.addEventListener('input', function () {
          prefs.primary = colorInput.value; save(prefs); apply();
          hexEl.textContent = colorInput.value;
          sw.querySelectorAll('.pref-palette-item').forEach(function (x) { x.classList.remove('on'); });
        });
        var resetC = el('button', 'pref-act');
        resetC.type = 'button';
        resetC.textContent = '恢复默认';
        resetC.addEventListener('click', function () {
          prefs.primary = ''; save(prefs); apply();
          colorInput.value = '#7c5cfc';
          hexEl.textContent = '跟随默认';
          sw.querySelectorAll('.pref-palette-item').forEach(function (x) { x.classList.remove('on'); });
        });
        custom.appendChild(labC);
        custom.appendChild(colorInput);
        custom.appendChild(hexEl);
        custom.appendChild(resetC);
        body.appendChild(custom);
      }
      if (tabName === 'layout') {
        body.appendChild(section('布局模式'));
        var lc = el('div', 'pref-layout-cards');
        [['vertical', '垂直'], ['classic', '经典'], ['mix', '混合'], ['horizontal', '水平']]
          .forEach(function (it) {
            var c = el('button', 'pref-layout-card' + (prefs.layout === it[0] ? ' on' : ''));
            c.type = 'button';
            c.innerHTML = miniLayout(it[0]) + '<span>' + it[1] + '</span>';
            c.addEventListener('click', function () {
              if (it[0] !== 'vertical') { toast('该布局形态即将支持'); return; }
              prefs.layout = 'vertical'; save(prefs); apply();
              lc.querySelectorAll('.pref-layout-card').forEach(function (x) { x.classList.remove('on'); });
              c.classList.add('on');
            });
            lc.appendChild(c);
          });
        body.appendChild(lc);
        body.appendChild(hint('当前版本提供「垂直」布局；经典 / 混合 / 水平正在适配中。'));
        body.appendChild(section('内容宽度'));
        var wc = el('div', 'pref-theme-cards');
        [['fluid', '流式', '跟随窗口宽度，两侧留白约一成'], ['boxed', '定宽', '内容收在 1200px 版心里，宽屏更易读']]
          .forEach(function (w) {
            var c = el('button', 'pref-theme-card' + (prefs.contentWidth === w[0] ? ' on' : ''));
            c.type = 'button';
            c.innerHTML = '<span class="ico">' + miniWidth(w[0]) + '</span><span>' + w[1] + '</span>';
            c.title = w[2];
            c.addEventListener('click', function () {
              prefs.contentWidth = w[0]; save(prefs); apply();
              wc.querySelectorAll('.pref-theme-card').forEach(function (x) { x.classList.remove('on'); });
              c.classList.add('on');
            });
            wc.appendChild(c);
          });
        body.appendChild(wc);
        body.appendChild(hint('两种宽度都实时预览，右上角齿轮里随时切换。'));
      }
      if (tabName === 'general') {
        body.appendChild(section('浏览体验'));
        body.appendChild(row('动态标题', toggle(function () { return prefs.dynamicTitle; },
          function (v) { prefs.dynamicTitle = v; save(prefs); apply(); }),
          '把当前页面名写进标签页标题（如「报表 · AIBuddy Panel」）'));
        body.appendChild(row('页面切换进度条', toggle(function () { return prefs.progressbar; },
          function (v) { prefs.progressbar = v; save(prefs); apply(); }), '切换页面时顶部显示细进度条'));
        body.appendChild(section('页面切换动画'));
        var seg = el('div', 'pref-seg');
        [['none', '无'], ['fade', '淡入'], ['slide', '滑入']].forEach(function (o) {
          var b = el('button', (prefs.pageAnim || 'none') === o[0] ? 'on' : '');
          b.type = 'button';
          b.textContent = o[1];
          b.addEventListener('click', function () {
            prefs.pageAnim = o[0]; save(prefs); apply();
            seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
          });
          seg.appendChild(b);
        });
        body.appendChild(seg);
        body.appendChild(hint('切换页面时的过场效果；系统开启「减少动态效果」时自动禁用。'));
        body.appendChild(section('其他'));
        body.appendChild(row('水印', toggle(function () { return prefs.watermark; },
          function (v) { prefs.watermark = v; save(prefs); apply(); }),
          '在页面最上层平铺品牌名与当前日期，适用于录屏与演示场景'));
      }
    }
    renderTab('look');

    drawer.querySelector('#pref-copy').addEventListener('click', function () {
      var text = JSON.stringify(prefs, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('偏好已复制到剪贴板'); }, function () { fallbackCopy(text); });
      else fallbackCopy(text);
    });
    drawer.querySelector('#pref-paste').addEventListener('click', function () {
      if (!(navigator.clipboard && navigator.clipboard.readText)) { toast('此浏览器不支持读取剪贴板', 'err'); return; }
      navigator.clipboard.readText().then(function (text) {
        try {
          var imported = JSON.parse(text);
          prefs = sanitize(Object.assign({}, DEFAULTS, imported));
          save(prefs); apply();
          var on = drawer.querySelector('.pref-tabs button.on');
          if (on) renderTab(on.dataset.tab);
          toast('偏好已导入并应用');
        } catch (e) { toast('剪贴板内容不是有效的偏好 JSON', 'err'); }
      }).catch(function () { toast('读取剪贴板失败', 'err'); });
    });
    drawer.querySelector('#pref-reset').addEventListener('click', function () {
      prefs = Object.assign({}, DEFAULTS);
      try { localStorage.removeItem(KEY); } catch (e) {}
      save(prefs); apply();
      var on = drawer.querySelector('.pref-tabs button.on');
      if (on) renderTab(on.dataset.tab);
      toast('已恢复默认偏好');
    });
    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('偏好已复制'); } catch (e) { toast('复制失败', 'err'); }
      ta.remove();
    }
  }

  /* ── 页面切换进度条 ───────────────────────── */
  var progress = null;
  document.addEventListener('click', function (e) {
    var item = e.target.closest && e.target.closest('.nav-item[data-page]');
    if (!item || !load().progressbar) return;
    if (!progress) {
      progress = el('div', 'pref-progress');
      document.body.appendChild(progress);
    }
    progress.classList.remove('done');
    progress.style.width = '30%';
    setTimeout(function () { progress.style.width = '82%'; }, 80);
    setTimeout(function () { progress.classList.add('done'); progress.style.width = '100%'; setTimeout(function () { progress.style.width = '0'; }, 260); }, 300);
  });

  /* ── 欢迎横幅（报表页顶部，步骤条用 SVG / 数字徽标，不用 emoji）── */
  function ensureBanner() {
    var page = document.querySelector('.page[data-page="overview"]');
    if (!page || page.querySelector('.aibuddy-banner') || page.children.length === 0) return;
    var now = new Date();
    var hour = now.getHours();
    var hello = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    function step(n, label) {
      return '<span class="ab-chip"><i class="ab-num">' + n + '</i><span>' + label + '</span></span>';
    }
    var banner = el('div', 'aibuddy-banner');
    banner.innerHTML =
      '<div class="ab-icon"><svg viewBox="0 0 24 24" width="26" height="26"><rect width="24" height="24" rx="5.4" class="mark"/><g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.23 9.24h10.71"/><path d="M15.94 6.72 18.77 9.24 15.94 11.76"/><path d="M18.77 14.76H8.06"/><path d="M8.06 12.24 5.23 14.76 8.06 17.28"/></g></svg></div>' +
      '<div class="ab-main"><div class="ab-hello">' + hello + '，欢迎回来</div>' +
      '<div class="ab-date">' + now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '</div></div>' +
      '<div class="ab-steps">' +
      '<span class="ab-chip ok">' + svg(P.check, 12) + '<span>网关运行中</span></span>' +
      step('1', '添加账号') + '<span class="ab-arrow">' + svg(P.chevR, 12) + '</span>' +
      step('2', '创建网关 Key') + '<span class="ab-arrow">' + svg(P.chevR, 12) + '</span>' +
      step('3', '客户端接入 /v1') +
      '</div>';
    page.insertBefore(banner, page.firstChild);
  }
  var bannerTimer = setInterval(function () {
    if (document.querySelector('.page[data-page="overview"].active')) ensureBanner();
  }, 1200);
  setTimeout(function () { clearInterval(bannerTimer); }, 30000);

  /* ── 启动 ─────────────────────────────────── */
  function boot() {
    // 品牌名与页面名给动态标题 / 水印用
    var brandEl = document.querySelector('.brand-text h1');
    window.__aibuddyTitleBase = {
      brand: (brandEl ? brandEl.textContent.trim() : 'AIBuddy Panel') || 'AIBuddy Panel',
      currentPage: ''
    };
    // 侧栏品牌区换用新 Logo（assets/brand 的图标）
    var logoBox = document.querySelector('.brand-logo');
    if (logoBox && !logoBox.querySelector('img')) {
      logoBox.textContent = '';
      var img = document.createElement('img');
      img.src = 'brand/logo-icon-64.png';
      img.alt = 'logo';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block';
      logoBox.appendChild(img);
    }
    // 品牌区版本号：读后端真实版本（未登录/失败就不显示，不留假值）
    var brandText = document.querySelector('.brand-text');
    if (brandText && !brandText.querySelector('.brand-version')) {
      var ver = document.createElement('div');
      ver.className = 'brand-version';
      brandText.appendChild(ver);
      fetch('/api/update/status').then(function (r) { return r.ok ? r.json() : null; }).then(function (env) {
        var v = env && env.data && env.data.currentVersion;
        if (v && v !== 'web' && ver.parentNode) ver.textContent = 'v' + v;
        else if (ver.parentNode) ver.remove();
      }).catch(function () { if (ver.parentNode) ver.remove(); });
    }
    // 动态标题随切页更新
    document.addEventListener('click', function (e) {
      var item = e.target.closest && e.target.closest('.nav-item[data-page]');
      if (!item) return;
      var label = item.querySelector('.label');
      window.__aibuddyTitleBase.currentPage = label ? label.textContent : '';
      var p = load();
      if (p.dynamicTitle && window.__aibuddyTitleBase) {
        document.title = window.__aibuddyTitleBase.currentPage
          ? window.__aibuddyTitleBase.currentPage + ' · ' + window.__aibuddyTitleBase.brand
          : window.__aibuddyTitleBase.brand;
      }
    });
    apply();
    ensureTopbarButtons();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

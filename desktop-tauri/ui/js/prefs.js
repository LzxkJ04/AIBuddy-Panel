/* ─────────────────────────────────────────────
   AIBuddy Panel · 偏好设置系统
   照参考站（Certd）样式功能实现：右侧抽屉，四个页签
   外观（主题三卡 / 深色侧栏 / 深色顶栏 / 12 色主题板 + 自定义色）
   布局（内容 流式 / 定宽）
   通用（动态标题 / 页面切换进度条）
   页脚（复制偏好 / 从剪贴板导入 / 恢复默认）
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
    progressbar: true
  };
  function load() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function save(prefs) {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {}
  }
  var prefs = load();

  /* ── 应用偏好到文档 ───────────────────────── */
  var PRIMARY_PRESETS = [
    ['#2563eb', '默认蓝'], ['#8b5cf6', '紫罗兰'], ['#ec4899', '樱花粉'],
    ['#eab308', '柠檬黄'], ['#3b82f6', '天蓝色'], ['#10b981', '浅绿色'],
    ['#3f3f46', '锌色灰'], ['#0d9488', '深绿色'], ['#1d4ed8', '深蓝色'],
    ['#f97316', '橙黄色'], ['#e11d48', '玫瑰红'], ['#27272a', '中性色']
  ];

  function hexToOklchFallback(hex) {
    // 简单路径：直接把 hex 写进 --primary 的 color-mix 友好格式
    // tokens.css 的变量消费方都接受任意 CSS 颜色，这里用 color() 前的 sRGB 直填
    return hex;
  }

  function apply() {
    var root = document.documentElement;
    root.setAttribute('data-theme', prefs.theme);
    root.setAttribute('data-pref-sidebar', prefs.darkSidebar ? 'dark' : 'light');
    root.setAttribute('data-pref-topbar', prefs.darkTopbar ? 'dark' : 'light');
    root.setAttribute('data-pref-width', prefs.contentWidth);
    if (prefs.primary) {
      root.style.setProperty('--primary', prefs.primary);
      root.style.setProperty('--ui-primary', prefs.primary);
      root.style.setProperty('--primary-hover', prefs.primary);
      root.style.setProperty('--ui-primary-hover', prefs.primary);
      // 派生的柔和色用 color-mix 自动跟随
      root.style.setProperty('--primary-soft', 'color-mix(in srgb, ' + prefs.primary + ' 10%, white)');
      root.style.setProperty('--primary-bd', 'color-mix(in srgb, ' + prefs.primary + ' 28%, white)');
    } else {
      root.style.removeProperty('--primary');
      root.style.removeProperty('--ui-primary');
      root.style.removeProperty('--primary-hover');
      root.style.removeProperty('--ui-primary-hover');
      root.style.removeProperty('--primary-soft');
      root.style.removeProperty('--primary-bd');
    }
    // 动态标题：页面名写进 document.title
    if (window.__aibuddyTitleBase) {
      document.title = prefs.dynamicTitle
        ? window.__aibuddyTitleBase.currentPage + ' · ' + window.__aibuddyTitleBase.brand
        : window.__aibuddyTitleBase.brand;
    }
    document.dispatchEvent(new CustomEvent('aibuddy-prefs-changed', { detail: prefs }));
  }

  /* ── 顶栏快捷按钮 ─────────────────────────── */
  function ensureTopbarButtons() {
    var bar = document.getElementById('topbar-status');
    if (!bar || document.getElementById('pref-btn-prefs')) return;
    var mk = function (id, cls, title, html) {
      var b = document.createElement('button');
      b.id = id; b.className = cls; b.title = title; b.innerHTML = html;
      return b;
    };
    var svgMoon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    var svgSun = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    var btnTheme = mk('pref-btn-theme', 'tb-icon-btn', '切换主题（浅色 / 深色 / 跟随系统）', svgMoon);
    btnTheme.addEventListener('click', function () {
      var order = ['light', 'dark', 'system'];
      var next = order[(order.indexOf(prefs.theme) + 1) % 3];
      prefs.theme = next; save(prefs); apply(); syncThemeBtn();
      toast('主题：' + (next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统'));
    });
    var btnSearch = mk('pref-btn-search', 'tb-icon-btn', '搜索页面（Ctrl+K）',
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>');
    btnSearch.addEventListener('click', openSearchDialog);
    var btnPrefs = mk('pref-btn-prefs', 'tb-icon-btn', '偏好设置',
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>');
    btnPrefs.addEventListener('click', openDrawer);
    var burger = mk('pref-hamburger', 'tb-icon-btn pref-hamburger', '打开 / 收起菜单',
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>');
    burger.addEventListener('click', function () {
      document.body.classList.toggle('pref-mobile-open');
    });
    bar.insertBefore(burger, bar.firstChild);
    // 手机端选中菜单后自动收起抽屉
    document.addEventListener('click', function (e) {
      var item = e.target.closest && e.target.closest('.nav-item[data-page]');
      if (item && document.body.classList.contains('pref-mobile-open')) {
        document.body.classList.remove('pref-mobile-open');
      }
    });
    bar.insertBefore(btnSearch, bar.firstChild);
    bar.insertBefore(btnTheme, bar.firstChild);
    bar.insertBefore(btnPrefs, bar.firstChild);
    syncThemeBtn();
    function syncThemeBtn() {
      btnTheme.innerHTML = prefs.theme === 'dark' ? svgSun : svgMoon;
      btnTheme.title = '当前：' + (prefs.theme === 'light' ? '浅色' : prefs.theme === 'dark' ? '深色' : '跟随系统') + '（点击切换）';
    }
  }

  function toast(msg) {
    var host = document.querySelector('.content-inner') || document.body;
    var t = document.createElement('div');
    t.className = 'pref-toast'; t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2200);
  }

  /* ── Ctrl+K 快速跳页 ──────────────────────── */
  var PAGES = [
    ['overview', '报表'], ['accounts', '账号'], ['gateway', '模型管理'],
    ['proxies', '网络代理'], ['keys', '网关 Key'], ['docs', '文档'],
    ['requests', '请求日志'], ['logs', '日志'], ['tasks', '定时任务'], ['settings', '设置']
  ];
  function openSearchDialog() {
    if (document.getElementById('pref-search-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'pref-search-mask'; mask.className = 'pref-mask';
    var box = document.createElement('div');
    box.className = 'pref-search-box';
    box.innerHTML = '<input id="pref-search-input" placeholder="输入页面名，回车跳转…" autocomplete="off"><div class="pref-search-list"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    var input = box.querySelector('input');
    var list = box.querySelector('.pref-search-list');
    function render(q) {
      q = (q || '').trim().toLowerCase();
      list.innerHTML = '';
      PAGES.filter(function (p) { return !q || p[1].toLowerCase().indexOf(q) >= 0 || p[0].indexOf(q) >= 0; })
        .forEach(function (p) {
          var item = document.createElement('div');
          item.className = 'pref-search-item'; item.textContent = p[1];
          item.addEventListener('click', function () { go(p[0]); });
          list.appendChild(item);
        });
      if (!list.children.length) list.innerHTML = '<div class="pref-search-item muted">没有匹配的页面</div>';
    }
    function go(page) {
      close(); localStorage.setItem('workbuddy-desktop-page', page);
      var fn = (window.wbApp && window.wbApp.showPage) || window.showPage;
      if (typeof fn === 'function') fn(page);
    }
    function close() { mask.remove(); }
    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var first = list.querySelector('.pref-search-item'); if (first) first.click(); }
      if (e.key === 'Escape') close();
    });
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
    var mask = document.createElement('div');
    mask.id = 'pref-drawer-mask'; mask.className = 'pref-mask';
    var drawer = document.createElement('div');
    drawer.className = 'pref-drawer';
    drawer.innerHTML =
      '<div class="pref-head"><div><b>偏好设置</b><span class="pref-sub">自定义偏好 · 实时预览</span></div><button class="pref-close" title="关闭">✕</button></div>' +
      '<div class="pref-tabs"><button data-tab="look" class="on">外观</button><button data-tab="layout">布局</button><button data-tab="general">通用</button></div>' +
      '<div class="pref-body"></div>' +
      '<div class="pref-foot">' +
      '<button class="pref-act primary" id="pref-copy">复制偏好设置</button>' +
      '<button class="pref-act" id="pref-paste">从剪贴板导入</button>' +
      '<button class="pref-act danger" id="pref-reset">恢复默认并清空缓存</button>' +
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
    drawer.querySelector('.pref-close').addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    function close() { mask.remove(); }

    function row(label, control, hint) {
      var d = document.createElement('div');
      d.className = 'pref-row';
      d.innerHTML = '<div class="pref-row-label">' + label + '</div>';
      d.appendChild(control);
      if (hint) { var h = document.createElement('div'); h.className = 'pref-row-hint'; h.textContent = hint; d.appendChild(h); }
      return d;
    }
    function toggle(get, set) {
      var b = document.createElement('button');
      b.className = 'pref-switch' + (get() ? ' on' : '');
      b.addEventListener('click', function () { set(!get()); b.classList.toggle('on', get()); });
      return b;
    }
    function section(title) {
      var h = document.createElement('div');
      h.className = 'pref-section'; h.textContent = title;
      return h;
    }

    function renderTab(tabName) {
      body.innerHTML = '';
      if (tabName === 'look') {
        body.appendChild(section('主题'));
        var themes = [['light', '浅色', '☀'], ['dark', '深色', '🌙'], ['system', '跟随系统', '🖮']];
        var cards = document.createElement('div');
        cards.className = 'pref-theme-cards';
        themes.forEach(function (t) {
          var c = document.createElement('button');
          c.className = 'pref-theme-card' + (prefs.theme === t[0] ? ' on' : '');
          c.innerHTML = '<span class="ico">' + t[2] + '</span><span>' + t[1] + '</span>';
          c.addEventListener('click', function () {
            prefs.theme = t[0]; save(prefs); apply();
            cards.querySelectorAll('.pref-theme-card').forEach(function (x) { x.classList.remove('on'); });
            c.classList.add('on');
          });
          cards.appendChild(c);
        });
        body.appendChild(cards);
        body.appendChild(row('深色侧边栏', toggle(function () { return prefs.darkSidebar; }, function (v) { prefs.darkSidebar = v; save(prefs); apply(); }), '仅把侧栏换成深色，内容区跟随主题'));
        body.appendChild(row('深色顶栏', toggle(function () { return prefs.darkTopbar; }, function (v) { prefs.darkTopbar = v; save(prefs); apply(); }), '仅把顶栏换成深色，内容区跟随主题'));
        body.appendChild(section('内置主题色'));
        var sw = document.createElement('div');
        sw.className = 'pref-swatches';
        PRIMARY_PRESETS.forEach(function (p) {
          var b = document.createElement('button');
          b.className = 'pref-swatch' + (prefs.primary && prefs.primary.toLowerCase() === p[0] ? ' on' : '');
          b.style.background = p[0]; b.title = p[1];
          b.addEventListener('click', function () {
            prefs.primary = p[0]; save(prefs); apply();
            sw.querySelectorAll('.pref-swatch').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
          });
          sw.appendChild(b);
        });
        body.appendChild(sw);
        var custom = document.createElement('div');
        custom.className = 'pref-custom';
        custom.innerHTML = '<span>自定义主题色：</span>';
        var color = document.createElement('input');
        color.type = 'color'; color.value = prefs.primary || '#7c5cfc';
        color.addEventListener('input', function () { prefs.primary = color.value; save(prefs); apply(); });
        custom.appendChild(color);
        var resetC = document.createElement('button');
        resetC.className = 'pref-act'; resetC.textContent = '恢复默认紫';
        resetC.addEventListener('click', function () { prefs.primary = ''; save(prefs); apply(); color.value = '#7c5cfc'; });
        custom.appendChild(resetC);
        body.appendChild(custom);
      }
      if (tabName === 'layout') {
        body.appendChild(section('内容宽度'));
        var widths = [['fluid', '流式', '跟随窗口宽度，两侧留白约 10%'], ['boxed', '定宽', '内容收在 1200px 版心里，宽屏更易读']];
        var wc = document.createElement('div');
        wc.className = 'pref-theme-cards';
        widths.forEach(function (w) {
          var c = document.createElement('button');
          c.className = 'pref-theme-card' + (prefs.contentWidth === w[0] ? ' on' : '');
          c.innerHTML = '<span class="ico">' + (w[0] === 'fluid' ? '▭' : '▯') + '</span><span>' + w[1] + '</span>';
          c.addEventListener('click', function () {
            prefs.contentWidth = w[0]; save(prefs); apply();
            wc.querySelectorAll('.pref-theme-card').forEach(function (x) { x.classList.remove('on'); });
            c.classList.add('on');
          });
          wc.appendChild(c);
        });
        body.appendChild(wc);
        var hint = document.createElement('div');
        hint.className = 'pref-row-hint'; hint.textContent = '两种宽度都可以在右上角齿轮里随时切换，实时预览。';
        body.appendChild(hint);
      }
      if (tabName === 'general') {
        body.appendChild(section('通用'));
        body.appendChild(row('动态标题', toggle(function () { return prefs.dynamicTitle; }, function (v) { prefs.dynamicTitle = v; save(prefs); apply(); }), '把当前页面名写进浏览器标签标题（如「报表 · AIBuddy Panel」）'));
        body.appendChild(row('页面切换进度条', toggle(function () { return prefs.progressbar; }, function (v) { prefs.progressbar = v; save(prefs); apply(); }), '切换页面时顶部显示细进度条'));
      }
    }
    renderTab('look');

    drawer.querySelector('#pref-copy').addEventListener('click', function () {
      var text = JSON.stringify(prefs, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('✅ 偏好已复制到剪贴板'); }, function () { fallbackCopy(text); });
      else fallbackCopy(text);
    });
    drawer.querySelector('#pref-paste').addEventListener('click', function () {
      if (!(navigator.clipboard && navigator.clipboard.readText)) { toast('此浏览器不支持读取剪贴板', 'err'); return; }
      navigator.clipboard.readText().then(function (text) {
        try {
          var imported = JSON.parse(text);
          prefs = Object.assign({}, DEFAULTS, imported);
          save(prefs); apply();
          drawer.querySelectorAll('.pref-tabs button.on').forEach(function (t) { renderTab(t.dataset.tab); });
          toast('✅ 偏好已导入并应用');
        } catch (e) { toast('剪贴板内容不是有效的偏好 JSON', 'err'); }
      }).catch(function () { toast('读取剪贴板失败', 'err'); });
    });
    drawer.querySelector('#pref-reset').addEventListener('click', function () {
      prefs = Object.assign({}, DEFAULTS);
      try { localStorage.removeItem(KEY); } catch (e) {}
      save(prefs); apply();
      drawer.querySelectorAll('.pref-tabs button.on').forEach(function (t) { renderTab(t.dataset.tab); });
      toast('✅ 已恢复默认偏好');
    });
    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('✅ 偏好已复制'); } catch (e) { toast('复制失败', 'err'); }
      ta.remove();
    }
  }

  /* ── 页面切换进度条 ───────────────────────── */
  var progress = null;
  document.addEventListener('click', function (e) {
    var item = e.target.closest && e.target.closest('.nav-item[data-page]');
    if (!item || !load().progressbar) return;
    if (!progress) {
      progress = document.createElement('div');
      progress.className = 'pref-progress';
      document.body.appendChild(progress);
    }
    progress.classList.remove('done');
    progress.style.width = '30%';
    setTimeout(function () { progress.style.width = '82%'; }, 80);
    setTimeout(function () { progress.classList.add('done'); progress.style.width = '100%'; setTimeout(function () { progress.style.width = '0'; }, 260); }, 300);
  });

  /* ── 欢迎横幅（报表页顶部）────────────────── */
  function ensureBanner() {
    var page = document.querySelector('.page[data-page="overview"]');
    if (!page || page.querySelector('.aibuddy-banner') || page.children.length === 0) return;
    var now = new Date();
    var hour = now.getHours();
    var hello = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    var banner = document.createElement('div');
    banner.className = 'aibuddy-banner';
    banner.innerHTML =
      '<div class="ab-icon"><svg viewBox="0 0 24 24" width="26" height="26"><rect width="24" height="24" rx="5.4" fill="#7c5cfc"/><g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.23 9.24h10.71"/><path d="M15.94 6.72 18.77 9.24 15.94 11.76"/><path d="M18.77 14.76H8.06"/><path d="M8.06 12.24 5.23 14.76 8.06 17.28"/></g></svg></div>' +
      '<div class="ab-main"><div class="ab-hello">' + hello + '，欢迎回来</div>' +
      '<div class="ab-date">' + now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '</div></div>' +
      '<div class="ab-steps">' +
      '<span class="ab-chip ok">✓ 网关运行中</span>' +
      '<span class="ab-chip">① 添加账号</span><span class="ab-arrow">→</span>' +
      '<span class="ab-chip">② 创建网关 Key</span><span class="ab-arrow">→</span>' +
      '<span class="ab-chip">③ 客户端接入 /v1</span>' +
      '</div>';
    page.insertBefore(banner, page.firstChild);
  }
  var bannerTimer = setInterval(function () {
    if (document.querySelector('.page[data-page="overview"].active')) ensureBanner();
  }, 1200);
  setTimeout(function () { clearInterval(bannerTimer); }, 30000);

  /* ── 启动 ─────────────────────────────────── */
  function boot() {
    // 品牌名与页面名给动态标题用
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

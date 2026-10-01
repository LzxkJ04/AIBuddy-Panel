/* ─────────────────────────────────────────────
   AIBuddy Panel · 偏好设置系统（照 vue-next-admin 偏好抽屉复刻）
   右侧抽屉 · 四个页签：
     外观  主题三卡（真 SVG 图标）/ 深色侧栏 / 深色顶栏 / 顶栏渐变 /
           灰色模式 / 色弱模式 / 12 色主题板（圆点 + 名称）/ 自定义主题色
     布局  布局模式四卡（迷你布局示意图）/ 内容宽度 /
           侧栏（Logo 显示 / 选中菜单高亮条 / 折叠时隐藏分组标题）
     通用  动态标题 / 页面切换进度条 / 面包屑 / 页脚版权 / 页签栏显隐 /
           页面切换动画（无·淡入·滑入）/ 通知轮询间隔 / 水印
     锁屏  锁屏开关 / 锁屏密码 / 自动锁屏分钟数 / 立即锁屏
   页脚  复制偏好 / 导入偏好 / 恢复默认
   附带：顶栏快捷按钮（自愈）、复制网关直链、快速跳页、切页进度条、
         欢迎横幅（含账号池摘要 chip）、页脚「检查更新」、
         canvas 平铺水印、页面切换动画驱动、
         锁屏遮罩（抽屉按钮 / 空闲自动锁屏，状态持久化）。
   全部持久化在 localStorage（aibuddy-prefs），刷新即生效。
   注意：不注册任何键盘快捷键监听，全部功能走按钮与点选交互。
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
    watermarkText: '',        // 水印文字（空 = 品牌名+日期）
    pageAnim: 'none',         // 页面切换动画：none | fade | slide
    isBreadcrumb: true,       // 顶栏面包屑（vue-next-admin isBreadcrumb）
    isFooter: false,          // 内容区底部版权页脚（vue-next-admin isFooter）
    isShowLogo: true,         // 侧栏 Logo（vue-next-admin isShowLogo）
    isGroupLabel: true,       // 开=折叠时隐藏分组标题；关=折叠/抽屉模式也显示
    topbarGradient: false,    // 顶栏渐变背景（vue-next-admin isTopBarColorGradual）
    menuHighlight: false,     // 选中菜单左侧主色竖条（vue-next-admin 菜单高亮形态）
    isTagsview: true,         // 内容区顶部页签栏（vue-next-admin isTagsview）
    notifyInterval: 1,        // 通知中心轮询间隔（分钟，1–60，notify-center.js 读取）
    lockScreen: null          // 占位：sanitize 一律重建为 {enabled,password,minutes}
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
    // 新键：缺省按「关/默认开」补齐，旧 localStorage 数据加载后自动有默认值
    p.isBreadcrumb = (p.isBreadcrumb === undefined || p.isBreadcrumb === null) ? true : !!p.isBreadcrumb;
    p.isFooter = !!p.isFooter;
    p.isShowLogo = (p.isShowLogo === undefined || p.isShowLogo === null) ? true : !!p.isShowLogo;
    p.isGroupLabel = (p.isGroupLabel === undefined || p.isGroupLabel === null) ? true : !!p.isGroupLabel;
    p.topbarGradient = !!p.topbarGradient;
    p.menuHighlight = !!p.menuHighlight;
    p.isTagsview = (p.isTagsview === undefined || p.isTagsview === null) ? true : !!p.isTagsview;
    // 通知轮询间隔：分钟数钳位在 1–60，脏值（NaN / 0 / 越界）一律拉回默认 1
    var ni = Math.floor(Number(p.notifyInterval));
    p.notifyInterval = (isFinite(ni) && ni >= 1) ? Math.min(ni, 60) : 1;
    // lockScreen 单独重建（旧数据可能是任意脏值，且避免与 DEFAULTS 共用引用）
    var ls = (p.lockScreen && typeof p.lockScreen === 'object') ? p.lockScreen : {};
    var mins = Math.floor(Number(ls.minutes));
    p.lockScreen = {
      enabled: !!ls.enabled,
      password: typeof ls.password === 'string' ? ls.password : '',
      minutes: (isFinite(mins) && mins > 0) ? Math.min(mins, 1440) : 0 // 0 = 不自动锁屏
    };
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
    /* lucide link（链环）：复制网关直链按钮用 */
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
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
    // vue-next-admin 界面显示项：面包屑 / Logo / 分组标题 / 顶栏渐变 / 菜单高亮条
    root.setAttribute('data-pref-crumb', prefs.isBreadcrumb ? 'on' : 'off');
    root.setAttribute('data-pref-logo', prefs.isShowLogo ? 'on' : 'off');
    root.setAttribute('data-pref-grouplabel', prefs.isGroupLabel ? 'on' : 'off');
    root.setAttribute('data-pref-topbar-grad', prefs.topbarGradient ? 'on' : 'off');
    root.setAttribute('data-pref-navhl', prefs.menuHighlight ? 'on' : 'off');
    root.setAttribute('data-pref-tags', prefs.isTagsview ? 'on' : 'off');
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
    ensureFooter();
    syncLockScreen();
    try { syncThemeBtnRef(); } catch (e) {}
    document.dispatchEvent(new CustomEvent('aibuddy-prefs-changed', { detail: prefs }));
  }

  /* ── 页脚版权（vue-next-admin isFooter）：主内容区底部固定一行 ──
     行右侧带一个小按钮「检查更新」：调 /api/update/check 比对当前版本，
     结果用 toast 提示；请求期间按钮禁用防抖，失败（含未登录 401）提示「检查失败」。 */
  function ensureFooter() {
    var old = document.getElementById('pref-footer');
    if (!prefs.isFooter) { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
    var host = document.querySelector('.content-inner');
    if (!host) return;
    var brand = 'AIBuddy Panel';
    var h1 = document.querySelector('.brand-text h1');
    if (h1 && h1.textContent.trim()) brand = h1.textContent.trim();
    var copy = '© ' + new Date().getFullYear() + ' ' + brand + ' · 基于 agent2api';
    var f = old || el('div', 'pref-footer');
    f.id = 'pref-footer';
    if (!f.querySelector('.pref-footer-check')) {
      // 内容只装配一次：反复 apply() 不重建节点，进行中的检查不会被中途打断
      var txt = el('span', 'pref-footer-copy');
      var btn = el('button', 'pref-footer-check');
      btn.type = 'button';
      btn.textContent = '检查更新';
      btn.addEventListener('click', function () { checkUpdate(btn); });
      f.appendChild(txt);
      f.appendChild(btn);
    }
    var span = f.querySelector('.pref-footer-copy');
    if (span && span.textContent !== copy) span.textContent = copy;
    if (!old) host.appendChild(f);
  }

  /* 「检查更新」：当前版本优先取品牌区 .brand-version 的文本（如 v1.2.3），
     取不到再问一次 /api/update/status；都没有就缺省传空（后端按无法比较处理）。 */
  function checkUpdate(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    var done = function () { btn.disabled = false; };
    var current = '';
    var bv = document.querySelector('.brand-version');
    if (bv && bv.textContent) {
      var m = bv.textContent.trim().match(/^v?([0-9][0-9A-Za-z.\-+]*)$/i);
      if (m) current = m[1];
    }
    var ask = function () {
      fetch('/api/update/check' + (current ? '?current=' + encodeURIComponent(current) : ''),
        { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (env) {
          done();
          var d = env && env.data;
          if (d && d.hasUpdate === true) {
            var v = String(d.latestVersion || '');
            if (v && v.charAt(0) !== 'v' && v.charAt(0) !== 'V') v = 'v' + v;
            toast('发现新版本 ' + v + '，可在 设置→更新 下载');
          } else if (d && d.hasUpdate === false) {
            toast('已是最新版本');
          } else {
            toast('检查失败', 'err'); // 未登录 / 无法比较版本 / 空响应都归到这里
          }
        })
        .catch(function () { done(); toast('检查失败', 'err'); });
    };
    if (current) { ask(); return; }
    // 品牌区没有版本号（未登录或后端没返回）：退而求其次问 /api/update/status
    fetch('/api/update/status', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (env) {
        var v = env && env.data && env.data.currentVersion;
        if (typeof v === 'string' && v && v !== 'web') current = v;
      })
      .catch(function () {})
      .then(function () { ask(); });
  }

  /* ── 锁屏（vue-next-admin isLockScreen 形态）──
     抽屉「立即锁屏」按钮立即锁屏；开启后空闲达到设定分钟数自动锁屏；
     锁屏状态持久化在 aibuddy-lockscreen-active（刷新仍在锁屏），解锁即清除。 */
  var LOCK_KEY = 'aibuddy-lockscreen-active';
  var lockEl = null, lockTimeEl = null, lockDateEl = null, lockErrEl = null;
  var lockClockTimer = null, idleTimer = null, lastIdleReset = 0;

  function isLocked() { return !!(lockEl && lockEl.parentNode); }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function tickLockClock() {
    if (!lockTimeEl || !lockDateEl) return;
    var d = new Date();
    lockTimeEl.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    lockDateEl.textContent = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function buildLockOverlay() {
    var mask = el('div', 'pref-lock');
    mask.id = 'pref-lockscreen';
    var clock = el('div', 'pref-lock-clock');
    lockTimeEl = el('div', 'pref-lock-time');
    lockDateEl = el('div', 'pref-lock-date');
    clock.appendChild(lockTimeEl);
    clock.appendChild(lockDateEl);
    var box = el('div', 'pref-lock-box');
    var pw = prefs.lockScreen ? prefs.lockScreen.password : '';
    if (pw) {
      var hint = el('div', 'pref-lock-hint');
      hint.textContent = '屏幕已锁定，输入密码解锁';
      var r = el('div', 'pref-lock-row');
      var inp = el('input');
      inp.type = 'password';
      inp.placeholder = '锁屏密码';
      inp.autocomplete = 'off';
      var btn = el('button', 'pref-lock-btn');
      btn.type = 'button';
      btn.textContent = '解锁';
      var doTry = function () { tryUnlock(inp.value); };
      btn.addEventListener('click', doTry);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doTry(); } });
      r.appendChild(inp);
      r.appendChild(btn);
      lockErrEl = el('div', 'pref-lock-err');
      box.appendChild(hint);
      box.appendChild(r);
      box.appendChild(lockErrEl);
      setTimeout(function () { try { inp.focus(); } catch (e2) {} }, 30);
    } else {
      var hint2 = el('div', 'pref-lock-hint');
      hint2.textContent = '未设置密码，点击直接解锁';
      var btn2 = el('button', 'pref-lock-btn wide');
      btn2.type = 'button';
      btn2.textContent = '点击解锁';
      btn2.addEventListener('click', function () { tryUnlock(''); });
      box.appendChild(hint2);
      box.appendChild(btn2);
      lockErrEl = null;
    }
    mask.appendChild(clock);
    mask.appendChild(box);
    return mask;
  }

  function lockNow(persist) {
    if (isLocked()) return;
    lockEl = buildLockOverlay();
    document.body.appendChild(lockEl);
    if (persist !== false) { try { localStorage.setItem(LOCK_KEY, '1'); } catch (e) {} }
    tickLockClock();
    if (lockClockTimer) clearInterval(lockClockTimer);
    lockClockTimer = setInterval(tickLockClock, 1000);
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function unlock() {
    if (lockEl && lockEl.parentNode) lockEl.parentNode.removeChild(lockEl);
    lockEl = null; lockTimeEl = null; lockDateEl = null; lockErrEl = null;
    if (lockClockTimer) { clearInterval(lockClockTimer); lockClockTimer = null; }
    try { localStorage.removeItem(LOCK_KEY); } catch (e) {}
    restartIdleTimer();
  }

  function tryUnlock(value) {
    var pw = prefs.lockScreen ? prefs.lockScreen.password : '';
    if (pw && value !== pw) {
      if (lockErrEl) lockErrEl.textContent = '密码不正确，请重试';
      if (lockEl) {
        lockEl.classList.remove('shake');
        void lockEl.offsetWidth; // 强制重排，让抖动动画能重新播放
        lockEl.classList.add('shake');
      }
      return false;
    }
    unlock();
    return true;
  }

  function restartIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (isLocked()) return;
    if (!(prefs.lockScreen && prefs.lockScreen.enabled)) return;
    var mins = prefs.lockScreen.minutes;
    if (!mins || mins <= 0) return;
    idleTimer = setTimeout(function () { lockNow(); }, mins * 60 * 1000);
  }

  function syncLockScreen() {
    var flag = false;
    try { flag = localStorage.getItem(LOCK_KEY) === '1'; } catch (e) {}
    if (flag && !isLocked()) lockNow(false); // 刷新后恢复锁屏态（已持久化，不重复写）
    restartIdleTimer();
  }


  /* 空闲侦测：鼠标 / 键盘活动重置自动锁屏计时（10s 节流，避免高频重排计时器） */
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      var now = Date.now();
      if (now - lastIdleReset < 10000) return;
      lastIdleReset = now;
      restartIdleTimer();
    });
  });

  /* ── 平铺水印：canvas 生成半透明文字瓦片，fixed 全屏不挡交互 ── */
  function applyWatermark() {
    var old = document.getElementById('pref-watermark');
    if (!prefs.watermark) { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
    var brand = 'AIBuddy Panel';
    var h1 = document.querySelector('.brand-text h1');
    if (h1 && h1.textContent.trim()) brand = h1.textContent.trim();
    var d = new Date();
    var ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    var custom = (typeof prefs.watermarkText === 'string' && prefs.watermarkText.trim());
    var text = custom ? prefs.watermarkText.trim() : brand + ' · ' + ds;
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
    var btnSearch = mk('pref-btn-search', 'tb-icon-btn', '搜索页面', svg(P.search, 15));
    btnSearch.addEventListener('click', openSearchDialog);
    // 复制网关直链：客户端接入的第一步就是把 Base URL 粘进 OpenAI 兼容客户端
    var btnLink = mk('pref-btn-link', 'tb-icon-btn', '复制 OpenAI 兼容 Base URL', svg(P.link, 15));
    btnLink.addEventListener('click', copyGatewayLink);
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
    holder.appendChild(btnLink);
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

  /* ── 复制网关直链：OpenAI 客户端接入用的 Base URL（origin + /v1）── */
  function copyGatewayLink() {
    var url = location.origin + '/v1';
    var ok = function () { toast('已复制 Base URL：' + url); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(ok, function () { if (legacyCopy(url)) ok(); });
    } else {
      if (legacyCopy(url)) ok();
    }
  }
  /* 剪贴板降级：隐藏 textarea + execCommand（老内核 / 非安全上下文用） */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var done = false;
    try { done = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    if (!done) toast('复制失败，请手动复制：' + text, 'err');
    return done;
  }

  function toast(msg, type) {
    var host = document.querySelector('.content-inner') || document.body;
    var t = el('div', 'pref-toast' + (type === 'err' ? ' err' : ''));
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2200);
  }

  /* ── 快速跳页（点顶栏放大镜打开；Esc 关闭）── */
  var PAGES = [
    ['overview', '报表'], ['accounts', '账号'], ['gateway', '模型管理'],
    ['proxies', '网络代理'], ['keys', '网关 Key'], ['docs', '文档'],
    ['requests', '请求日志'], ['logs', '日志'], ['tasks', '定时任务'], ['settings', '设置']
  ];
  function openSearchDialog() {
    if (isLocked()) return; // 锁屏时入口按钮失效
    if (document.getElementById('pref-search-mask')) return;
    var mask = el('div', 'pref-mask');
    mask.id = 'pref-search-mask';
    var box = el('div', 'pref-search-box');
    box.innerHTML =
      '<div class="pref-search-head">' + svg(P.search, 15) +
      '<input id="pref-search-input" placeholder="搜索页面，回车跳转…" autocomplete="off" spellcheck="false">' +
      '<div class="pref-search-list"></div>' +
      '<div class="pref-search-foot"><span>输入名称后点击条目跳转，Esc 关闭</span></div>';
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
  /* 快速跳页只从顶栏放大镜按钮进入（不设键盘快捷键），锁屏时入口一并失效 */

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
      '<button type="button" data-tab="lock">锁屏</button>' +
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
        body.appendChild(row('顶栏渐变', toggle(function () { return prefs.topbarGradient; },
          function (v) { prefs.topbarGradient = v; save(prefs); apply(); }),
          '顶栏背景改为「主色 → 紫蓝」横向渐变，浅色 / 深色主题下都协调'));
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
        body.appendChild(section('侧栏'));
        body.appendChild(row('显示 Logo', toggle(function () { return prefs.isShowLogo; },
          function (v) { prefs.isShowLogo = v; save(prefs); apply(); }),
          '关闭后隐藏侧栏顶部的圆形 Logo，品牌文字保留'));
        body.appendChild(row('选中菜单高亮条', toggle(function () { return prefs.menuHighlight; },
          function (v) { prefs.menuHighlight = v; save(prefs); apply(); }),
          '当前菜单项左侧额外显示一条主色竖条指示'));
        body.appendChild(row('折叠时隐藏分组标题', toggle(function () { return prefs.isGroupLabel; },
          function (v) { prefs.isGroupLabel = v; save(prefs); apply(); }),
          '关闭后，侧栏折叠 / 手机抽屉模式也显示「运行状态」等分组标题'));
      }
      if (tabName === 'general') {
        body.appendChild(section('浏览体验'));
        body.appendChild(row('动态标题', toggle(function () { return prefs.dynamicTitle; },
          function (v) { prefs.dynamicTitle = v; save(prefs); apply(); }),
          '把当前页面名写进标签页标题（如「报表 · AIBuddy Panel」）'));
        body.appendChild(row('页面切换进度条', toggle(function () { return prefs.progressbar; },
          function (v) { prefs.progressbar = v; save(prefs); apply(); }), '切换页面时顶部显示细进度条'));
        body.appendChild(section('界面显示'));
        body.appendChild(row('面包屑', toggle(function () { return prefs.isBreadcrumb; },
          function (v) { prefs.isBreadcrumb = v; save(prefs); apply(); }),
          '顶栏显示当前页面位置（如「首页 / 报表」）；手机窄屏下始终隐藏'));
        body.appendChild(row('页脚版权', toggle(function () { return prefs.isFooter; },
          function (v) { prefs.isFooter = v; save(prefs); apply(); }),
          '在内容区底部显示固定版权行「© 2026 AIBuddy Panel · 基于 agent2api」，右侧附带「检查更新」小按钮'));
        body.appendChild(row('页签栏', toggle(function () { return prefs.isTagsview; },
          function (v) { prefs.isTagsview = v; save(prefs); apply(); }),
          '内容区顶部显示已打开页面的页签条，可单独关闭页签（vue-next-admin isTagsview）'));
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
        body.appendChild(section('通知'));
        // 通知轮询间隔：写键即存并广播（apply() 会派发 aibuddy-prefs-changed，
        // notify-center.js 监听该事件重排轮询计时器）
        var niIn = el('input', 'pref-inp num');
        niIn.type = 'number';
        niIn.min = '1'; niIn.max = '60'; niIn.step = '1';
        niIn.value = String(prefs.notifyInterval);
        niIn.addEventListener('input', function () {
          var n = Math.floor(Number(niIn.value));
          if (!isFinite(n) || n < 1) n = 1;
          if (n > 60) n = 60;
          prefs.notifyInterval = n;
          save(prefs); apply();
        });
        niIn.addEventListener('change', function () { niIn.value = String(prefs.notifyInterval); });
        body.appendChild(row('通知轮询间隔（分钟）', niIn,
          '顶栏通知中心每隔多久拉取一次网关事件，允许 1–60 分钟，修改立即生效'));
        body.appendChild(section('其他'));
        body.appendChild(row('水印', toggle(function () { return prefs.watermark; },
          function (v) { prefs.watermark = v; save(prefs); apply(); }),
          '在页面最上层平铺半透明文字，适用于录屏与演示场景'));
        var wmRow = row('水印文字', (function () {
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'pref-text-input';
          inp.maxLength = 40;
          inp.placeholder = '留空 = 品牌名 + 日期';
          inp.value = prefs.watermarkText || '';
          inp.addEventListener('input', function () {
            prefs.watermarkText = inp.value.trim();
            save(prefs); apply();
          });
          return inp;
        })(), '自定义水印内容（最长 40 字），输入即生效；关闭水印后本项不显示。');
        body.appendChild(wmRow);
      }
      if (tabName === 'lock') {
        body.appendChild(section('锁屏'));
        body.appendChild(row('启用锁屏', toggle(function () { return prefs.lockScreen.enabled; },
          function (v) { prefs.lockScreen.enabled = v; save(prefs); apply(); }),
          '开启后可点下方「立即锁屏」；空闲达到下方分钟数也会自动锁屏'));
        var pwIn = el('input', 'pref-inp pw');
        pwIn.type = 'password';
        pwIn.value = prefs.lockScreen.password;
        pwIn.placeholder = '未设置';
        pwIn.autocomplete = 'new-password';
        pwIn.addEventListener('input', function () {
          prefs.lockScreen.password = pwIn.value;
          save(prefs); // 密码只落盘，不必触发全量 apply
        });
        body.appendChild(row('锁屏密码', pwIn,
          '仅明文保存在本机 localStorage，用于本机解锁校验，不会上传；留空则锁屏后可直接解锁'));
        var minIn = el('input', 'pref-inp num');
        minIn.type = 'number';
        minIn.min = '0'; minIn.max = '1440'; minIn.step = '1';
        minIn.value = String(prefs.lockScreen.minutes);
        minIn.addEventListener('input', function () {
          var n = Math.floor(Number(minIn.value));
          if (!isFinite(n) || n < 0) n = 0;
          if (n > 1440) n = 1440;
          prefs.lockScreen.minutes = n;
          save(prefs);
        });
        minIn.addEventListener('change', function () { minIn.value = String(prefs.lockScreen.minutes); });
        body.appendChild(row('自动锁屏（分钟）', minIn,
          '鼠标 / 键盘空闲达到该分钟数自动锁屏；0 = 不自动锁屏'));
        var lockBtn = el('button', 'pref-act primary pref-lock-now');
        lockBtn.type = 'button';
        lockBtn.textContent = '立即锁屏';
        lockBtn.addEventListener('click', function () { lockNow(); });
        body.appendChild(lockBtn);
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
      prefs = sanitize(Object.assign({}, DEFAULTS)); // 走 sanitize，确保 lockScreen 等结构完整
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
      '<span class="ab-pool" hidden></span>' +
      '<div class="ab-steps">' +
      '<span class="ab-chip ok">' + svg(P.check, 12) + '<span>网关运行中</span></span>' +
      step('1', '添加账号') + '<span class="ab-arrow">' + svg(P.chevR, 12) + '</span>' +
      step('2', '创建网关 Key') + '<span class="ab-arrow">' + svg(P.chevR, 12) + '</span>' +
      step('3', '客户端接入 /v1') +
      '</div>';
    page.insertBefore(banner, page.firstChild);
    fetchPool(banner);
  }

  /* 账号池摘要：横幅步骤区前两枚真实数据 chip（账号数 / 请求记录条数）。
     数据来自 GET /api/storage（条数在 data.database 下，available = 库可用）；
     401（还没登录）/ 失败 / 库不可用一律保持隐藏，绝不摆假数字。
     首次失败 8 秒后补试一次（覆盖「横幅先画出来、登录刚好完成」的时序），再失败就放弃。 */
  function fetchPool(banner, retried) {
    var retry = function () {
      if (!retried && banner.parentNode) setTimeout(function () { fetchPool(banner, true); }, 8000);
    };
    fetch('/api/storage', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (env) {
        var d = env && env.data && env.data.database;
        if (d && d.available === true && banner.parentNode) fillPool(banner, d);
        else retry();
      })
      .catch(retry);
  }
  function fillPool(banner, d) {
    var pool = banner.querySelector('.ab-pool');
    if (!pool || pool.childNodes.length) return; // 已填过就不重复填
    var mk = function (label, n) {
      var c = el('span', 'ab-chip ab-pool-chip');
      c.textContent = label + ' ' + numOfChips(n);
      return c;
    };
    pool.appendChild(mk('账号', d.accounts));
    pool.appendChild(mk('请求记录', d.requests));
    pool.hidden = false;
  }
  function numOfChips(v) { var n = Math.floor(Number(v)); return isFinite(n) && n >= 0 ? n : 0; }
  var bannerTimer = setInterval(function () {
    if (document.querySelector('.page[data-page="overview"].active')) ensureBanner();
  }, 1200);
  setTimeout(function () { clearInterval(bannerTimer); }, 30000);

  /* ── 最小外部钩子：主会话接线 / 自动化冒烟测试用（只读偏好 + 锁屏控制）── */
  window.__aibuddyPrefs = {
    get: function () { return JSON.parse(JSON.stringify(prefs)); },
    lock: function () { lockNow(); },
    tryUnlock: tryUnlock,
    unlock: unlock,
    isLocked: isLocked
  };

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

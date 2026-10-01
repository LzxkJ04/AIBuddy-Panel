/* ─────────────────────────────────────────────
   AIBuddy Panel · 外壳层功能（本会话负责，与偏好系统独立）
   1) 桌面端侧栏折叠（64px 图标栏 + 悬停 title 提示 + localStorage 持久化）
   2) 顶栏全屏按钮（requestFullscreen，失败静默——桌面 WebView 可能不支持）
   ───────────────────────────────────────────── */
(function () {
  'use strict';

  var COLLAPSE_KEY = 'aibuddy-sidebar-collapsed';

  /* ── 侧栏折叠 ── */
  function applyCollapse(collapsed) {
    document.body.classList.toggle('shell-collapsed', collapsed);
    // 折叠时给每个导航项补 title 提示（展开态移除，避免重复气泡）
    document.querySelectorAll('.sidebar .nav-item[data-page]').forEach(function (item) {
      var label = item.querySelector('.label');
      if (collapsed) {
        item.setAttribute('title', label ? label.textContent : '');
      } else {
        item.removeAttribute('title');
      }
    });
  }

  function ensureCollapseButton() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar || document.getElementById('shell-collapse-btn')) return;
    var foot = sidebar.querySelector('.sidebar-foot') || sidebar;
    var btn = document.createElement('button');
    btn.id = 'shell-collapse-btn';
    btn.className = 'shell-toggle';
    btn.title = '收起 / 展开侧栏';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg>' +
      '<span>收起侧栏</span>';
    btn.addEventListener('click', function () {
      var collapsed = !document.body.classList.contains('shell-collapsed');
      try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) {}
      applyCollapse(collapsed);
      // 折叠态按钮文案只留图标
      btn.querySelector('span').textContent = collapsed ? '' : '收起侧栏';
    });
    // 插到侧栏最底部（sidebar-foot 之后），展开态显示文字
    sidebar.appendChild(btn);
    var collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) {}
    if (collapsed) {
      applyCollapse(true);
      btn.querySelector('span').textContent = '';
    }
  }

  /* ── 全屏 ── */
  function ensureFullscreenButton() {
    var bar = document.getElementById('topbar-status');
    if (!bar || document.getElementById('shell-btn-fullscreen')) return;
    var btn = document.createElement('button');
    btn.id = 'shell-btn-fullscreen';
    btn.title = '全屏 / 退出全屏';
    var iconExpand = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
    var iconCompress = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>';
    btn.innerHTML = iconExpand;
    btn.addEventListener('click', function () {
      try {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          document.documentElement.requestFullscreen().catch(function () {
            toastMsg('当前环境不支持全屏');
          });
        }
      } catch (e) { toastMsg('当前环境不支持全屏'); }
    });
    document.addEventListener('fullscreenchange', function () {
      btn.innerHTML = document.fullscreenElement ? iconCompress : iconExpand;
    });
    bar.parentNode.insertBefore(btn, bar);
  }

  function toastMsg(msg) {
    var t = document.createElement('div');
    t.className = 'pref-toast'; t.textContent = msg;
    (document.querySelector('.content-inner') || document.body).appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2000);
  }

  /* ── 启动 ── */
  function boot() {
    ensureCollapseButton();
    ensureFullscreenButton();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

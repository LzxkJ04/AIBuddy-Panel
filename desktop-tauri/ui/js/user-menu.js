/* AIBuddy Panel · 顶栏用户菜单（账号名 + 修改账号密码 + 退出登录） */
/* global wbIcons, wbToast */

/**
 * 为什么做成独立容器（照 notify-center.js / prefs.js 的 ensureTopbarButtons 同款约定）：
 * app.js 的 renderTopbarStatus() 每次刷新都整段重写 #topbar-status，塞进去的自绘按钮
 * 必然被冲掉 —— 本容器的挂载点是 #topbar-status 的**前面**，并挂 MutationObserver
 * 监听顶栏容器变化、被重写后自动重挂（自愈）。
 *
 * ── 修改账号密码 ──
 * POST /api/panel/password（需已登录；body {username, oldPassword, newUsername?,
 * newPassword?}，至少改一项）。成功后服务端撤销除当前会话外的全部会话（其他设备
 * 下线），当前设备不动。env 预置管理员的部署会 400（文案照实说）。
 *
 * ── 退出登录 ──
 * POST /api/panel/logout（撤销当前会话链 + 清双 cookie），成功后整页跳 /login。
 *
 * 手机端：菜单弹层宽度自适应（min(260px, calc(100vw - 24px))），右对齐不出屏。
 */
(() => {
  'use strict';

  var LABELS = { title: '账号', user: '管理员', change: '修改账号密码', logout: '退出登录' };

  /* ── 内联 SVG（stroke 风格与全站一致，见 icons.js 说明）── */
  function svg(path, size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      path + '</svg>';
  }
  var ICON = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M5 21c.8-3.8 3.6-6 7-6s6.2 2.2 7 6"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 10-10"/><path d="m16 7 3 3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  };

  var holder = null;   // 顶栏独立容器（自愈单位）
  var btn = null;      // 用户菜单按钮
  var pop = null;      // 弹层（挂 body）
  var openState = false;

  function currentUser() {
    try {
      var raw = localStorage.getItem('aibuddy-panel-user');
      return raw ? String(raw) : '';
    } catch (e) { return ''; }
  }

  function rememberUser(name) {
    try {
      if (name) localStorage.setItem('aibuddy-panel-user', String(name));
    } catch (e) { /* 存不了就下次还显示默认 */ }
  }

  /* 当前管理员账号名：GET /api/panel/status（public）会带 username（未注册时无）。
     拿不到就用缓存 / 默认文案 —— 只影响菜单第一行显示，不影响功能。 */
  function refreshUserName() {
    var internals = (window.__TAURI_INTERNALS__ || {});
    var invoke = internals.invoke;
    var p;
    if (invoke) {
      p = invoke('api_request', { request: { method: 'GET', path: '/api/panel/status' } });
    } else {
      p = fetch('/api/panel/status', { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); });
    }
    Promise.resolve(p).then(function (result) {
      var data = (result && result.data) || result || {};
      var name = data.username || data.user || '';
      if (name) {
        rememberUser(name);
        paintName(name);
      }
    }).catch(function () { /* 未登录 / 未注册：保持现状 */ });
  }

  function paintName(name) {
    var el = document.getElementById('um-name');
    if (el && name) el.textContent = name;
  }

  function closePop() {
    if (pop) { pop.remove(); pop = null; }
    openState = false;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onEsc, true);
  }

  function onDocClick(e) {
    if (!openState) return;
    if (pop && (pop.contains(e.target) || (btn && btn.contains(e.target)))) return;
    closePop();
  }

  function onEsc(e) {
    if (e.key === 'Escape' && openState) { closePop(); }
  }

  function openPop() {
    if (openState) { closePop(); return; }
    pop = document.createElement('div');
    pop.className = 'um-pop';
    pop.setAttribute('role', 'menu');
    pop.innerHTML =
      '<div class="um-head">' +
      '  <span class="um-avatar">' + svg(ICON.user, 16) + '</span>' +
      '  <div class="um-meta"><div class="um-name" id="um-name"></div><div class="um-role">管理员</div></div>' +
      '</div>' +
      '<button type="button" class="um-item" id="um-change">' + svg(ICON.key, 15) + '<span>' + LABELS.change + '</span></button>' +
      '<button type="button" class="um-item um-logout" id="um-logout">' + svg(ICON.logout, 15) + '<span>' + LABELS.logout + '</span></button>';
    document.body.appendChild(pop);
    var rect = btn.getBoundingClientRect();
    var width = Math.min(260, window.innerWidth - 24);
    pop.style.top = (rect.bottom + 8) + 'px';
    pop.style.left = Math.max(12, rect.right - width) + 'px';
    pop.style.width = width + 'px';
    paintName(currentUser());
    openState = true;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onEsc, true);
    document.getElementById('um-change').addEventListener('click', function () { closePop(); openChangeDialog(); });
    document.getElementById('um-logout').addEventListener('click', function () { closePop(); doLogout(); });
    refreshUserName();
  }

  /* toast 的统一入口（panel 页用组件库，这里是顶栏脚本 —— 与 notify-center 同款：
     直接看桥有没有 toast 能力，没有就 alert 兜底） */
  function toast(message, kind) {
    var wbApp = window.wbApp;
    if (wbApp && typeof wbApp.toast === 'function') { wbApp.toast(message, kind === 'err' ? 'err' : 'ok'); return; }
    if (kind === 'err') window.alert(message);
  }

  function describeError(error) {
    if (error instanceof Error && error.message) return error.message;
    return String(error || '').trim() || '未知错误';
  }

  function gatewayCall(method, path, body) {
    var internals = (window.__TAURI_INTERNALS__ || {});
    if (internals.invoke) {
      return internals.invoke('api_request', {
        request: { method: method, path: path, body: body === undefined ? null : body },
      });
    }
    // 网页端：同源 fetch（web_shim 的 httpCall 会处理 401 跳登录，这里 fetch 不经过它，
    // 按响应 envelope 自行解包 —— 与 notifyApi 同一口径）
    return fetch(path, {
      method: method,
      headers: body === undefined ? { 'Accept': 'application/json' } : { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) { return r.text(); }).then(function (text) {
      var payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
      var ok = r.ok !== false;
      return { httpOk: ok, payload: payload, text: text };
    }).then(function (result) {
      var payload = result.payload || {};
      if (!result.httpOk || payload.success === false) {
        var detail = payload.error || payload.message || payload.msg || ('HTTP ' + (result.payload ? 200 : 0));
        if (detail && detail.message) detail = detail.message;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }
      return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
    });
  }

  /* ── 修改账号密码（轻量 DOM 弹窗：不用组件库 —— 顶栏脚本是原生 js）── */
  function openChangeDialog() {
    var existing = document.getElementById('um-dialog-mask');
    if (existing) existing.remove();
    var mask = document.createElement('div');
    mask.id = 'um-dialog-mask';
    mask.className = 'um-mask';
    mask.innerHTML =
      '<div class="um-dialog" role="dialog" aria-modal="true" aria-label="修改账号密码">' +
      '  <h3>修改账号密码</h3>' +
      '  <label>当前账号<input id="um-old-user" autocomplete="username" placeholder="当前管理员账号"></label>' +
      '  <label>当前密码<input id="um-old-pass" type="password" autocomplete="current-password" placeholder="当前密码"></label>' +
      '  <label>新账号（选填，留空不改）<input id="um-new-user" placeholder="新的管理员账号"></label>' +
      '  <label>新密码（选填，留空不改，至少 8 位）<input id="um-new-pass" type="password" autocomplete="new-password" placeholder="新的密码"></label>' +
      '  <p class="um-warn">改密码后其他设备会全部退出登录（当前设备保持在线）。</p>' +
      '  <div class="um-actions">' +
      '    <button type="button" class="um-btn" id="um-cancel">取消</button>' +
      '    <button type="button" class="um-btn um-primary" id="um-ok">保存</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(mask);
    var oldUser = document.getElementById('um-old-user');
    var oldPass = document.getElementById('um-old-pass');
    var newUser = document.getElementById('um-new-user');
    var newPass = document.getElementById('um-new-pass');
    oldUser.value = currentUser();
    document.getElementById('um-cancel').addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    document.getElementById('um-ok').addEventListener('click', function () {
      var name = oldUser.value.trim();
      var oldP = oldPass.value;
      var nu = newUser.value.trim();
      var np = newPass.value;
      if (!name || !oldP) { toast('请填当前账号与当前密码', 'err'); return; }
      if (!nu && !np) { toast('新账号与新密码至少填一项', 'err'); return; }
      if (np && np.length < 8) { toast('新密码至少 8 位', 'err'); return; }
      var okBtn = document.getElementById('um-ok');
      okBtn.disabled = true;
      okBtn.textContent = '保存中…';
      gatewayCall('POST', '/api/panel/password', {
        username: name, oldPassword: oldP,
        newUsername: nu || undefined, newPassword: np || undefined,
      }).then(function (result) {
        mask.remove();
        var revoked = result && result.revokedSessions;
        if (np) rememberUser(nu || name);
        paintName(nu || name);
        toast('✅ 账号密码已修改' + (revoked ? '（已下线其他 ' + revoked + ' 台设备的会话）' : ''));
      }).catch(function (error) {
        okBtn.disabled = false;
        okBtn.textContent = '保存';
        toast('修改失败：' + describeError(error), 'err');
      });
    });
    (oldUser.value ? oldPass : oldUser).focus();
  }

  function doLogout() {
    gatewayCall('POST', '/api/panel/logout', {}).then(function () {
      window.location.href = '/login';
    }).catch(function (error) {
      // 无论成败都跳登录页（本地 cookie 已清 / 会话已撤的分支后端兜着）
      window.location.href = '/login';
    });
  }

  /* ── 顶栏挂载与自愈（照 notify-center.js 的约定）── */
  function ensureHolder() {
    var bar = document.getElementById('topbar-status');
    if (!bar || !bar.parentNode) return;
    var existing = document.getElementById('um-holder');
    if (existing) {
      // 顶栏被重写后顺序可能乱：保证 holder 仍在 #topbar-status 前面
      if (existing.nextElementSibling !== bar) bar.parentNode.insertBefore(existing, bar);
      holder = existing;
      btn = document.getElementById('um-btn');
      return;
    }
    holder = document.createElement('div');
    holder.id = 'um-holder';
    holder.className = 'um-holder';
    btn = document.createElement('button');
    btn.id = 'um-btn';
    btn.type = 'button';
    btn.className = 'um-btn-topbar';
    btn.title = '账号';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML =
      '<span class="um-ico">' + svg(ICON.user, 15) + '</span>' +
      '<span class="um-label" id="um-btn-name"></span>' +
      '<span class="um-caret">' + svg(ICON.chevD, 12) + '</span>';
    btn.addEventListener('click', function (e) { e.stopPropagation(); openPop(); });
    holder.appendChild(btn);
    bar.parentNode.insertBefore(holder, bar);
    paintName(currentUser());
    refreshUserName();
  }

  function boot() {
    ensureHolder();
    var bar = document.getElementById('topbar-status');
    if (bar && bar.parentNode && !window.__umObserver) {
      window.__umObserver = new MutationObserver(function () { ensureHolder(); });
      window.__umObserver.observe(bar.parentNode, { childList: true, subtree: false });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

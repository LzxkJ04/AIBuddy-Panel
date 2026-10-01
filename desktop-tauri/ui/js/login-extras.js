/**
 * AIBuddy Panel · 登录页增强（ui/login.html 专属脚本）
 *
 * 由主会话统一接线引入（建议：<script src="js/login-extras.js" defer></script>），
 * 配套样式 ui/css/login-extras.css。职责只有三件：
 *
 * 1. 记住账号：#username 输入防抖 400ms 后存 localStorage（aibuddy-login-user），
 *    下次进页在岛挂载完成后自动回填。密码绝不落盘。
 * 2. 密码显隐：给 #password 配一只「眼睛」（Element Plus 式 eye/eye-off 切换，
 *    内联 SVG），点击在 text/password 间切。按钮是独立节点追加到表单末尾、
 *    绝对定位进输入框右侧 —— 不包裹、不移动岛渲染的任何节点，不干扰
 *    React 的 reconciliation。
 * 3. 背景点缀：注入 .login-deco 装饰层（淡雅星座：径向渐变圆点 + 细连线），
 *    视觉全部由 login-extras.css 用 --ui-* 令牌绘制，深浅主题各自成立。
 *
 * 卡片入场动画是纯 CSS（login-extras.css 的 #login-app > div），不在此管理。
 *
 * 时序说明：登录卡的 DOM 由 React 岛（ui-islands/src/islands/login-page.tsx）
 * 渲染，岛在 islands/ui.js 求值时 flushSync 同步提交 —— 但本脚本可能在岛之前
 * 执行（defer 只保证 DOM 解析完，不保证 bundle 加载完），所以对 #username /
 * #password 的绑定走轮询等待：每 100ms 看一眼，最多等 10 秒（元素出现即
 * 挂载完成，见 login-page.tsx 文件头的时序注释）。
 */
(function () {
  'use strict';

  /** 记住账号的 localStorage 键：与 aibuddy-prefs 同一命名风格 */
  var REMEMBER_KEY = 'aibuddy-login-user';
  /** 轮询 #username 出现的间隔与上限（岛渲染有延迟） */
  var POLL_INTERVAL_MS = 100;
  var POLL_TIMEOUT_MS = 10000;
  /** 输入防抖：停止输入这么久后才落盘 */
  var SAVE_DEBOUNCE_MS = 400;

  /* localStorage 在隐私模式 / 被禁用时读写会抛异常：全部 try/catch 兜底，
     增强失败不能影响登录本身。 */
  function safeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* 忽略 */ }
  }
  function safeRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  }

  /* ── 背景点缀：注入装饰层 ──
     3 个径向渐变圆点 + 2 条细连线，几何/配色全在 login-extras.css。
     aria-hidden + pointer-events:none：纯装饰，读屏与鼠标都当它不存在。
     幂等：已存在（理论上只有本脚本会创建）就不再注入。 */
  function mountDeco() {
    if (!document.body || document.querySelector('.login-deco')) return;
    var deco = document.createElement('div');
    deco.className = 'login-deco';
    deco.setAttribute('aria-hidden', 'true');
    ['one', 'two', 'three'].forEach(function (n) {
      var dot = document.createElement('div');
      dot.className = 'login-deco-dot login-deco-dot--' + n;
      deco.appendChild(dot);
    });
    ['one', 'two'].forEach(function (n) {
      var line = document.createElement('div');
      line.className = 'login-deco-line login-deco-line--' + n;
      deco.appendChild(line);
    });
    document.body.appendChild(deco);
  }

  /* ── 等岛挂载 ──
     轮询等岛把指定元素渲染出来；拿到后交给 onReady（记住账号与密码
     眼睛都走这一条路）。 */
  function waitForEl(id, onReady) {
    var startedAt = Date.now();
    var timer = window.setInterval(function () {
      var el = document.getElementById(id);
      if (el) {
        window.clearInterval(timer);
        onReady(el);
        return;
      }
      // 岛 10 秒还没挂出来（bundle 加载失败之类）就放弃：增强静默失效
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) window.clearInterval(timer);
    }, POLL_INTERVAL_MS);
  }

  /* ── 记住账号 ──
     岛挂载后先回填、再绑输入防抖监听。密码绝不落盘。 */
  function bindRememberUsername(input) {
    // 回填：岛挂载完成后字段还是空的才填，别盖掉浏览器自动填充 / 用户已输入的值
    var saved = safeGet(REMEMBER_KEY);
    if (saved && !input.value) input.value = saved;

    // 输入防抖落盘：trim 后为空（清空了账号框）就删掉存值，下次不留残影
    var timer = 0;
    input.addEventListener('input', function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        var value = input.value.trim();
        if (value) safeSet(REMEMBER_KEY, value);
        else safeRemove(REMEMBER_KEY);
      }, SAVE_DEBOUNCE_MS);
    });
  }

  /* ── 密码显隐切换 ──
     #password（岛渲染）右侧加一只「眼睛」：Element Plus 式 eye/eye-off，
     点击在 text/password 间切。实现要点：
     · 按钮是本脚本自建的独立节点，追加到表单末尾 —— 不包裹、不移动岛
       渲染的节点，React reconciliation 完全感知不到；
     · 定位走「表单 relative + 按钮 absolute」：top/height/right 由 JS 按
       输入框实测几何同步（offsetTop 相对定位祖先的 padding 盒，与 absolute
       的参照一致），窗口缩放 / 字体就绪后重算一次；
     · 图标与配色走 --ui-* 令牌（见 login-extras.css），跟随主题深浅。 */
  var EYE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94' +
    'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>' +
    '<line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function mountPasswordEye(input) {
    var form = input.closest('form') || input.parentElement;
    if (!form || form.querySelector('.login-eye')) return; // 幂等：装过就不再装

    var btn = document.createElement('button');
    btn.type = 'button'; // 别让浏览器把它当 submit
    btn.className = 'login-eye';
    btn.innerHTML = EYE_SVG;
    btn.title = '显示密码';
    btn.setAttribute('aria-label', '显示密码');
    btn.setAttribute('aria-pressed', 'false');

    // 几何同步：按钮顶边/高度贴齐输入框，右缘缩进 6px（表单无边框内边距，
    // 仍按实测差值算，布局再变也不跑偏）
    function syncPos() {
      var formRect = form.getBoundingClientRect();
      var inputRect = input.getBoundingClientRect();
      btn.style.top = input.offsetTop + 'px';
      btn.style.height = input.offsetHeight + 'px';
      btn.style.right = Math.max(6, formRect.right - inputRect.right + 6) + 'px';
    }
    syncPos();
    window.addEventListener('resize', syncPos);
    // 字体晚到会挪动输入框位置：就绪后重算（fonts.ready 不存在就跳过）
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(syncPos).catch(function () { /* 忽略 */ });
    }

    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? EYE_OFF_SVG : EYE_SVG;
      btn.title = show ? '隐藏密码' : '显示密码';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      input.focus(); // 切完把焦点还回输入框，打字不断流
    });

    form.appendChild(btn);
  }

  function init() {
    // 只在登录页生效：主面板没有 #login-app（岛的挂载点，login.html 独有）
    if (!document.getElementById('login-app')) return;
    mountDeco();
    waitForEl('username', bindRememberUsername);
    waitForEl('password', mountPasswordEye);
  }

  // 兼容两种接线方式：head 里普通引入（等 DOM ready）与 body 尾部 / defer（直接跑）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/**
 * AIBuddy Panel · 登录页增强（ui/login.html 专属脚本）
 *
 * 由主会话统一接线引入（建议：<script src="js/login-extras.js" defer></script>），
 * 配套样式 ui/css/login-extras.css。职责只有两件：
 *
 * 1. 记住账号：#username 输入防抖 400ms 后存 localStorage（aibuddy-login-user），
 *    下次进页在岛挂载完成后自动回填。密码绝不落盘。
 * 2. 背景点缀：注入 .login-deco 装饰层（淡雅星座：径向渐变圆点 + 细连线），
 *    视觉全部由 login-extras.css 用 --ui-* 令牌绘制，深浅主题各自成立。
 *
 * 卡片入场动画是纯 CSS（login-extras.css 的 #login-app > div），不在此管理。
 *
 * 时序说明：登录卡的 DOM 由 React 岛（ui-islands/src/islands/login-page.tsx）
 * 渲染，岛在 islands/ui.js 求值时 flushSync 同步提交 —— 但本脚本可能在岛之前
 * 执行（defer 只保证 DOM 解析完，不保证 bundle 加载完），所以对 #username 的
 * 绑定走轮询等待：每 100ms 看一眼，最多等 10 秒（元素出现即挂载完成，
 * 见 login-page.tsx 文件头的时序注释）。
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

  /* ── 记住账号 ──
     轮询等岛把 #username 渲染出来；拿到后先回填、再绑输入监听。 */
  function waitForUsername(onReady) {
    var startedAt = Date.now();
    var timer = window.setInterval(function () {
      var input = document.getElementById('username');
      if (input) {
        window.clearInterval(timer);
        onReady(input);
        return;
      }
      // 岛 10 秒还没挂出来（bundle 加载失败之类）就放弃：增强静默失效
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) window.clearInterval(timer);
    }, POLL_INTERVAL_MS);
  }

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

  function init() {
    // 只在登录页生效：主面板没有 #login-app（岛的挂载点，login.html 独有）
    if (!document.getElementById('login-app')) return;
    mountDeco();
    waitForUsername(bindRememberUsername);
  }

  // 兼容两种接线方式：head 里普通引入（等 DOM ready）与 body 尾部 / defer（直接跑）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

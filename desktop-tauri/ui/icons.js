/* AIBuddy Panel · 内联 SVG 图标集（全站统一：官方 Lucide 线性图形） */

/**
 * 全站一套图标语言：官方 Lucide 的 24×24 线性图形（几何原样取自
 * lucide-static 包的 <名>.svg，剥掉开标签取 inner content），统一包一层
 *   <g fill="none" stroke="currentColor" stroke-width="2"
 *      stroke-linecap="round" stroke-linejoin="round">
 * —— 描边而非填充、线宽一律 2、圆头圆角转折：简洁、圆润、粗细一致。
 *
 * 用内联 SVG 而不是 emoji / 文字符号（最早一版用的是 ◈ ☰ ⇄ ✳ ≡ ⚙）：
 * 那类是字体字形，同一份 UI 在不同机器上渲染出来粗细、大小、基线都不同，
 * 而且无法随文字颜色精确着色（部分字形会被系统按 emoji 处理成彩色）。
 *
 * 着色只走 stroke="currentColor"（fill 一律 none）：侧栏 / 设置页导航的
 * 选中态给文字换色时，图标跟着 currentColor 自动变色，不需要 JS 重画。
 * svg 根节点仍写 fill="currentColor"，是给下面两个不走 <g> 的例外用的。
 *
 * 两个例外刻意不进线性体系：
 *   pulse —— 状态灯圆点，实心小圆才是「灯」的语义（root fill 直接着色）；
 *   brand —— 应用品牌标，渐变 App 图标，与窗口图标 / 登录页 Logo 同源。
 * 小尺寸（17px 图标盒）不做个别线宽微调：全套同一 stroke-width 才是
 * 「粗细一致」，17px 下 2px 描边渲染约 1.4px，清晰不糊。
 * 图标按 24×24 画布绘制，通过 width/height 缩放到目标尺寸。
 */
(() => {
  const ICONS = {
    // ── 主侧栏导航（几何 = 官方 Lucide 同名图标）──────────────

    // 概览：layout-dashboard（四块仪表砖）
    overview: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect width="7" height="9" x="3" y="3" rx="1" />
  <rect width="7" height="5" x="14" y="3" rx="1" />
  <rect width="7" height="9" x="14" y="12" rx="1" />
  <rect width="7" height="5" x="3" y="16" rx="1" />
</g>`,
    // 账号：users（一人 + 半影两人）
    accounts: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
  <path d="M16 3.128a4 4 0 0 1 0 7.744" />
  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
  <circle cx="9" cy="7" r="4" />
</g>`,
    // 模型管理（网关）：arrow-left-right（双向换向）
    gateway: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 3 4 7l4 4" />
  <path d="M4 7h16" />
  <path d="m16 21 4-4-4-4" />
  <path d="M20 17H4" />
</g>`,
    // 网关 Key：key-round（圆头钥匙；齿面小圆点是官方图形自带的实心点）
    key: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
  <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
</g>`,
    // 网络代理：globe（经纬球）
    proxies: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10" />
  <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
  <path d="M2 12h20" />
</g>`,
    // 日志 / 文档：file-text（文档 + 行文）
    logs: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="M10 9H8" />
  <path d="M16 13H8" />
  <path d="M16 17H8" />
</g>`,
    // 请求日志：list（三行清单）
    requests: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 5h.01" />
  <path d="M3 12h.01" />
  <path d="M3 19h.01" />
  <path d="M8 5h13" />
  <path d="M8 12h13" />
  <path d="M8 19h13" />
</g>`,
    // 定时任务：calendar-clock（日历 + 时钟）
    tasks: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16 14v2.2l1.6 1" />
  <path d="M16 2v3" />
  <path d="M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338" />
  <path d="M3 9h5.859" />
  <path d="M8 2v3" />
  <circle cx="16" cy="16" r="6" />
</g>`,
    // 设置：settings（齿轮）
    settings: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
  <circle cx="12" cy="12" r="3" />
</g>`,
    // 状态灯圆点：实心小圆（例外，不走描边体系；root fill="currentColor" 着色）
    pulse: '<circle cx="12" cy="12" r="5"/>',

    /**
     * 设置页左栏的分类图标（九个一组，随岛渲染进 .settings-nav-item .ico）。
     *
     * 与主侧栏导航**同一套**官方 Lucide 线性体系（stroke 2 + 圆头圆角 +
     * currentColor），不再单独一套粗细约定 —— 全站图标只有一种语言，
     * 换到哪个页面都不会出现风格断层。视觉上由 page-settings.css 给
     * 图标槽垫一枚浅紫圆角小方块，线性图形在小底块上比填充块更透气。
     */
    // 通用：sliders-horizontal（三条轨道 + 三个把手）
    sliders: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10 5H3" />
  <path d="M12 19H3" />
  <path d="M14 3v4" />
  <path d="M16 17v4" />
  <path d="M21 12h-9" />
  <path d="M21 19h-5" />
  <path d="M21 5h-7" />
  <path d="M8 10v4" />
  <path d="M8 12H3" />
</g>`,
    // 显示：monitor（显示器）
    display: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect width="20" height="14" x="2" y="3" rx="2" />
  <line x1="8" x2="16" y1="21" y2="21" />
  <line x1="12" x2="12" y1="17" y2="21" />
</g>`,
    // 流量：waypoints（节点 + 航线，路由分发意象）
    traffic: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="m10.586 5.414-5.172 5.172" />
  <path d="m18.586 13.414-5.172 5.172" />
  <path d="M6 12h12" />
  <circle cx="12" cy="20" r="2" />
  <circle cx="12" cy="4" r="2" />
  <circle cx="20" cy="12" r="2" />
  <circle cx="4" cy="12" r="2" />
</g>`,
    // 重试：refresh-ccw（逆时针重刷）
    refresh: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
  <path d="M3 3v5h5" />
  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
  <path d="M16 16h5v5" />
</g>`,
    // 冷却计时：timer（秒表）
    timer: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <line x1="10" x2="14" y1="2" y2="2" />
  <line x1="12" x2="15" y1="14" y2="11" />
  <circle cx="12" cy="14" r="8" />
</g>`,
    // 安全：shield（盾牌）
    shield: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
</g>`,
    // 存储：database（数据库圆柱）
    database: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <ellipse cx="12" cy="5" rx="9" ry="3" />
  <path d="M3 5V19A9 3 0 0 0 21 19V5" />
  <path d="M3 12A9 3 0 0 0 21 12" />
</g>`,
    // 积分构成：package（积分包裹合箱）
    packages: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
  <path d="M12 22V12" />
  <path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" />
  <path d="m7.5 4.27 9 5.15" />
</g>`,
    // 通知中心：bell（铃铛）
    bell: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
  <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
</g>`,
    // 品牌分类：palette（调色盘；四个实心小点是官方图形自带，同 key 的齿面圆点）
    palette: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
  <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
  <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
  <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
</g>`,
    // 反馈：message-circle（对话气泡）
    feedback: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
</g>`,
    // 导出 / 下载：download（落盘箭头）
    download: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 15V3" />
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  <path d="m7 10 5 5 5-5" />
</g>`,
    arrowDown: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></g>',
    arrowUp: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></g>',

    /**
     * 账号名隐私开关的两枚眼睛（账号表「账号」表头的显隐按钮）。
     * 几何沿用 Feather 的 eye / eye-off：睁眼是轮廓 + 瞳孔，闭眼是斜杠 + 裂开的轮廓，
     * 两枚共用同一外轮廓弧线，切换时只有斜杠与缺口出现 / 消失，不觉得是换了一个图标。
     * 与箭头同一手法：stroke 画、粗细 1.8（显示 13px 时约 1px，与表头 10.5px 小字相称）；
     * 导航 / 分类主图标统一 2，这两对小图标留在 13px 的表头里自成一档，见上注。
     */
    eye: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></g>',
    eyeOff: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>'
      + '<path d="m1 1 22 22"/></g>',

    /**
     * 品牌标：应用图标本体（紫罗兰渐变圆角方块 + 白色对话气泡 + 三点 + 星芒）。
     *
     * 几何照搬 ui/brand/logo-horizontal.svg 里的图标 mark（那块 512×512 的
     * 渐变圆角方块组），这里按同一比例换算到 24 画布，两处形状严格一致
     * （换算系数 24/512 = 0.046875；圆角 114 → 5.34）。渐变也照抄原文件：
     * 方块对角 #a678ff → #8654f0 → #6123c0，三点 #7a41e8 → #b795fa，
     * 顶部一层白色高光（sheen，.16 → 0）。
     *
     * 颜色不用 currentColor 而写死：这枚标要与 .ico/.png 应用图标与
     * 登录页的横版 Logo 一模一样，而主题里的 --primary 在深浅两套下取值不同
     * （深色主题会偏亮），跟着它走就不再是同一枚图标了。渐变的 id 带
     * wb-brand- 前缀：同一页面可能注入多枚 brand（侧栏 / 标题栏），
     * 重复 id 指向同一定义，无害；前缀避免与页面里其它 SVG 的 id 撞车。
     */
    brand: '<defs>'
      + '<linearGradient id="wb-brand-bg" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="#a678ff"/><stop offset=".48" stop-color="#8654f0"/><stop offset="1" stop-color="#6123c0"/>'
      + '</linearGradient>'
      + '<linearGradient id="wb-brand-sheen" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/>'
      + '</linearGradient>'
      + '<linearGradient id="wb-brand-dots" x1="0" y1="0" x2="1" y2="0">'
      + '<stop offset="0" stop-color="#7a41e8"/><stop offset="1" stop-color="#b795fa"/>'
      + '</linearGradient>'
      + '</defs>'
      + '<rect width="24" height="24" rx="5.34" fill="url(#wb-brand-bg)"/>'
      + '<rect width="24" height="24" rx="5.34" fill="url(#wb-brand-sheen)"/>'
      // 白色对话气泡（尾巴朝左下），三点是气泡内的「打字中」意象
      + '<path fill="#fff" d="M8.44 6.19H15.56A2.91 2.91 0 0 1 18.47 9.09V12.84A2.91 2.91 0 0 1 15.56 15.75H10.41'
      + 'C10.13 17.06 9.28 18.38 7.5 18.84C7.13 18.94 6.94 18.66 7.22 18.38C8.25 17.81 8.53 16.88 8.53 15.75H8.44'
      + 'A2.91 2.91 0 0 1 5.53 12.84V9.09A2.91 2.91 0 0 1 8.44 6.19Z"/>'
      + '<g fill="url(#wb-brand-dots)">'
      + '<circle cx="9.28" cy="10.97" r=".8"/><circle cx="12" cy="10.97" r=".8"/><circle cx="14.72" cy="10.97" r=".8"/>'
      + '</g>'
      // 右上角四角星芒
      + '<path fill="#fff" d="M18.66 3.75C18.85 4.58 19.32 5.05 20.16 5.25C19.32 5.45 18.85 5.92 18.66 6.75'
      + 'C18.46 5.92 17.99 5.45 17.16 5.25C17.99 5.05 18.46 4.58 18.66 3.75Z"/>',
  };

  /**
   * 渲染图标 SVG。
   * @param {string} name ICONS 里的键
   * @param {number} size 边长（px），默认 16
   */
  function icon(name, size = 16) {
    const path = ICONS[name];
    if (!path) return '';
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false">${path}</svg>`;
  }

  window.wbIcons = { icon, names: Object.keys(ICONS) };
})();

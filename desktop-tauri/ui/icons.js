/* Agent2API · 内联 SVG 图标集 */
/* global wbIcons */

/**
 * 侧边栏导航图标。
 *
 * 用内联 SVG 而不是 emoji / 文字符号（原来用的 ◈ ☰ ⇄ ✳ ≡ ⚙）：
 * 那类是字体字形，同一份 UI 在不同机器上渲染出来粗细、大小、基线都不同，
 * 而且无法随文字颜色精确着色（部分字形会被系统按 emoji 处理成彩色）。
 * SVG 用 currentColor 填充，尺寸、颜色完全受控。
 *
 * 图标按 24×24 画布绘制，通过 width/height 缩放到目标尺寸。
 */
(() => {
  const ICONS = {
    // 概览：仪表盘（表盘环 + 轴点 + 圆头指针）
    // 本次重画内部：原先「轴点」浮在 (12,8)、「指针」是 y12..16 的竖条，两者
    // 互不相连，17px 下读作环里一枚感叹号。现在指针从轴点 (12,14.6) 指向
    // 1~2 点钟方向，线帽 round 与全站描边图标同一手法；表盘外形（上圆下方
    // 的仪表壳）与 2px 环厚保持不变，视觉重量与同组其它填充图标一致。
    overview: '<path d="M12 3a9 9 0 0 0-9 9 8.94 8.94 0 0 0 2.2 5.9c.3.34.73.53 1.18.53h11.24c.45 0 .88-.2 1.18-.53A8.94 8.94 0 0 0 21 12a9 9 0 0 0-9-9Zm0 2a7 7 0 0 1 7 7 6.95 6.95 0 0 1-1.6 4.5H6.6A6.95 6.95 0 0 1 5 12a7 7 0 0 1 7-7Z"/>'
      + '<path d="M12 14.6l3.1-4.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
      + '<circle cx="12" cy="14.6" r="1.5"/>',
    // 账号：人群
    accounts: '<path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0 2c-3.6 0-6.5 2-6.5 4.5V20h13v-2.5C15.5 15 12.6 13 9 13Zm7.5-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-.9 0-1.7.12-2.4.35A6.9 6.9 0 0 1 18 17.5V20h3.5v-2.5c0-2.5-2.6-4.5-5-4.5Z"/>',
    // 网关：双向箭头（上行 / 下行两行，指向相反）
    // 本次重画：旧 path 的两个箭头在 y 上互相咬合（第一支的杆沿 y9.6..15
    // 折了个台阶，第二支从 y12 起），头部与杆叠在一起，17px 下糊成一团。
    // 现在是标准「交换」形：两行等厚的箭头（杆厚 2.4、头高 5.2），上行朝左、
    // 下行朝右，整体在 24 画布上居中（y 4.4..19.6 / x 3.5..20.5）。
    gateway: '<path d="M8 4.4 3.5 7 8 9.6V8.2h12V5.8H8Z"/>'
      + '<path d="M16 14.4 20.5 17 16 19.6V18.2H4v-2.4h12Z"/>',
    // 网关 Key：钥匙
    key: '<path d="M14.5 3a6.5 6.5 0 0 0-6.2 8.5L2 17.8V22h4.2v-2.4h2.4v-2.4h2.4l1.5-1.5A6.5 6.5 0 1 0 14.5 3Zm0 2a4.5 4.5 0 1 1 0 9c-.6 0-1.1-.1-1.6-.3l-.6-.2-2 2H7.9v2.4H5.6V19H4v-.4l6.2-6.2-.2-.6A4.5 4.5 0 0 1 14.5 5Zm1.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>',
    // 网络代理：地球（圆 + 赤道 + 经线椭圆）。「这个出口通往哪里」的既有意象。
    // 这一枚用描边而不是填充（同组的其余导航图标都是填充）：17px 下「圆里再挖三条线」
    // 会糊成一团，描边反而清楚；粗细取 1.8，与设置页那一组描边图标同一套约定。
    proxies: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">'
      + '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>'
      + '<ellipse cx="12" cy="12" rx="4.2" ry="9"/></g>',
    // 日志：文档 + 文本行
    logs: '<path d="M6 2h8l4 4v16H6V2Zm2 2v16h8V7h-3V4H8Zm2 6h6v2h-6v-2Zm0 4h6v2h-6v-2Z"/>',
    // 请求日志：列表（点 + 行），与 OmniProxy 的请求日志入口同一意象
    // 本次微调：原先三枚圆点的圆心（y 5.5/11.5/17.5）与三条横条的中线
    // （y 5.25/11.25/17.25）各差 0.25px，点与行对不齐、整体还偏上 0.5px。
    // 现在圆心与条中线逐行同轴（y 6/12/18），内容在 24 画布上严格居中
    // （y 4.5..19.5 / x 4..20），行距 6px 不变。
    requests: '<circle cx="5.5" cy="6" r="1.5"/><circle cx="5.5" cy="12" r="1.5"/><circle cx="5.5" cy="18" r="1.5"/>'
      + '<path d="M8 4.5h12v3H8v-3Zm0 6h12v3H8v-3Zm0 6h12v3H8v-3Z"/>',
    // 定时任务：时钟（圆 + 时针分针）
    tasks: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm-1 3v5.4l3.8 2.3 1-1.7-2.8-1.7V8h-2Z"/>',
    // 设置：齿轮
    // 本次重画：旧 path 的整体中心落在 (13.2, 11.75)（右移了约 1.2px），竖排
    // 导航里它比别的图标偏右一截。换成 Material「settings」的成熟齿轮 ——
    // 中心恰在 (12,12)，八齿 + 圆孔，齿形圆润，与同组填充图标同一份重量。
    settings: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 1 1 0 7.2Z"/>',
    // 状态灯（侧栏底部网关状态用）
    pulse: '<circle cx="12" cy="12" r="5"/>',

    /**
     * 设置页左栏的分类图标（2026-09 新增，九个一组）。
     *
     * ── 为什么单独一组（不复用上面那些导航图标）──────────────
     * 上面那组是主侧栏的**填充式**导航图标；设置页分类项的文字是 12.5px、
     * 图标盒 17px，填充块在这个尺寸下比文字重。这九个统一用**描边**画
     * （粗细 1.8 + 圆头圆角，与 arrowDown / eye 同一套约定，17px 下约 1.2px），
     * 几何取自 Feather / Lucide 的成熟图形（与 eye / eyeOff 借 Feather 同理），
     * 小尺寸下笔画不糊、形状可辨。九个图标同一风格，设置页内自成一套。
     */
    // 通用：调节滑杆（三条轨道 + 三个把手）
    sliders: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/>'
      + '<path d="M1 14h6M9 8h6M17 16h6"/></g>',
    // 显示：显示器（屏 + 底座）
    display: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<rect x="2" y="3" width="20" height="14" rx="2"/>'
      + '<path d="M8 21h8M12 17v4"/></g>',
    // 网关：双向箭头（进出的流量）
    traffic: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M8 3 4 7l4 4M4 7h16"/><path d="m16 21 4-4-4-4M20 17H4"/></g>',
    // 重试：环形箭头
    refresh: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></g>',
    // 超时：秒表（顶部按钮 + 表盘 + 指针）
    timer: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/></g>',
    // 安全：盾牌
    shield: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></g>',
    // 数据：数据库（三层圆柱）
    database: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<ellipse cx="12" cy="5" rx="9" ry="3"/>'
      + '<path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></g>',
    // 反馈与需求：对话气泡
    feedback: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></g>',
    // 更新：向下箭头 + 托盘（下载更新包）
    download: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></g>',

    /**
     * 优先级控件的两枚箭头（账号表「↓ 数字 ↑」合并控件用）。
     *
     * ── 为什么不用字符 ↓ / ↑（本次修复）────────────────────────
     * 那两个字是**字体字形**，墨迹在行盒里天生偏下：Segoe UI 下它们的
     * actualBoundingBoxAscent=7 / descent=0（整个字形贴在基线之上、没有下伸
     * 部分），而同一个控件里的数字是 ascent=8 / descent=0 —— 两者都靠
     * `align-items: center` 把行盒居中，于是箭头的**视觉重心比几何中心低
     * 约 0.5px**，在 22.67px 高的按钮里肉眼可见（用户实测反馈「有点靠下」）。
     * 这不是布局错误，换行高 / 加 padding 都治不了（动的是字形之外的东西）。
     *
     * 改成 SVG 之后几何完全受控：图标盒 24×24，箭头在盒内**上下对称**
     * （顶点 y=5、底点 y=19，中心恰好 12），而按钮是 flex 居中的 ——
     * 盒居中即墨迹居中，与字体、字号、平台都无关。
     * 这也正是本文件模块头写的那条理由（字体字形在不同机器上基线不同）。
     *
     * 形状：竖线 + 箭头，用 stroke 画（linecap/linejoin 圆角），
     * 与 brand 那枚双向箭头同一手法。
     *
     * ── 粗细为什么是 1.8（不是 2.4）─────────────────────────────
     * 图标显示尺寸 14px、画布 24 → 换算系数 14/24 ≈ 0.583，
     * 所以属性值 1.8 在屏幕上约 1.05px。旁边的数字（11.5px Segoe UI）
     * 字干约 0.98px —— 两者相称。
     * 初版写成 2.4（≈1.4px）比数字粗四成，箭头显得笨重、抢了数字的视觉权重，
     * 而这一列的主读数是数字（箭头只是改值入口）。
     */
    arrowDown: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></g>',
    arrowUp: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></g>',

    /**
     * 账号名隐私开关的两枚眼睛（账号表「账号」表头的显隐按钮）。
     * 几何沿用 Feather 的 eye / eye-off：睁眼是轮廓 + 瞳孔，闭眼是斜杠 + 裂开的轮廓，
     * 两枚共用同一外轮廓弧线，切换时只有斜杠与缺口出现 / 消失，不觉得是换了一个图标。
     * 与箭头同一手法：stroke 画、粗细 1.8（显示 13px 时约 1px，与表头 10.5px 小字相称）。
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

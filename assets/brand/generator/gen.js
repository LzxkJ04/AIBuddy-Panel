// AIBuddy Panel logo generator — violet theme (#8654f0 = oklch 0.585 0.221 293)
const opentype = require('opentype.js');
const fs = require('fs');

const fontBuf = fs.readFileSync('C:/Windows/Fonts/segoeuib.ttf');
const fontBold = opentype.parse(fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength));

const P = {
  bright: '#a678ff',  // gradient highlight
  primary: '#8654f0', // theme --primary
  deep: '#6123c0',
  light: '#a991f9',
  darkPrimary: '#9a73ff',
  ink: '#3b3f4a',     // "Panel" on light bg
  inkDark: '#efeef6', // "Panel" on dark bg
};

// ---- icon mark (512 viewBox): violet squircle + white chat bubble w/ tail + gradient dots + AI sparkle ----
const ICON_MARK = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${P.bright}"/>
      <stop offset=".48" stop-color="${P.primary}"/>
      <stop offset="1" stop-color="${P.deep}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/>
      <stop offset=".55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="dots" x1="181" y1="0" x2="331" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7a41e8"/>
      <stop offset="1" stop-color="#b795fa"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="114" fill="url(#bg)"/>
  <rect width="512" height="512" rx="114" fill="url(#sheen)"/>
  <path fill="#ffffff" d="M 180 132 H 332 A 62 62 0 0 1 394 194 V 274 A 62 62 0 0 1 332 336 H 222
    C 216 364 198 392 160 402 C 152 404 148 398 154 392 C 176 380 182 360 182 336 H 180
    A 62 62 0 0 1 118 274 V 194 A 62 62 0 0 1 180 132 Z"/>
  <g fill="url(#dots)">
    <circle cx="198" cy="234" r="17"/>
    <circle cx="256" cy="234" r="17"/>
    <circle cx="314" cy="234" r="17"/>
  </g>
  <path fill="#ffffff" d="M 398 80 C 402.2 97.8 412.2 107.8 430 112 C 412.2 116.2 402.2 126.2 398 144
    C 393.8 126.2 383.8 116.2 366 112 C 383.8 107.8 393.8 97.8 398 80 Z"/>`;

function buildIcon(size = 512) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">${ICON_MARK}</svg>`;
}

// ---- text to vector path ----
function textPath(text, fontSize, x, y, fill, tracking = 0) {
  const p = fontBold.getPath(text, x, y, fontSize, { kerning: true, tracking });
  return { svg: `<path fill="${fill}" d="${p.toPathData(2)}"/>`, width: p.getBoundingBox().x2 - p.getBoundingBox().x1 };
}

// ---- horizontal lockup ----
function horizontal(dark = false) {
  const fs = 132, iconSize = 256, pad = 36, gap = 52;
  const H = 320;
  const baseY = (H + iconSize) / 2 + fs * 0.355 - iconSize / 2; // optical center vs icon
  let x = pad + iconSize + gap;
  const t1 = textPath('AIBuddy', fs, x, baseY, 'x');
  const grad = dark
    ? `<stop offset="0" stop-color="#b9a0ff"/><stop offset="1" stop-color="#9a73ff"/>`
    : `<stop offset="0" stop-color="${P.primary}"/><stop offset="1" stop-color="${P.deep}"/>`;
  const panelFill = dark ? P.inkDark : P.ink;
  x += t1.width + fs * 0.26;
  const t2 = textPath('Panel', fs, x, baseY, 'x');
  const W = Math.ceil(x + t2.width + pad);
  const iconY = (H - iconSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="0">${grad}</linearGradient></defs>
  <g transform="translate(${pad} ${iconY}) scale(${iconSize / 512})">${ICON_MARK}</g>
  ${t1.svg.replace('fill="x"', 'fill="url(#tg)"')}
  ${t2.svg.replace('fill="x"', `fill="${panelFill}"`)}
</svg>`;
}

// ---- stacked lockup ----
function stacked(dark = false) {
  const fs = 84, iconSize = 300, iconY = 24;
  const W0 = textPath('AIBuddy', fs, 0, 0, 'x');
  const W2 = textPath('Panel', fs, 0, 0, 'x');
  const textW = W0.width + fs * 0.26 + W2.width;
  const W = Math.ceil(textW + 80), H = Math.ceil(iconY + iconSize + 56 + fs + 40);
  const baseY = iconY + iconSize + 56 + fs * 0.72;
  const tx = (W - textW) / 2;
  const grad = dark
    ? `<stop offset="0" stop-color="#b9a0ff"/><stop offset="1" stop-color="#9a73ff"/>`
    : `<stop offset="0" stop-color="${P.primary}"/><stop offset="1" stop-color="${P.deep}"/>`;
  const panelFill = dark ? P.inkDark : P.ink;
  const t1 = textPath('AIBuddy', fs, tx, baseY, 'url(#tg)');
  const t2 = textPath('Panel', fs, tx + W0.width + fs * 0.26, baseY, 'x');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="0">${grad}</linearGradient></defs>
  <g transform="translate(${(W - iconSize) / 2} ${iconY}) scale(${iconSize / 512})">${ICON_MARK}</g>
  ${t1.svg}${t2.svg.replace('fill="x"', `fill="${panelFill}"`)}
</svg>`;
}

fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/logo-icon.svg', buildIcon());
fs.writeFileSync('out/logo-horizontal.svg', horizontal(false));
fs.writeFileSync('out/logo-horizontal-dark.svg', horizontal(true));
fs.writeFileSync('out/logo-stacked.svg', stacked());
fs.writeFileSync('out/logo-stacked-dark.svg', stacked(true));
console.log('SVGs written:', fs.readdirSync('out').join(', '));

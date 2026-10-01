// Render SVGs to PNG at multiple sizes
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');

const render = (svg, width, out) => {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontDirs: ['C:/Windows/Fonts'], defaultFontFamily: 'Segoe UI' },
  });
  fs.writeFileSync(out, r.render().asPng());
  console.log(out);
};

const icon = fs.readFileSync('out/logo-icon.svg', 'utf8');
const hz = fs.readFileSync('out/logo-horizontal.svg', 'utf8');
const hzDark = fs.readFileSync('out/logo-horizontal-dark.svg', 'utf8');
const st = fs.readFileSync('out/logo-stacked.svg', 'utf8');

fs.mkdirSync('out/png', { recursive: true });
render(icon, 512, 'out/png/logo-icon-512.png');
render(icon, 192, 'out/png/logo-icon-192.png');
render(icon, 128, 'out/png/logo-icon-128.png');
render(icon, 64, 'out/png/logo-icon-64.png');
render(icon, 32, 'out/png/logo-icon-32.png');
const hb = hz.match(/width="(\d+)" height="(\d+)"/);
render(hz, +hb[1] * 2, 'out/png/logo-horizontal@2x.png');
const hbd = hzDark.match(/width="(\d+)" height="(\d+)"/);
render(hzDark, +hbd[1] * 2, 'out/png/logo-horizontal-dark@2x.png');
const sb = st.match(/width="(\d+)" height="(\d+)"/);
render(st, +sb[1] * 2, 'out/png/logo-stacked@2x.png');

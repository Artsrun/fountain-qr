const loadScript = (src) => new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = src;
  s.onload = () => res(src);
  s.onerror = () => rej(new Error(src));
  document.head.appendChild(s);
});

const loadFirst = async (urls) => {
  let last = null;
  for (const u of urls) {
    try { await loadScript(u); return u; } catch (e) { last = e; }
  }
  throw last || new Error('no script');
};

window.ensureQR = async () => {
  if (typeof qrcode === 'function' || (typeof QRCode !== 'undefined' && QRCode.toCanvas)) return;
  await loadFirst([
    'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js',
    'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  ]);
  if (typeof qrcode !== 'function' && !(typeof QRCode !== 'undefined' && QRCode.toCanvas)) {
    throw new Error('QR encoder blocked — open in Safari, not Telegram');
  }
};

window.ensureJSQR = async () => {
  if (typeof jsQR === 'function') return;
  await loadFirst([
    'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js',
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  ]);
  if (typeof jsQR !== 'function') throw new Error('jsQR blocked — open in Safari, not Telegram');
};

const off = document.createElement('canvas');
const offCtx = off.getContext('2d', { alpha: false });
let pix = null;
let pixN = 0;

const paintModules = (qr, canvas, sizePx) => {
  const n = qr.getModuleCount();
  const margin = 2;
  const scale = Math.max(2, Math.floor(sizePx / (n + margin * 2)));
  const size = (n + margin * 2) * scale;
  if (canvas.width !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  if (pixN !== n) {
    off.width = n;
    off.height = n;
    pix = offCtx.createImageData(n, n);
    pixN = n;
  }
  const d = pix.data;
  for (let r = 0, i = 0; r < n; r++) {
    for (let c = 0; c < n; c++, i += 4) {
      const v = qr.isDark(r, c) ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  offCtx.putImageData(pix, 0, 0);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(off, margin * scale, margin * scale, n * scale, n * scale);
};

window.paintFountainQR = async (canvas, text, px = 420) => {
  await window.ensureQR();
  const sizePx = Math.max(240, Math.min(900, px | 0));
  if (typeof qrcode !== 'function') {
    await QRCode.toCanvas(canvas, text, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: sizePx,
      color: { dark: '#000000', light: '#ffffff' },
    });
    return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  paintModules(qr, canvas, sizePx);
};

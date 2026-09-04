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
    try {
      await loadScript(u);
      return u;
    } catch (e) { last = e; }
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

window.paintFountainQR = async (canvas, text) => {
  await window.ensureQR();
  if (typeof QRCode !== 'undefined' && QRCode.toCanvas) {
    await QRCode.toCanvas(canvas, text, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 420,
      color: { dark: '#000000', light: '#ffffff' },
    });
    return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2;
  const scale = Math.max(2, Math.floor(420 / (n + margin * 2)));
  const size = (n + margin * 2) * scale;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
  }
};

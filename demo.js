const MAGIC = 'DCI1';
const b64 = {
  enc: (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  },
  dec: (s) => {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },
};

const mulberry = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const xorBlocks = (blocks, idxs, size) => {
  const out = new Uint8Array(size);
  for (const i of idxs) {
    const b = blocks[i];
    for (let j = 0; j < size; j++) out[j] ^= b[j];
  }
  return out;
};

const pickIdx = (rng, deg, K) => {
  const set = new Set();
  while (set.size < Math.min(deg, K)) set.add((rng() * K) | 0);
  return [...set].sort((a, b) => a - b);
};

const degreeOf = (seq, K) => {
  if (seq < K) return 1;
  const r = mulberry(seq ^ 0xA5A5)();
  if (r < 0.5) return 1;
  if (r < 0.8) return 2;
  return 3;
};

const packFrame = ({ session, seq, K, blockSize, fileLen, name, idxs, payload }) => {
  const nameB = new TextEncoder().encode(name.slice(0, 40));
  const buf = new Uint8Array(22 + nameB.length + 2 * idxs.length + payload.length);
  const v = new DataView(buf.buffer);
  let o = 0;
  buf[0] = 68; buf[1] = 67; buf[2] = 73; buf[3] = 49; o = 4;
  v.setUint32(o, session); o += 4;
  v.setUint32(o, seq); o += 4;
  v.setUint16(o, K); o += 2;
  v.setUint16(o, blockSize); o += 2;
  v.setUint32(o, fileLen); o += 4;
  buf[o++] = nameB.length;
  buf.set(nameB, o); o += nameB.length;
  buf[o++] = idxs.length;
  for (const i of idxs) { v.setUint16(o, i); o += 2; }
  buf.set(payload, o);
  return MAGIC + b64.enc(buf);
};

const unpackFrame = (text) => {
  if (!text || !text.startsWith(MAGIC)) return null;
  try {
    const buf = b64.dec(text.slice(4));
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf[0] !== 68 || buf[1] !== 67 || buf[2] !== 73 || buf[3] !== 49) return null;
    let o = 4;
    const session = v.getUint32(o); o += 4;
    const seq = v.getUint32(o); o += 4;
    const K = v.getUint16(o); o += 2;
    const blockSize = v.getUint16(o); o += 2;
    const fileLen = v.getUint32(o); o += 4;
    const nlen = buf[o++];
    const name = new TextDecoder().decode(buf.subarray(o, o + nlen)); o += nlen;
    const nIdx = buf[o++];
    const idxs = [];
    for (let i = 0; i < nIdx; i++) { idxs.push(v.getUint16(o)); o += 2; }
    const payload = buf.subarray(o, o + blockSize);
    if (payload.length !== blockSize) return null;
    return { session, seq, K, blockSize, fileLen, name, idxs, payload };
  } catch {
    return null;
  }
};

const splitFile = (bytes, blockSize) => {
  const K = Math.max(1, Math.ceil(bytes.length / blockSize));
  const blocks = Array.from({ length: K }, () => new Uint8Array(blockSize));
  for (let i = 0; i < K; i++) blocks[i].set(bytes.subarray(i * blockSize, (i + 1) * blockSize));
  return { K, blocks, fileLen: bytes.length };
};

const makeDroplet = (src, session, seq, name) => {
  const rng = mulberry((session ^ (seq * 2654435761)) >>> 0);
  const deg = degreeOf(seq, src.K);
  const idxs = seq < src.K ? [seq] : pickIdx(rng, deg, src.K);
  return packFrame({
    session, seq, K: src.K, blockSize: src.blocks[0].length,
    fileLen: src.fileLen, name, idxs,
    payload: xorBlocks(src.blocks, idxs, src.blocks[0].length),
  });
};

const createDecoder = () => {
  let meta = null;
  const seen = new Set();
  const droplets = [];
  const solved = [];
  let recovered = 0;

  const peel = () => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const d of droplets) {
        const next = [];
        for (const i of d.idxs) {
          if (solved[i]) {
            for (let j = 0; j < d.payload.length; j++) d.payload[j] ^= solved[i][j];
          } else next.push(i);
        }
        d.idxs = next;
        if (d.idxs.length !== 1) continue;
        const i = d.idxs[0];
        if (solved[i]) continue;
        solved[i] = d.payload.slice();
        recovered++;
        progressed = true;
        d.idxs = [];
      }
    }
  };

  return {
    add(frame) {
      if (!frame) return { ok: false };
      if (!meta) {
        meta = { session: frame.session, K: frame.K, blockSize: frame.blockSize, fileLen: frame.fileLen, name: frame.name };
        solved.length = frame.K;
      }
      if (frame.session !== meta.session) return { ok: false, reset: true };
      if (seen.has(frame.seq)) return { ok: true, dup: true, meta, recovered, K: meta.K };
      seen.add(frame.seq);
      droplets.push({ idxs: frame.idxs.slice(), payload: frame.payload.slice() });
      peel();
      return { ok: true, dup: false, meta, recovered, K: meta.K, done: recovered >= meta.K };
    },
    assemble() {
      if (!meta || recovered < meta.K) return null;
      const out = new Uint8Array(meta.K * meta.blockSize);
      for (let i = 0; i < meta.K; i++) {
        if (!solved[i]) return null;
        out.set(solved[i], i * meta.blockSize);
      }
      return { bytes: out.subarray(0, meta.fileLen), name: meta.name, meta };
    },
    get meta() { return meta; },
    get recovered() { return recovered; },
  };
};

const $ = (id) => document.getElementById(id);
const tabs = document.querySelectorAll('nav button[data-tab]');
tabs.forEach((b) => b.onclick = () => {
  tabs.forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === b.dataset.tab));
});
let txTimer = 0, txSeq = 0, txSrc = null, txSession = 0, txName = 'note.txt';
let painting = false;

const paintQR = async (text) => {
  const canvas = $('qrCanvas');
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 420,
    color: { dark: '#000000', light: '#ffffff' },
  });
};

$('startSend').onclick = async () => {
  clearInterval(txTimer);
  const file = $('fileIn').files[0];
  let bytes, name;
  if (file) {
    bytes = new Uint8Array(await file.arrayBuffer());
    name = file.name;
  } else {
    bytes = new TextEncoder().encode($('textIn').value || 'hello');
    name = 'note.txt';
  }
  const blockSize = Math.max(16, Math.min(120, +$('blockSize').value || 48));
  txSrc = splitFile(bytes, blockSize);
  txSession = (Math.random() * 0xffffffff) >>> 0;
  txSeq = 0;
  txName = name;
  $('txSession').textContent = txSession.toString(16);
  $('txBytes').textContent = bytes.length + ' B';
  const fps = Math.max(4, Math.min(30, +$('fps').value || 12));
  const tick = async () => {
    if (painting || !txSrc) return;
    painting = true;
    try {
      const droplet = makeDroplet(txSrc, txSession, txSeq, txName);
      await paintQR(droplet);
      $('txSeq').textContent = txSeq + ' / ' + txSrc.K;
      $('txFrame').textContent = droplet.length + ' ch';
      txSeq++;
    } finally {
      painting = false;
    }
  };
  await tick();
  txTimer = setInterval(tick, 1000 / fps);
};

$('stopSend').onclick = () => { clearInterval(txTimer); txTimer = 0; };

let camStream = null, camLoop = 0, decoder = createDecoder();
let capN = 0, decN = 0, dropN = 0, newN = 0, dupN = 0, lastTick = performance.now();
let finished = false;

const resetRxUi = () => {
  decoder = createDecoder();
  finished = false;
  capN = decN = dropN = newN = dupN = 0;
  $('doneBanner').classList.remove('on');
  $('dlLink').style.display = 'none';
  $('textOut').textContent = '';
  $('preview').removeAttribute('src');
};

const onDecodedText = (text) => {
  const frame = unpackFrame(text);
  if (!frame) { dropN++; return; }
  let r = decoder.add(frame);
  if (r.reset) {
    resetRxUi();
    r = decoder.add(frame);
  }
  if (r.dup) dupN++;
  else if (r.ok) newN++;
  $('rxLock').textContent = r.meta ? 'LOCK' : '—';
  $('rxLock').className = r.meta ? 'ok' : '';
  $('rxSolved').textContent = (decoder.recovered || 0) + '/' + (r.K || 0);
  $('rxFrames').textContent = newN + '/' + dupN;
  $('rxDrop').textContent = dropN;
  if (r.done && !finished) {
    finished = true;
    const got = decoder.assemble();
    if (!got) return;
    const blob = new Blob([got.bytes]);
    const url = URL.createObjectURL(blob);
    $('dlLink').href = url;
    $('dlLink').download = got.name || 'payload.bin';
    $('dlLink').style.display = 'inline-block';
    $('doneBanner').textContent = `Transfer complete — ${got.bytes.length} B  (${got.name})`;
    $('doneBanner').classList.add('on');
    const look = new TextDecoder().decode(got.bytes.slice(0, 200));
    $('textOut').textContent = look;
    if ((got.name || '').match(/\.(png|jpe?g|gif|webp)$/i)) {
      $('preview').src = url;
    }
  }
};

const scanCanvas = (canvas) => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  if (!width || !height) return;
  const img = ctx.getImageData(0, 0, width, height);
  const code = jsQR(img.data, width, height, { inversionAttempts: 'dontInvert' });
  if (code && code.data) {
    decN++;
    onDecodedText(code.data);
  }
};

$('startCam').onclick = async () => {
  resetRxUi();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (err) {
    $('textOut').textContent = 'camera: ' + (err && err.message ? err.message : err);
    return;
  }
  const video = $('camVideo');
  video.srcObject = camStream;
  await video.play();
  const canvas = $('camCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const loop = () => {
    camLoop = requestAnimationFrame(loop);
    if (video.readyState < 2) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w) return;
    const side = Math.min(w, h);
    const sx = (w - side) / 2, sy = (h - side) / 2;
    canvas.width = 480;
    canvas.height = 480;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, 480, 480);
    capN++;
    scanCanvas(canvas);
    const now = performance.now();
    if (now - lastTick > 1000) {
      $('rxCap').textContent = capN;
      $('rxDec').textContent = decN.toFixed(0);
      capN = decN = 0;
      lastTick = now;
    }
  };
  loop();
};

$('stopCam').onclick = () => {
  cancelAnimationFrame(camLoop);
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
};

$('runLoop').onclick = async () => {
  const bytes = new TextEncoder().encode($('textIn').value || 'loopback works');
  const src = splitFile(bytes, 48);
  const session = 0xC0FFEE;
  const dec = createDecoder();
  let used = 0;
  const canvas = $('qrCanvas');
  for (let seq = 0; seq < src.K * 6; seq++) {
    if (seq < src.K && seq % 2 === 0) continue;
    const text = makeDroplet(src, session, seq, 'loop.txt');
    await QRCode.toCanvas(canvas, text, { errorCorrectionLevel: 'M', margin: 2, width: 360 });
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
    if (!code) continue;
    const frame = unpackFrame(code.data);
    const r = dec.add(frame);
    used++;
    if (r.done) {
      const got = dec.assemble();
      const txt = new TextDecoder().decode(got.bytes);
      const ok = txt === new TextDecoder().decode(bytes);
      $('lbUsed').textContent = used + ' / ' + src.K;
      $('lbOk').textContent = ok ? 'OK' : 'MISMATCH';
      $('lbOk').className = ok ? 'ok' : '';
      $('lbOut').textContent = txt;
      return;
    }
  }
  $('lbUsed').textContent = used;
  $('lbOk').textContent = 'FAIL';
};

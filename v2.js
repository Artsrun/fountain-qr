const MAGIC = 'DCI2';
const SCAN = 360;
const PRESETS = {
  lock: { block: 32, fps: 8, target: 48 * 1024, cap: 96 * 1024 },
  phone: { block: 80, fps: 12, target: 80 * 1024, cap: 160 * 1024 },
  close: { block: 160, fps: 20, target: 140 * 1024, cap: 320 * 1024 },
};

const b64 = {
  enc: (u8) => {
    const parts = [];
    for (let i = 0; i < u8.length; i += 0x8000) {
      parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)));
    }
    return btoa(parts.join(''));
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

let xorBuf = new Uint8Array(0);
let xorSize = 0;
const xorBlocks = (blocks, idxs, size) => {
  if (xorSize !== size) {
    xorBuf = new Uint8Array(size);
    xorSize = size;
  }
  xorBuf.fill(0);
  for (let k = 0; k < idxs.length; k++) {
    const b = blocks[idxs[k]];
    for (let j = 0; j < size; j++) xorBuf[j] ^= b[j];
  }
  return xorBuf;
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

const packFrame = ({ flags, session, seq, K, blockSize, fileLen, name, idxs, payload }) => {
  const nameB = new TextEncoder().encode(name.slice(0, 40));
  const buf = new Uint8Array(23 + nameB.length + 2 * idxs.length + payload.length);
  const v = new DataView(buf.buffer);
  let o = 0;
  buf[0] = 68; buf[1] = 67; buf[2] = 73; buf[3] = 50; o = 4;
  buf[o++] = flags;
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
    if (buf[0] !== 68 || buf[1] !== 67 || buf[2] !== 73 || buf[3] !== 50) return null;
    let o = 4;
    const flags = buf[o++];
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
    return { flags, session, seq, K, blockSize, fileLen, name, idxs, payload };
  } catch { return null; }
};

const splitFile = (bytes, blockSize) => {
  const K = Math.max(1, Math.ceil(bytes.length / blockSize));
  const pad = new Uint8Array(K * blockSize);
  pad.set(bytes);
  const blocks = Array.from({ length: K }, (_, i) => pad.subarray(i * blockSize, (i + 1) * blockSize));
  return { K, blocks, fileLen: bytes.length };
};

const makeDroplet = (src, session, seq, name, flags) => {
  const rng = mulberry((session ^ (seq * 2654435761)) >>> 0);
  const deg = degreeOf(seq, src.K);
  const idxs = seq < src.K ? [seq] : pickIdx(rng, deg, src.K);
  return packFrame({
    flags, session, seq, K: src.K, blockSize: src.blocks[0].length,
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
      for (let d = droplets.length - 1; d >= 0; d--) {
        const drop = droplets[d];
        const next = [];
        for (let k = 0; k < drop.idxs.length; k++) {
          const i = drop.idxs[k];
          const s = solved[i];
          if (s) {
            const p = drop.payload;
            for (let j = 0; j < p.length; j++) p[j] ^= s[j];
          } else next.push(i);
        }
        drop.idxs = next;
        if (next.length !== 1 || solved[next[0]]) {
          if (!next.length) droplets.splice(d, 1);
          continue;
        }
        solved[next[0]] = drop.payload;
        recovered++;
        progressed = true;
        droplets.splice(d, 1);
      }
    }
  };
  return {
    add(frame) {
      if (!frame) return { ok: false };
      if (!meta) {
        meta = { session: frame.session, K: frame.K, blockSize: frame.blockSize, fileLen: frame.fileLen, name: frame.name, flags: frame.flags };
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
      return { bytes: out.subarray(0, meta.fileLen), name: meta.name, flags: meta.flags, meta };
    },
    get meta() { return meta; },
    get recovered() { return recovered; },
  };
};

const $ = (id) => document.getElementById(id);
const show = (id, msg, cls) => {
  const el = $(id);
  if (!msg) { el.classList.remove('on'); el.textContent = ''; return; }
  el.textContent = msg;
  el.className = 'banner on ' + (cls || '');
};
const hints = {
  lock: 'Far or shaky. 32 B · 8 fps.',
  phone: "Arm's length. 80 B · 12 fps.",
  close: 'Bright and still. 160 B · 20 fps.',
};
const theme = document.querySelector('meta[name="theme-color"]');
const setTheme = (c) => { if (theme) theme.content = c; };
const syncPresetUi = () => {
  const v = $('preset').value;
  document.querySelectorAll('[data-preset]').forEach((b) => {
    const on = b.dataset.preset === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const hint = $('presetHint');
  if (hint) hint.textContent = hints[v] || hints.phone;
};
const setLight = (on) => {
  $('qrWrap').classList.toggle('fs', on);
  setTheme(on ? '#ffffff' : '#070a11');
  const light = $('lightBtn');
  if (light) light.textContent = on ? 'Exit' : 'Light';
};
const setTab = (id) => {
  const go = () => {
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === id));
    if (id !== 'send') setLight(false);
    document.body.dataset.pane = id;
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduce) document.startViewTransition(go);
  else go();
};
document.querySelectorAll('[data-go]').forEach((b) => {
  b.onclick = () => setTab(b.dataset.go);
});
document.querySelectorAll('[data-preset]').forEach((b) => {
  b.onclick = () => {
    $('preset').value = b.dataset.preset;
    $('preset').dispatchEvent(new Event('change'));
  };
});
const lightBtn = $('lightBtn');
if (lightBtn) lightBtn.onclick = () => setLight(!$('qrWrap').classList.contains('fs'));
const exitLight = $('exitLight');
if (exitLight) exitLight.onclick = (e) => { e.stopPropagation(); setLight(false); };

const etaSec = (n, block, fps) => Math.max(1, Math.ceil((Math.ceil(n / block) * 1.2) / fps));
const fmtEta = (s) => (s < 90 ? s + 's' : (s / 60).toFixed(1) + ' min');
const isImage = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(f.name);
const preset = () => PRESETS[$('preset').value] || PRESETS.phone;

const gzipMaybe = async (u8) => {
  if (typeof CompressionStream === 'undefined' || u8.length < 256) return { bytes: u8, flags: 0 };
  try {
    const out = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    return out.length < u8.length * 0.92 ? { bytes: out, flags: 1 } : { bytes: u8, flags: 0 };
  } catch { return { bytes: u8, flags: 0 }; }
};

const gunzipMaybe = async (u8, flags) => {
  if (!(flags & 1) || typeof DecompressionStream === 'undefined') return u8;
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
};

const decodeImage = async (file) => {
  try { return await createImageBitmap(file); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = () => rej(new Error('cannot decode image'));
        el.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
  }
};

const compressImage = async (file, target) => {
  const img = await decodeImage(file);
  let w = img.width || img.naturalWidth;
  let h = img.height || img.naturalHeight;
  const maxEdge = 960;
  if (Math.max(w, h) > maxEdge) {
    const s = maxEdge / Math.max(w, h);
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  let q = 0.72, blob = null;
  for (let i = 0; i < 7; i++) {
    c.width = w; c.height = h;
    ctx.drawImage(img, 0, 0, w, h);
    blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= target) break;
    if (!blob) break;
    if (blob.size > target * 1.5) {
      w = Math.max(160, Math.round(w * 0.75));
      h = Math.max(160, Math.round(h * 0.75));
    }
    q = Math.max(0.32, q - 0.1);
  }
  if (img.close) img.close();
  if (!blob) throw new Error('JPEG encode failed');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), name: file.name.replace(/\.[^.]+$/, '') + '.jpg', from: file.size };
};

const sha8 = async (u8) => {
  const buf = await crypto.subtle.digest('SHA-256', u8);
  return [...new Uint8Array(buf).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const startClock = (fps, tick) => {
  const step = 1000 / fps;
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let dead = false;
  const loop = (now) => {
    if (dead) return;
    acc += now - last;
    last = now;
    if (acc >= step) {
      acc = Math.min(acc - step, step);
      tick();
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => { dead = true; cancelAnimationFrame(raf); };
};

let picked = null, prepared = null, flags = 0;
let stopTx = () => {}, txSeq = 0, txSrc = null, txSession = 0, txName = 'note.txt', painting = false;

const syncChip = () => {
  const p = preset();
  if (!prepared) {
    $('fileChip').textContent = 'No file — sending text';
    $('fileChip').classList.remove('on');
    return;
  }
  const extra = prepared.from ? ` (from ${(prepared.from / 1024).toFixed(0)} KB)` : '';
  const gz = flags & 1 ? ' gzip' : '';
  $('fileChip').textContent = `${prepared.name} · ${(prepared.bytes.length / 1024).toFixed(1)} KB${extra}${gz} · ~${fmtEta(etaSec(prepared.bytes.length, p.block, p.fps))}`;
  $('fileChip').classList.add('on');
};

$('pickFile').onclick = () => $('fileIn').click();
$('fileIn').onchange = async () => {
  picked = $('fileIn').files[0] || null;
  prepared = null; flags = 0;
  show('txErr', '');
  if (!picked) { syncChip(); return; }
  $('fileChip').textContent = 'Preparing…';
  $('fileChip').classList.add('on');
  const p = preset();
  try {
    if (isImage(picked) && picked.size > p.target) {
      prepared = await compressImage(picked, p.target);
    } else {
      const raw = new Uint8Array(await picked.arrayBuffer());
      const g = await gzipMaybe(raw);
      prepared = { bytes: g.bytes, name: picked.name, from: picked.size };
      flags = g.flags;
    }
    if (prepared.bytes.length > p.cap) throw new Error(`wire ${prepared.bytes.length} B > ${p.cap} B for this preset`);
    syncChip();
  } catch (e) {
    prepared = null; picked = null; $('fileIn').value = '';
    syncChip();
    show('txErr', String(e.message || e), 'err');
  }
};
$('clearFile').onclick = () => {
  picked = prepared = null; flags = 0; $('fileIn').value = '';
  syncChip(); show('txErr', '');
};
$('preset').onchange = () => { syncChip(); syncPresetUi(); };
syncPresetUi();

$('qrWrap').onclick = (e) => { if (e.target.closest('.exit-light')) return; setLight(!$('qrWrap').classList.contains('fs')); };

const setStreaming = (on) => {
  $('startSend').classList.toggle('on', on);
  $('startSend').textContent = on ? 'Streaming' : 'Start stream';
  $('startSend').disabled = on;
  $('send').classList.toggle('live', on);
  setLight(on);
};

const haltTx = () => {
  stopTx();
  stopTx = () => {};
  painting = false;
};

$('startSend').onclick = async () => {
  show('txErr', '');
  haltTx();
  try {
    await window.ensureQR();
    const p = preset();
    let bytes, name, fl = flags;
    if (prepared) { bytes = prepared.bytes; name = prepared.name; }
    else {
      const raw = new TextEncoder().encode($('textIn').value || 'hello');
      const g = await gzipMaybe(raw);
      bytes = g.bytes; fl = g.flags; name = 'note.txt';
    }
    if (bytes.length > p.cap) throw new Error(`payload ${bytes.length} B over cap`);
    txSrc = splitFile(bytes, p.block);
    txSession = (Math.random() * 0xffffffff) >>> 0;
    txSeq = 0; txName = name; flags = fl;
    $('txSession').textContent = txSession.toString(16);
    $('txBytes').textContent = bytes.length + ' B' + (fl & 1 ? ' gz' : '');
    $('txSeq').textContent = '0 / ' + txSrc.K;
    $('txEta').textContent = fmtEta(etaSec(bytes.length, p.block, p.fps));
    const tick = async () => {
      if (painting || !txSrc) return;
      painting = true;
      try {
        const droplet = makeDroplet(txSrc, txSession, txSeq, txName, flags);
        const px = $('qrWrap').classList.contains('fs') ? Math.min(900, Math.min(innerWidth, innerHeight) - 24) : 420;
        await window.paintFountainQR($('qrCanvas'), droplet, px);
        $('txSeq').textContent = txSeq + ' / ' + txSrc.K;
        txSeq++;
      } catch (e) {
        show('txErr', String(e.message || e), 'err');
        haltTx();
        setStreaming(false);
      } finally { painting = false; }
    };
    setStreaming(true);
    await tick();
    stopTx = startClock(p.fps, tick);
  } catch (e) {
    show('txErr', String(e.message || e), 'err');
    setStreaming(false);
  }
};

$('stopSend').onclick = () => {
  haltTx();
  setStreaming(false);
};

let camStream = null, camLoop = 0, decoder = createDecoder();
let dropN = 0, newN = 0, dupN = 0, finished = false;
let scanCtx = null;
let rxUiAt = 0;

const setCam = (on) => {
  $('startCam').classList.toggle('on', on);
  $('startCam').textContent = on ? 'Camera on' : 'Start camera';
  $('startCam').disabled = on;
  $('recv').classList.toggle('live', on);
};

const resetRx = () => {
  decoder = createDecoder();
  finished = false; dropN = newN = dupN = 0;
  $('doneBanner').classList.remove('on');
  $('dlLink').style.display = 'none';
  $('textOut').textContent = '';
  $('preview').removeAttribute('src');
  $('rxBar').style.width = '0';
  $('rxLock').textContent = '—';
  $('rxLock').className = '';
  $('rxSolved').textContent = '0/0';
  $('rxFrames').textContent = '0/0';
  $('rxDrop').textContent = '0';
};

const paintRx = (r, force) => {
  const now = performance.now();
  if (!force && now - rxUiAt < 125) return;
  rxUiAt = now;
  $('rxLock').textContent = r.meta ? 'LOCK' : '—';
  $('rxLock').className = r.meta ? 'ok' : '';
  $('rxSolved').textContent = (decoder.recovered || 0) + '/' + (r.K || 0);
  $('rxFrames').textContent = newN + '/' + dupN;
  $('rxDrop').textContent = dropN;
  if (r.K) $('rxBar').style.width = Math.min(100, (100 * decoder.recovered) / r.K) + '%';
};

const onText = async (text) => {
  const frame = unpackFrame(text);
  if (!frame) { dropN++; return; }
  let r = decoder.add(frame);
  if (r.reset) { resetRx(); r = decoder.add(frame); }
  if (r.dup) dupN++;
  else if (r.ok) newN++;
  paintRx(r, r.done);
  if (r.done && !finished) {
    finished = true;
    const got = decoder.assemble();
    if (!got) return;
    let bytes = got.bytes;
    try { bytes = await gunzipMaybe(bytes, got.flags); } catch {}
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const hash = await sha8(bytes);
    $('dlLink').href = url;
    $('dlLink').download = got.name || 'payload.bin';
    $('dlLink').style.display = 'inline-block';
    show('doneBanner', `Done — ${bytes.length} B · ${got.name} · sha ${hash}`, 'ok');
    $('textOut').textContent = new TextDecoder().decode(bytes.slice(0, 200));
    if ((got.name || '').match(/\.(png|jpe?g|gif|webp)$/i)) $('preview').src = url;
  }
};

const bindScan = () => {
  const canvas = $('camCanvas');
  if (canvas.width !== SCAN || !scanCtx) {
    canvas.width = SCAN;
    canvas.height = SCAN;
    scanCtx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  }
  return canvas;
};

const scan = () => {
  if (typeof jsQR !== 'function' || !scanCtx) return;
  const img = scanCtx.getImageData(0, 0, SCAN, SCAN);
  const code = jsQR(img.data, SCAN, SCAN, { inversionAttempts: 'dontInvert' });
  if (code && code.data) onText(code.data);
};

$('startCam').onclick = async () => {
  resetRx(); show('rxErr', '');
  try {
    await window.ensureJSQR();
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    show('rxErr', String(e.message || e), 'err');
    setCam(false);
    return;
  }
  const video = $('camVideo');
  video.srcObject = camStream;
  await video.play();
  setCam(true);
  bindScan();
  const loop = () => {
    camLoop = requestAnimationFrame(loop);
    if (video.readyState < 2) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !scanCtx) return;
    const side = Math.min(w, h);
    scanCtx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, SCAN, SCAN);
    scan();
  };
  loop();
};

$('stopCam').onclick = () => {
  cancelAnimationFrame(camLoop);
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  setCam(false);
};

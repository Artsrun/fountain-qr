# Fountain QR — Power of Light

Screen → camera file transfer. Luby peel. No file-path network.

- v2: https://artsrun.github.io/fountain-qr/
- v1 lab: https://artsrun.github.io/fountain-qr/demo.html
- Notes: https://artsrun.github.io/fountain-qr/notes.html

Not a port of [Decimen](https://decimen.app/). Different wire (`DCI2`). Phone-lock first, density as a preset.

Decimen peak (their receipts): ~200 KB/s phone-to-phone with QR v40 + zxing WASM + multi-code. This v2 stays in jsQR range so a handheld camera locks: Close preset ≈ 160 B × 20 fps ≈ 3 KB/s after JPEG/gzip shrink.

Paint is a 1px module bitmap, nearest-neighbor upscale, canvas size reused. Sender clock is rAF. Scan is 360², allocated once. Wire is still `DCI2`.

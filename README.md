# Fountain QR — Power of Light

Screen → camera file transfer. Luby peel. No file-path network.

- v2: https://artsrun.github.io/fountain-qr/
- v1 lab: https://artsrun.github.io/fountain-qr/demo.html
- Notes: https://artsrun.github.io/fountain-qr/notes.html

Not a port of [Decimen](https://decimen.app/). Send wire is `DCI3` (base45). Receivers still peel `DCI2`.

jsQR drops raw bytes above 127. v23 (about 640 B at ECC L) failed jsQR on three seeds. Ceiling that still locked after a 360² downscale:

| Preset | Block | fps | ECC | QR | Lab payload rate | Cap |
| --- | --- | --- | --- | --- | --- | --- |
| Far | 80 B | 10 | M | v10 | 0.8 KB/s | 256 KB |
| Phone | 240 B | 12 | M | v16 | 2.9 KB/s | 768 KB |
| Close | 400 B | 12 | M | v20 | 4.8 KB/s | 1.5 MB |
| Power | 960 B | 8 | L | v28 | 7.7 KB/s | 4 MB |

960 B passed 3 seeds at 4 px/module and again after draw into 360². 1040 B failed that downscale. Clean render, not a phone camera.

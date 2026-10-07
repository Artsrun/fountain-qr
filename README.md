# Fountain QR — Power of Light

Screen → camera file transfer. Luby peel. No file-path network.

- v2: https://artsrun.github.io/fountain-qr/
- v1 lab: https://artsrun.github.io/fountain-qr/demo.html
- Notes: https://artsrun.github.io/fountain-qr/notes.html

Not a port of [Decimen](https://decimen.app/). Phone-lock first, density as a preset.

Send wire is `DCI3` (base45, QR alphanumeric). Receivers still peel `DCI2`. jsQR drops raw bytes above 127, so the frame is not raw binary.

Clean-render lab, jsQR, 4 px/module, not a phone camera:

| Preset | Block | fps | ECC | QR | Payload rate |
| --- | --- | --- | --- | --- | --- |
| Far | 80 B | 10 | M | v10 | 0.8 KB/s |
| Phone | 200 B | 12 | M | v15 | 2.4 KB/s |
| Close | 340 B | 12 | M | v19 | 4.1 KB/s |
| Power | 560 B | 10 | L | v21 | 5.6 KB/s |

Caps: 256 KB / 512 KB / 1 MB / 2 MB. A 560 B block at ECC L failed jsQR in this lab; 560 B passed.

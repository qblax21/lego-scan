# LEGO Scan (step 1: standalone scanner)

Phone-first PWA. Scans EAN-13 / UPC-A box barcodes, keeps a local list, works offline.
Google Sheets and set-number lookup come in later steps. See `lego-scanner-spec.md`.

## Try it on your computer
```
py serve.py
```
Open http://localhost:8080. `localhost` counts as secure, so the camera works there.
Manual entry works without a camera: type `75192` (set) or a 13-digit barcode.

## Try it on your iPhone
iOS only allows the camera on HTTPS pages, so a local-network address will not work.
Deploy to GitHub Pages (free, HTTPS):
1. Create a free account at github.com.
2. New repository -> name `lego-scan` -> Public -> Create.
3. "uploading an existing file" -> drag in everything in this folder (`index.html`, `app.js`, `sw.js`,
   `style.css`, `manifest.webmanifest`, `icons/`, `vendor/`). Do NOT upload `lego-scanner-spec.md` or `serve.py` if you prefer. Commit.
4. Settings -> Pages -> Source: "Deploy from a branch" -> `main` / root -> Save.
5. After about a minute your app is at `https://<username>.github.io/lego-scan/`.
6. Open it in Safari -> Share -> Add to Home Screen.

## License
MIT, Copyright (c) 2026 Quinn Brownell. See `LICENSE`.
Bundles [@zxing/library](https://github.com/zxing-js/library) 0.21.3 (MIT) in `vendor/zxing.min.js`.
Brickset lookups (coming in step 2) need your own free Brickset API key; none is included.

## Notes
- Data lives in the phone's localStorage. Use "Export CSV" as a backup.
- Tap a "needs set number" row to type in the set number.
- Never put your Brickset key in this repo. It will live in the Apps Script (step 2).

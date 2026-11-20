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

## Google Sheets + barcode lookup (optional, personal)
The scanner works without this. To connect your own sheet:
1. Open your sheet -> Extensions -> Apps Script. Replace the code with `apps-script/Code.gs`.
2. Project Settings (gear) -> Script properties -> add `SECRET` (a long random string you make up)
   and `BRICKSET_KEY` (your free key from brickset.com). These are never in the code or repo.
3. Deploy -> New deployment -> type "Web app" -> Execute as: Me -> Who has access: Anyone -> Deploy.
   Authorize when asked, then copy the web app URL.
4. In the app tap "Sheets", paste the URL, then the secret. Both stay on your phone only.
The app also pulls the whole Lookup Cache on launch and after syncs, so known barcodes match offline and cost no Brickset call.
The footer shows "Brickset lookups used today: N/100" (the script's own count, UTC day).
New scans go to the "Scan Staging" tab (never your main tabs); lookups are cached in "Lookup Cache".
Brickset allows about 100 lookups per day per key; cached barcodes cost nothing.

### Recount mode
Switch the app to **Recount**: each scan adds one to that set's tally (with + / - buttons) and syncs to a **Recount** tab
instead of Scan Staging. **New recount** clears the tally and the Recount tab. In the sheet, **LEGO Scan -> Compare recount
to inventory** writes a **Recount Compare** tab: per set, Counted, Personal Qty, Sale Qty and Difference
(Counted - Personal - Sale). The inventory tabs are only read, never changed.

### Moving staged rows into your inventory
Reload the sheet after updating the script; a **LEGO Scan** menu appears. In `Scan Staging`, select the rows
to move, then **LEGO Scan -> Move selected staging rows to inventory**. Rows go to the Personal or Sale tab
that matches their Destination, with only the columns that tab already has. Sale formulas (Strike Price,
Profit, ROI %) and the Fee % / Target Profit defaults are copied from the row above. Moved rows stay in staging
marked "Moved to ..."; rows still needing a set number are skipped.

### Market values (Update values menu)
Open Personal Inventory or Sale Inventory, select rows, then **LEGO Scan -> Update values for selected rows (Brickset)**.
It reads each set's Brickset page (Brickset's API has no market value). Sealed/New use the "New" Current value,
everything else the "Used" value. A set that is not retired yet and has no market value falls back to the US retail
price ("Retail fallback"); a retired set (or one with no exit date) with no market value is left blank and flagged.
Personal gets Value of One plus Est. Current Value (= Value of One x Qty); Sale gets Est. Sale Price.
If any selected row already has a value you are asked whether to overwrite or only fill the empty ones.
Two columns are added to the tab: **Value Source** (Brickset New / Brickset Used / Retail fallback, or the reason it is
blank) and **Value Updated** (date). Three blocked requests in a row stop the run; the summary lists
updated / skipped / no price / fetch blocked.
To make a button: Insert -> Drawing, draw a shape, Save, then its three-dot menu -> Assign script -> `updateValues`.

## License
MIT, Copyright (c) 2026 Quinn Brownell. See `LICENSE`.
Bundles [@zxing/library](https://github.com/zxing-js/library) 0.21.3 (MIT) in `vendor/zxing.min.js`.
Brickset lookups (coming in step 2) need your own free Brickset API key; none is included.

## Notes
- Data lives in the phone's localStorage. Use "Export CSV" as a backup.
- Tap a "needs set number" row to type in the set number.
- Never put your Brickset key in this repo. It will live in the Apps Script (step 2).

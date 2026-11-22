# STATUS

Last updated: 2026-11-22. Latest pushed feature commit: 7909b74 (sync-stall fix), service worker cache `lego-scan-v14`.

## Goal
A phone-first PWA (iPhone Safari, added to Home Screen) that scans LEGO box barcodes (EAN-13 / UPC-A), finds the set
via Brickset, and logs it. Standalone and open source (MIT, Quinn Brownell). An optional personal Google Sheets backend
(Apps Script) stages scans for the owner's "LEGO spreadsheet". Live at https://qblax21.github.io/lego-scan/
(repo `qblax21/lego-scan`, public). Also a GitHub learning project for the owner.

## Current state
All requested features are built and pushed:
- Scanner: native BarcodeDetector where available, ZXing fallback (vendored 0.21.3) with crop, downscale and TRY_HARDER passes; Debug readout.
- Scan flow: barcode -> lookup (Lookup Cache first, then Brickset) -> on miss a set-number prompt -> bind -> row added.
- Destinations: Personal (Sealed, Open Box, Used, Damaged, Missing Pieces, Built) and Sale (New, Used, Damaged); optional "More details" fields.
- Recount mode: per-set tally with +/-, synced to a Recount tab; sheet menu writes a Recount Compare tab (inventory only read).
- Sheet menu (LEGO Scan): Move selected staging rows to inventory; Update values (Brickset page market value, retail fallback only for non-retired sets, Value Source / Value Updated columns); Compare recount to inventory.
- Sync is split into independent steps (bind, names, lookup, remove, upload, recount). One failing step never blocks upload. Failures persist in the footer status line until that step succeeds; tapping it retries now.
- Nameless rows (set number, no name) are retried by number via `bind`: once per set per day, deduped, never for sets Brickset said it lacks, stopped at 80/100 daily calls.
- Brickset daily count shown in the footer ("N/100").

## Key files
- `index.html`, `style.css`, `app.js` - the whole app (state in localStorage).
- `sw.js` - service worker; bump `CACHE` (`lego-scan-vN`) on every release or phones keep old files.
- `apps-script/Code.gs` - Apps Script web app + sheet menus; pasted manually into the sheet's script editor.
- `vendor/zxing.min.js`, `icons/`, `manifest.webmanifest`, `serve.py` (local dev, port 8080).
- `README.md` (user docs), `TEST_PLAN.md` (older), `lego-scanner-spec.md` (original spec), `CLAUDE.md` (build/deploy steps).

## Decisions
- Writes only to "Scan Staging", "Lookup Cache", "Recount", "Recount Compare"; never directly into Personal/Sale Inventory (only via the Move menu, which the user triggers).
- Brickset key and the shared SECRET live only in Apps Script Script Properties; the app stores the script URL and secret on the phone only.
- POST with `Content-Type: text/plain` JSON to avoid CORS preflight.
- Brickset API has no market value, so values are read from the public set page (New/Used current value; RRP only if not retired).
- UPC is stored as 12 digits at Brickset, so a 0-prefixed 13-digit barcode is queried as 12 digits first.
- iOS pauses the camera under native confirm/prompt, so all dialogs are in-page.
- Numeric keypad has no hyphen, so set numbers accept `75192` and default to `-1`; variants typed as `75192-2` are stored as `75192` for name retries (looked up as `-1`).

## Open bugs / unverified
- Nothing has been run on the real iPhone camera or against the user's real deployed script; tests used a desktop browser with fake backends and synthetic frames.
- Scanning speed/reliability of the ZXing path on a real phone is unmeasured.
- Name retry for a variant set (`-2`) looks up `-1`, which may return a different name.
- Commit 79706ea has a malformed author email (not rewritten; harmless).
- Brickset page scraping (Update values) can break if Brickset changes its markup or blocks Apps Script's IP.
- The user's deployed script must be redeployed as a new version to get the latest `Code.gs`; until then the app shows "unknown action" for `bind`/`cache`/`recount`.

## Next steps
1. User pastes the latest `Code.gs`, redeploys as a new version, and fully closes/reopens the app to get service worker v14.
2. Run the short test steps (old script, fixed script, Brickset error, offline name fill) on the real phone.
3. Report real-device scanner behavior; tune crop/frame rate if needed.
4. Optional: public multi-user version (logins, per-user history) - discussed, not started.

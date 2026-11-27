# STATUS

Last updated: 2026-11-27. Latest feature commits: 2928e09 (version handshake), a4c0d6a (scan test), a66c61b (variant names), 3a60042 (inventory data check). Service worker cache `lego-scan-v15`. App expects Code.gs `SCRIPT_VERSION` 3.

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
- Version handshake: `Code.gs` has `SCRIPT_VERSION` and a `version` action; the app (`APP_VERSION`, `EXPECTED_SCRIPT` in `app.js`) calls it on launch and before each sync (re-checks at most every 2 min when OK). A missing action or older version shows a banner "Sheet script is out of date. In the script editor: Deploy > Manage deployments > New version." Sync still runs. Debug readout shows app and script versions. When the script API changes, bump both `SCRIPT_VERSION` and `EXPECTED_SCRIPT`.
- Scan test (Debug -> "Scan test"): off by default, in memory only. Logs every decode attempt (native vs ZXing, fast vs TRY_HARDER, ms, ok/fail), time from "Next box" to first read, duplicate reads; summary (median ms, reads/min, % read within 2 s) and "Copy results". While on, reads are only logged (nothing added, no lookups). The 5-minute routine is in `TEST_PLAN.md`.
- Variant sets: `75192-2` is stored as `75192-2` (variant 1 stays plain `75192`), looked up as exactly `-2`, and `-1` is only the default when no variant is typed. `Code.gs` accepts only a Brickset result whose `numberVariant` matches; otherwise the name stays blank, the set is remembered as a miss and the row is flagged in the list.
- Sheet menu "Check inventory data": reads Personal/Sale Inventory (never writes them) and rewrites a "Data Check" tab with a count per issue and the row numbers (missing set/name, bad set format, same set in both tabs, duplicate rows, name differs from Lookup Cache, blank value, value older than 30 days or no Value Updated).
- `tests.html` (open at http://localhost:8080/tests.html via `py serve.py`): browser tests that run the real app against a fake backend and run `Code.gs` functions with stubbed Google services (version handshake, scan test, variants, inventory check). 55 checks passed on 2026-11-27.

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
- Numeric keypad has no hyphen, so set numbers accept `75192` and default to `-1`; a typed variant (`75192-2`) is kept and looked up exactly; with none typed the lookup defaults to `-1`.

## Open bugs / unverified
- Nothing has been run on the real iPhone camera or against the user's real deployed script; tests used a desktop browser with fake backends and synthetic frames.
- Scanning speed/reliability of the ZXing path on a real phone is unmeasured.
- Variant fix is only tested with fake backends. Variant sets now appear in the sheet's Set # as `75192-2` (not plain `75192`); `Compare recount` still strips the variant, the new data check treats variants as different sets.
- Data check name rule: any inventory name that is not (case/space-insensitively) a Lookup Cache name for that set is flagged, so short or customised names will show up; adjust if too noisy. `checkInventoryData` has only been run against a fake spreadsheet, not the real sheet.
- Commit 79706ea has a malformed author email (not rewritten; harmless).
- Brickset page scraping (Update values) can break if Brickset changes its markup or blocks Apps Script's IP.
- The user's deployed script must be redeployed as a new version to get the latest `Code.gs`; until then the app shows "unknown action" for `bind`/`cache`/`recount`.

## Next steps
1. User pastes the latest `Code.gs` (SCRIPT_VERSION 3), redeploys as a new version, reloads the sheet, and fully closes/reopens the app to get service worker v15. Banner should be absent and Debug should show `script v3`.
2. Run the 5-minute scan test on 10 boxes (`TEST_PLAN.md`), paste the Copy results text back; tune crop/frame rate/passes from it.
3. Run LEGO Scan > Check inventory data on the real sheet and review the Data Check tab; tune noisy checks.
4. Run the short test steps (old script, fixed script, Brickset error, offline name fill) on the real phone.
4. Optional: public multi-user version (logins, per-user history) - discussed, not started.

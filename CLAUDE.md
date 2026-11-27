# CLAUDE.md

Project: LEGO Scan, a static PWA plus an optional Google Apps Script backend. See `STATUS.md` for state and `README.md` for user docs.

## Layout
- `index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, `icons/`, `vendor/zxing.min.js` - the app (no build step, no npm).
- `apps-script/Code.gs` - backend, pasted by hand into the sheet's Apps Script editor.
- `serve.py` - local static server.

## Build
There is no build. Edit files directly.

## Run locally
```
py serve.py
```
Open http://localhost:8080 (localhost counts as secure, so the camera works). Manual entry works without a camera: type `75192` or a 13-digit barcode.
iPhone camera needs HTTPS, so test on the deployed GitHub Pages URL.

## Release checklist (every change to app files)
1. Bump `CACHE` in `sw.js` (`lego-scan-vN` -> `vN+1`). Without this phones keep serving old files.
2. If the API between app and script changed, also update `apps-script/Code.gs` and the header comment listing actions.
3. Commit and push (below). GitHub Pages republishes in about a minute.
4. On the phone: fully close and reopen the app (swipe away from the app switcher) so the new service worker takes over.

## Deploy / push
GitHub Pages serves `main` of `qblax21/lego-scan` at https://qblax21.github.io/lego-scan/.
The working folder is not a git repo; a helper script clones the repo, copies whitelisted files, commits and pushes:
```
powershell -File "<scratchpad>\push.ps1" -Message "commit message"
```
The scratchpad copy of `push.ps1` is session-specific; if missing, recreate it (clone `qblax21/lego-scan`, copy files, `git add -A`, commit, push).
Whitelist in the script: `app.js index.html style.css sw.js manifest.webmanifest README.md TEST_PLAN.md STATUS.md CLAUDE.md LICENSE serve.py tests.html apps-script\Code.gs icons\ vendor\`.
Git author: `Quinn Brownell`, email `<github user id>+qblax21@users.noreply.github.com`.
Commit messages end with the Co-Authored-By line given by the session.
Do not push secrets. The Brickset key and the SECRET never go in files.

## Paste / redeploy Code.gs (the user does this; Apps Script cannot be pushed from here)
Whenever `apps-script/Code.gs` changes:
1. Open the Google Sheet -> Extensions -> Apps Script.
2. Select all in the editor, delete, paste the new `Code.gs`, Save.
3. Deploy -> Manage deployments -> pencil (edit) -> Version: **New version** -> Deploy. The web app URL stays the same.
   Saving alone does NOT update the live web app.
4. First time only: Project Settings -> Script properties: add `SECRET` (long random string) and `BRICKSET_KEY`.
   Deploy -> New deployment -> Web app, Execute as: Me, Who has access: Anyone; authorize; copy the URL.
5. In the app tap "Sheets" and paste the URL and the secret (stored only on that phone).
6. Reload the sheet so the **LEGO Scan** menu appears.
Symptom of a stale deployment: the app footer shows "Sync problem: ... unknown action (redeploy Code.gs as a new version)".

## Gotchas
- Brickset allows about 100 `getSets` calls per day. The script counts them (`bsUsed`); the app stops optional retries at 80.
- Brickset `getSets` needs `userHash` present but empty; the body is built by hand in `bricksetGetSets`.
- Apps Script requests use `Content-Type: text/plain` (avoids CORS preflight).
- iOS: native `confirm`/`prompt` freezes the camera; use the in-page dialogs (`ask`, `#dlgSet`).
- Sync steps must stay isolated (`step()` in `sync()`); never let a bind/lookup failure block `upsert`.
- Never write into "Personal Inventory"/"Sale Inventory" from the scan path; only the Move menu does that.
- Do not edit the user's inventory column layout; the script only writes columns that already exist.

## Testing
With `py serve.py` running, open http://localhost:8080/tests.html: browser tests that run the real app against a fake backend and run `Code.gs` with stubbed Google services. The tab title says PASS or FAIL. Run it after any change to `app.js` or `Code.gs`.
When the script's API or behaviour changes, bump `SCRIPT_VERSION` in `Code.gs` and `EXPECTED_SCRIPT` in `app.js` together (the tests check they match).
No other automated tests. Earlier verification used with a desktop browser using fake backends (old script, Brickset error, nameless retry, quota cutoff). See `TEST_PLAN.md` (older) and the test steps in `STATUS.md` next steps.

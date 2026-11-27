# Test plan

Run on an iPhone with the app on the home screen and Sheets connected.

1. **Known set box**: scan a sealed LEGO box. Expect a beep and flash, the message "Added set N - Name", a "matched" row,
   and a new row in `Scan Staging` (Status "OK") plus a row in `Lookup Cache`.
2. **Cached repeat**: scan a different copy of the same set in the other destination (Sale). The lookup should be instant
   and no new row should appear in `Lookup Cache`.
3. **Unknown barcode**: type `9999999999994` in the manual box. Expect "not found in Brickset", an orange "needs set number" row,
   and `Scan Staging` Status "Needs set number". Tap the row, enter a set number, and the row updates in the sheet.
4. **Duplicate**: scan the same set again in the same destination. Expect a prompt to add 1. Accept and check that Qty becomes 2 in the
   same sheet row. Hold the camera on one box for several seconds and confirm it records only once.
5. **Offline**: turn on airplane mode, scan a box. Expect "saved ... needs set number" or a saved row and "waiting to sync".
   Turn airplane mode off, wait up to 30 s, and check that the rows reach `Scan Staging` and the set number is filled in.
6. **Undo**: tap "Undo last" and check the row disappears from the app and from `Scan Staging`.
7. **Manual set number**: type `75192`; it is added as "saved".
8. **Bad secret**: change the secret in the Sheets box to a wrong value. Expect "Sync failed: unauthorized"; scans stay on the phone.

## Scan speed test (5 minutes, 10 boxes)

Needs the real iPhone and 10 different boxes (mix of sizes, a couple glossy or curved ones). Nothing is added to your list
or sheet while Scan test is on: reads are only logged.

1. Open the app, tap **Debug**, then **Scan test: off** (it turns ON). Prop the phone on a stand or lean it on something so
   both hands are free. Same light and distance for every box.
2. For each of the 10 boxes: tap **Next box**, then straight away raise the box to the aiming frame and hold it still.
   Wait for the beep, then lower it. (Do not tap Next box until the box is out of view.)
   Timer starts at the tap, so it includes about 1 s of moving the box in. That is the same for every box, so the
   numbers are still comparable between runs.
3. If a box has not beeped after 10 s, move on to the next box (it counts as not read).
4. After box 10, tap **Copy results** and paste the text to Claude. Tap **Reset** to start another run (e.g. after a change).
5. Note anything odd: glare, which boxes were slow, whether the camera ever froze.

What the numbers mean: median ms = how long one decode attempt takes; reads/min = boxes read per minute across the run;
"read within 2 s" = share of boxes beeping within 2 s of Next box; per-pass lines show native vs ZXing fast vs TRY_HARDER
tries and hits; duplicate reads = the same box decoded again before the next Next box.

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

/**
 * LEGO Scan backend (Google Apps Script web app, bound to your sheet).
 *
 * Script Properties (Project Settings > Script properties) - set these by hand, never in code:
 *   SECRET        a long random string; the app sends it with every request
 *   BRICKSET_KEY  your Brickset API key
 *
 * Requests are POSTed as text/plain JSON: { token, action, ... }
 *   lookup  { barcode }          -> { ok, found, setNumber, name, theme, year }
 *   upsert  { scans: [...] }     -> { ok, count }   (insert, or update by Scan ID)
 *   remove  { ids: [...] }       -> { ok, count }
 */
const STAGING = 'Scan Staging';
const CACHE = 'Lookup Cache';
const COLS = ['Timestamp', 'Destination', 'Set #', 'Set Name', 'Theme', 'Year', 'Qty', 'Condition', 'Barcode', 'Status', 'Scan ID'];

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  const secret = props.getProperty('SECRET');
  if (!secret || req.token !== secret) return out({ ok: false, error: 'unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (req.action === 'lookup') return out(lookup(String(req.barcode || ''), props.getProperty('BRICKSET_KEY')));
    if (req.action === 'upsert') return out(upsert(req.scans || []));
    if (req.action === 'remove') return out(remove(req.ids || []));
    return out({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() { return out({ ok: true, service: 'lego-scan' }); }

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}

// ---------- lookup ----------
function lookup(barcode, key) {
  if (!/^\d{12,13}$/.test(barcode)) return { ok: true, found: false };
  const cache = sheet(CACHE, ['Barcode', 'Set #', 'Set Name', 'Theme', 'Year', 'Cached At']);
  const last = cache.getLastRow();
  if (last > 1) {
    const rows = cache.getRange(2, 1, last - 1, 5).getDisplayValues();
    const hit = rows.find(r => r[0] === barcode);
    if (hit) return { ok: true, found: true, cached: true, setNumber: hit[1], name: hit[2], theme: hit[3], year: hit[4] };
  }
  if (!key) return { ok: false, error: 'BRICKSET_KEY not set' };

  // Brickset stores EAN-13 as-is and UPC-A as 12 digits, so try the 13-digit form first,
  // then the 12-digit form when the code starts with 0. (Undocumented but verified.)
  const tries = [barcode];
  if (barcode.length === 13 && barcode[0] === '0') tries.push(barcode.slice(1));
  for (const q of tries) {
    const set = bricksetQuery(q, key);
    if (set) {
      const rec = { setNumber: set.number, name: set.name, theme: set.theme || '', year: set.year || '' };
      const fmt = cache.getRange(cache.getLastRow() + 1, 1, 1, 6);
      fmt.setNumberFormat('@');
      fmt.setValues([[barcode, rec.setNumber, rec.name, rec.theme, String(rec.year), new Date().toISOString()]]);
      return Object.assign({ ok: true, found: true }, rec);
    }
  }
  return { ok: true, found: false };
}

function bricksetQuery(q, key) {
  const res = UrlFetchApp.fetch('https://brickset.com/api/v3.asmx/getSets', {
    method: 'post',
    payload: { apiKey: key, userHash: '', params: JSON.stringify({ query: q, pageSize: 5 }) },
    muteHttpExceptions: true,
  });
  const j = JSON.parse(res.getContentText());
  if (j.status !== 'success') throw new Error('Brickset: ' + (j.message || j.status));
  // Only accept a set whose stored barcode really equals the query, so a text match can't mislabel a scan.
  const hit = (j.sets || []).find(s => s.barcode && (s.barcode.EAN === q || s.barcode.UPC === q));
  return hit || null;
}

// ---------- staging rows ----------
function upsert(scans) {
  const sh = sheet(STAGING, COLS);
  const idCol = COLS.indexOf('Scan ID') + 1;
  const last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, idCol, last - 1, 1).getDisplayValues().map(r => r[0]) : [];
  let n = 0;
  scans.forEach(s => {
    const row = [new Date(s.ts), s.dest, s.setNumber || '', s.name || '', s.theme || '', s.year || '',
      s.qty, s.condition || '', s.barcode || '', s.status === 'needs' ? 'Needs set number' : 'OK', s.id];
    const i = ids.indexOf(s.id);
    const r = i >= 0 ? i + 2 : sh.getLastRow() + 1;
    if (i < 0) ids.push(s.id);
    const rng = sh.getRange(r, 1, 1, COLS.length);
    sh.getRange(r, 3).setNumberFormat('@');
    sh.getRange(r, 9).setNumberFormat('@');
    sh.getRange(r, 11).setNumberFormat('@');
    rng.setValues([row]);
    n++;
  });
  return { ok: true, count: n };
}

function remove(idsToRemove) {
  const sh = sheet(STAGING, COLS);
  const idCol = COLS.indexOf('Scan ID') + 1;
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, count: 0 };
  const ids = sh.getRange(2, idCol, last - 1, 1).getDisplayValues().map(r => r[0]);
  let n = 0;
  for (let i = ids.length - 1; i >= 0; i--) {
    if (idsToRemove.indexOf(ids[i]) >= 0) { sh.deleteRow(i + 2); n++; }
  }
  return { ok: true, count: n };
}

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
const COLS = ['Timestamp', 'Destination', 'Set #', 'Set Name', 'Theme', 'Year', 'Qty', 'Condition', 'Barcode', 'Status', 'Scan ID',
  'Bought For', 'Purchase Date', 'Location', 'Est. Value', 'Box Cond.', 'Complete?', 'Est. Sale Price', 'Shipping', 'Prep Cost',
  'Listing Status', 'Notes'];
// App field key -> staging column header
const EXTRA = { boughtFor: 'Bought For', purchaseDate: 'Purchase Date', location: 'Location', estValue: 'Est. Value',
  boxCond: 'Box Cond.', complete: 'Complete?', estSalePrice: 'Est. Sale Price', shipping: 'Shipping', prepCost: 'Prep Cost',
  listingStatus: 'Listing Status', notes: 'Notes' };

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  const secret = props.getProperty('SECRET');
  if (!secret || req.token !== secret) return out({ ok: false, error: 'unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (req.action === 'lookup') return out(lookup(String(req.barcode || ''), (props.getProperty('BRICKSET_KEY') || '').trim()));
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
  // Built by hand: Brickset 500s if userHash is missing, and an object payload drops empty values.
  const body = 'apiKey=' + encodeURIComponent(key) + '&userHash=' +
    '&params=' + encodeURIComponent(JSON.stringify({ query: q, pageSize: 5 }));
  const res = UrlFetchApp.fetch('https://brickset.com/api/v3.asmx/getSets', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: body,
    muteHttpExceptions: true,
  });
  const text = res.getContentText();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('Brickset HTTP ' + res.getResponseCode() + ': ' + text.slice(0, 120)); }
  if (j.status !== 'success') throw new Error('Brickset: ' + (j.message || j.status));
  // Only accept a set whose stored barcode really equals the query, so a text match can't mislabel a scan.
  const hit = (j.sets || []).find(s => s.barcode && (s.barcode.EAN === q || s.barcode.UPC === q));
  return hit || null;
}

// ---------- staging rows ----------
function upsert(scans) {
  const sh = sheet(STAGING, COLS);
  if (sh.getMaxColumns() < COLS.length) sh.insertColumnsAfter(sh.getMaxColumns(), COLS.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, COLS.length).setValues([COLS]); // keep headers in sync with this script
  const idCol = COLS.indexOf('Scan ID') + 1;
  const last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, idCol, last - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const statusCol = COLS.indexOf('Status') + 1;
  const statuses = last > 1 ? sh.getRange(2, statusCol, last - 1, 1).getDisplayValues().map(r => r[0]) : [];
  let n = 0;
  scans.forEach(s => {
    const k = ids.indexOf(s.id);
    if (k >= 0 && /^Moved/.test(statuses[k])) return; // already moved to inventory; don't resurrect or double-count
    const x = s.extra || {};
    const extraCols = Object.keys(EXTRA).reduce((o, k) => { o[EXTRA[k]] = x[k] || ''; return o; }, {});
    const base = { 'Timestamp': new Date(s.ts), 'Destination': s.dest, 'Set #': s.setNumber || '', 'Set Name': s.name || '',
      'Theme': s.theme || '', 'Year': s.year || '', 'Qty': s.qty, 'Condition': s.condition || '', 'Barcode': s.barcode || '',
      'Status': s.status === 'needs' ? 'Needs set number' : 'OK', 'Scan ID': s.id };
    const vals = Object.assign({}, extraCols, base);
    const row = COLS.map(c => vals[c]);
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
  const statusCol = COLS.indexOf('Status') + 1;
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, count: 0 };
  const ids = sh.getRange(2, idCol, last - 1, 1).getDisplayValues().map(r => r[0]);
  const statuses = sh.getRange(2, statusCol, last - 1, 1).getDisplayValues().map(r => r[0]);
  let n = 0;
  for (let i = ids.length - 1; i >= 0; i--) {
    if (idsToRemove.indexOf(ids[i]) >= 0 && !/^Moved/.test(statuses[i])) { sh.deleteRow(i + 2); n++; }
  }
  return { ok: true, count: n };
}

// ---------- menu: move staging rows into the real inventory tabs ----------
// Only columns that exist in the target tab are written. Cells the scanner has no value for stay blank,
// except the Sale tab's per-row formulas (copied from the row above) and its Fee % / Target Profit defaults.
const TARGETS = {
  Personal: {
    tab: 'Personal Inventory', key: 'Set #', formulas: [], defaults: [],
    map: { 'Item': 'Set Name', 'Category': '@theme', 'Set #': 'Set #', 'Qty': 'Qty', 'Condition': 'Condition',
      'Bought For': 'Bought For', 'Purchase Date': 'Purchase Date', 'Estimated Current Value': 'Est. Value',
      'Location': 'Location', 'Notes': 'Notes' },
  },
  Sale: {
    tab: 'Sale Inventory', key: 'Set #', formulas: ['Strike Price', 'Profit', 'ROI %'], defaults: ['Fee %', 'Target Profit'],
    map: { 'Set #': 'Set #', 'Set Name': 'Set Name', 'Theme': '@theme', 'Qty': 'Qty', 'Condition': 'Condition',
      'Box Cond.': 'Box Cond.', 'Complete?': 'Complete?', 'Bought For': 'Bought For', 'Purchase Date': 'Purchase Date',
      'Est. Sale Price': 'Est. Sale Price', 'Shipping': 'Shipping', 'Prep Cost': 'Prep Cost',
      'Status': 'Listing Status', 'Notes': 'Notes' },
  },
};
// Brickset theme name (lowercase) -> the word your dropdowns use. Anything not in your list is left blank.
const THEME_ALIAS = { 'marvel super heroes': 'Marvel', 'the lord of the rings': 'LOTR', 'lord of the rings': 'LOTR',
  'botanical collection': 'Botanicals', 'formula 1': 'F1', 'creator expert': 'Creator', 'creator 3-in-1': 'Creator' };

function onOpen() {
  SpreadsheetApp.getUi().createMenu('LEGO Scan')
    .addItem('Move selected staging rows to inventory', 'moveSelected')
    .addToUi();
}

function listFor(sh, row, col) { // allowed dropdown values for a column, read from an existing row
  const rule = sh.getRange(row, col).getDataValidation();
  if (!rule || rule.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) return null;
  return rule.getCriteriaValues()[0];
}
function pick(list, value) { // case-insensitive match against a dropdown list
  const v = String(value).trim().toLowerCase();
  return (list || []).find(x => String(x).toLowerCase() === v) || null;
}

function moveSelected() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const st = ss.getSheetByName(STAGING);
  if (!st || ss.getActiveSheet().getName() !== STAGING) {
    ui.alert('Open the "' + STAGING + '" tab and select the rows to move first.'); return;
  }
  const list = ss.getActiveRangeList();
  const ranges = list ? list.getRanges() : [ss.getActiveRange()];
  const rowNums = {};
  ranges.forEach(r => { for (let i = r.getRow(); i < r.getRow() + r.getNumRows(); i++) if (i >= 2) rowNums[i] = true; });
  const rows = Object.keys(rowNums).map(Number).sort((a, b) => a - b);
  if (!rows.length) { ui.alert('Select one or more scan rows (not the header) first.'); return; }

  const hdr = st.getRange(1, 1, 1, st.getLastColumn()).getValues()[0];
  const todo = [], skipped = [];
  rows.forEach(r => {
    const vals = st.getRange(r, 1, 1, hdr.length).getValues()[0];
    const o = {}; hdr.forEach((h, i) => { o[h] = vals[i]; });
    o._row = r;
    if (/^Moved/.test(o['Status'])) skipped.push('row ' + r + ': already moved');
    else if (o['Status'] === 'Needs set number' || !String(o['Set #']).trim()) skipped.push('row ' + r + ': needs a set number first');
    else if (!TARGETS[o['Destination']]) skipped.push('row ' + r + ': unknown destination');
    else todo.push(o);
  });
  if (!todo.length) { ui.alert('Nothing to move.\n\n' + skipped.join('\n')); return; }

  const per = todo.filter(o => o['Destination'] === 'Personal').length;
  const msg = 'Move ' + todo.length + ' row(s)? (' + per + ' to Personal Inventory, ' + (todo.length - per) + ' to Sale Inventory)' +
    (skipped.length ? '\n\nSkipping:\n' + skipped.join('\n') : '');
  if (ui.alert('Move to inventory', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  const notes = [];
  try {
    todo.forEach(o => {
      const t = TARGETS[o['Destination']];
      const res = appendToInventory(ss, t, o);
      st.getRange(o._row, hdr.indexOf('Status') + 1).setValue('Moved to ' + t.tab + ' (row ' + res.row + ')');
      if (res.dupe) notes.push(o['Set #'] + ' (' + (o['Condition'] || 'no condition') + ') was already in ' + t.tab + ' - added as a separate row.');
      if (res.blankTheme) notes.push(o['Set #'] + ': theme "' + o['Theme'] + '" is not in your ' + t.tab + ' dropdown, left blank.');
    });
  } finally {
    lock.releaseLock();
  }
  ui.alert('Moved ' + todo.length + ' row(s).' + (notes.length ? '\n\n' + notes.join('\n') : ''));
}

function appendToInventory(ss, t, o) {
  const sh = ss.getSheetByName(t.tab);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const idx = name => head.indexOf(name) + 1;
  const keyCol = idx(t.key);

  // last row that really holds data (the key column), ignoring pre-formatted empty rows
  const keyVals = sh.getRange(1, keyCol, sh.getMaxRows(), 1).getDisplayValues();
  let last = 1, dupe = false;
  const setNum = String(o['Set #']).trim(), cond = String(o['Condition'] || '').toLowerCase();
  const condCol = idx('Condition');
  const condVals = condCol ? sh.getRange(1, condCol, sh.getMaxRows(), 1).getDisplayValues() : [];
  keyVals.forEach((r, i) => {
    if (String(r[0]).trim() !== '') last = i + 1;
    if (i > 0 && String(r[0]).trim() === setNum && (!condCol || String(condVals[i][0]).toLowerCase() === cond)) dupe = true;
  });
  const newRow = last + 1;
  if (newRow > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);

  const src = sh.getRange(last, 1, 1, head.length), dst = sh.getRange(newRow, 1, 1, head.length);
  src.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  src.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);

  t.formulas.forEach(name => {
    const c = idx(name); if (!c) return;
    const f = sh.getRange(last, c).getFormulaR1C1();
    if (f) sh.getRange(newRow, c).setFormulaR1C1(f);
  });
  t.defaults.forEach(name => {
    const c = idx(name); if (c) sh.getRange(newRow, c).setValue(sh.getRange(last, c).getValue());
  });

  let blankTheme = false;
  head.forEach((h, i) => {
    const from = t.map[h]; if (!from) return;
    let v = from === '@theme' ? o['Theme'] : o[from];
    if (v === '' || v === null || v === undefined) return;
    const allowed = listFor(sh, last, i + 1);
    if (from === '@theme') {
      const theme = THEME_ALIAS[String(v).toLowerCase()] || v;
      v = pick(allowed, theme);
      if (!v) { blankTheme = true; return; }
    } else if (allowed) {
      v = pick(allowed, v) || v; // fix capitalisation, e.g. "Open box" -> "Open Box"
    }
    const cell = sh.getRange(newRow, i + 1);
    if (h === 'Set #') cell.setNumberFormat('@');
    cell.setValue(v);
  });
  return { row: newRow, dupe: dupe, blankTheme: blankTheme };
}

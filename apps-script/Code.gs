/**
 * LEGO Scan backend (Google Apps Script web app, bound to your sheet).
 *
 * Script Properties (Project Settings > Script properties) - set these by hand, never in code:
 *   SECRET        a long random string; the app sends it with every request
 *   BRICKSET_KEY  your Brickset API key
 *
 * Requests are POSTed as text/plain JSON: { token, action, ... }
 *   lookup  { barcode }          -> { ok, found, setNumber, name, theme, year }
 *   bind    { barcode?, setNumber } -> same shape; looks the set up by number and caches barcode -> set
 *   cache   {}                   -> { ok, rows: [{ barcode, setNumber, name, theme, year }] }  (all Lookup Cache rows)
 * Every response also carries bsUsed: Brickset API calls made by this script today (UTC).
 * lookup() reads the Lookup Cache tab first and only calls Brickset on a miss.
 *   upsert  { scans: [...] }     -> { ok, count }   (insert, or update by Scan ID)
 *   remove  { ids: [...] }       -> { ok, count }
 */
const STAGING = 'Scan Staging';
const CACHE = 'Lookup Cache';
const COLS = ['Timestamp', 'Destination', 'Set #', 'Set Name', 'Theme', 'Year', 'Qty', 'Condition', 'Barcode', 'Status', 'Scan ID',
  'Bought For', 'Purchase Date', 'Location', 'Box Cond.', 'Complete?', 'Shipping', 'Prep Cost',
  'Listing Status', 'Notes'];
// App field key -> staging column header (values come from the sheet's "Update values" menu, not the app)
const EXTRA = { boughtFor: 'Bought For', purchaseDate: 'Purchase Date', location: 'Location',
  boxCond: 'Box Cond.', complete: 'Complete?', shipping: 'Shipping', prepCost: 'Prep Cost',
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
    const bsKey = (props.getProperty('BRICKSET_KEY') || '').trim();
    let res;
    if (req.action === 'lookup') res = lookup(String(req.barcode || ''), bsKey);
    else if (req.action === 'bind') res = bindSet(String(req.barcode || ''), String(req.setNumber || ''), bsKey);
    else if (req.action === 'cache') res = cacheAll();
    else if (req.action === 'upsert') res = upsert(req.scans || []);
    else if (req.action === 'remove') res = remove(req.ids || []);
    else res = { ok: false, error: 'unknown action' };
    res.bsUsed = bsCountToday(); // Brickset API calls this script has made today (UTC), so the app can show N/100
    return out(res);
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

  // Brickset stores EAN-13 as-is and UPC-A as 12 digits. A 13-digit code starting with 0 is really a UPC-A,
  // so try the 12-digit form first (saves a call), then the 13-digit form. (Undocumented but verified.)
  const tries = barcode.length === 13 && barcode[0] === '0' ? [barcode.slice(1), barcode] : [barcode];
  for (const q of tries) {
    const set = bricksetQuery(q, key);
    if (set) {
      const rec = recFromSet(set);
      cachePut(barcode, rec);
      return Object.assign({ ok: true, found: true }, rec);
    }
  }
  return { ok: true, found: false };
}

function recFromSet(set) {
  return { setNumber: set.number, name: set.name, theme: set.theme || '', year: set.year || '' };
}

// Insert or update one barcode -> set row in the Lookup Cache tab.
function cachePut(barcode, rec) {
  const cache = sheet(CACHE, ['Barcode', 'Set #', 'Set Name', 'Theme', 'Year', 'Cached At']);
  const last = cache.getLastRow();
  const codes = last > 1 ? cache.getRange(2, 1, last - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const i = codes.indexOf(barcode);
  const row = i >= 0 ? i + 2 : last + 1;
  const rng = cache.getRange(row, 1, 1, 6);
  rng.setNumberFormat('@');
  rng.setValues([[barcode, String(rec.setNumber), rec.name || '', rec.theme || '', String(rec.year || ''), new Date().toISOString()]]);
}

// The user typed a set number for a barcode Brickset didn't know (or just a set number to fill in details).
// Look the set up by number, and remember barcode -> set even if Brickset can't find the set.
function bindSet(barcode, setInput, key) {
  const m = /^(\d{3,6})(?:-(\d{1,2}))?$/.exec(setInput.trim());
  if (!m) return { ok: false, error: 'bad set number' };
  const full = m[1] + '-' + (m[2] || '1');
  let rec = null;
  if (key) {
    const sets = bricksetGetSets({ setNumber: full }, key);
    const hit = sets.find(s => String(s.number) === m[1]) || null;
    if (hit) rec = recFromSet(hit);
  }
  const result = rec || { setNumber: m[1], name: '', theme: '', year: '' };
  if (/^\d{12,13}$/.test(barcode)) cachePut(barcode, result);
  return Object.assign({ ok: true, found: !!rec }, result);
}

// ---------- Brickset daily call counter (the key allows about 100 getSets calls a day) ----------
function utcDay() { return Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd'); }
function bsCountToday() {
  const p = PropertiesService.getScriptProperties();
  return p.getProperty('BS_DAY') === utcDay() ? Number(p.getProperty('BS_COUNT') || 0) : 0;
}
function bsCountBump() {
  PropertiesService.getScriptProperties().setProperties({ BS_DAY: utcDay(), BS_COUNT: String(bsCountToday() + 1) });
}

// Every row of the Lookup Cache tab, so the app can match known barcodes offline without calling Brickset.
function cacheAll() {
  const cache = sheet(CACHE, ['Barcode', 'Set #', 'Set Name', 'Theme', 'Year', 'Cached At']);
  const last = cache.getLastRow();
  const rows = last > 1 ? cache.getRange(2, 1, last - 1, 5).getDisplayValues() : [];
  return { ok: true, rows: rows.filter(r => r[0] && r[1]).map(r => ({ barcode: r[0], setNumber: r[1], name: r[2], theme: r[3], year: r[4] })) };
}

function bricksetGetSets(params, key) {
  bsCountBump();
  // Built by hand: Brickset 500s if userHash is missing, and an object payload drops empty values.
  const body = 'apiKey=' + encodeURIComponent(key) + '&userHash=' +
    '&params=' + encodeURIComponent(JSON.stringify(params));
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
  return j.sets || [];
}

function bricksetQuery(q, key) {
  const sets = bricksetGetSets({ query: q, pageSize: 5 }, key);
  // Only accept a set whose stored barcode really equals the query, so a text match can't mislabel a scan.
  const hit = sets.find(s => s.barcode && (s.barcode.EAN === q || s.barcode.UPC === q));
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
      'Bought For': 'Bought For', 'Purchase Date': 'Purchase Date',
      'Location': 'Location', 'Notes': 'Notes' },
  },
  Sale: {
    tab: 'Sale Inventory', key: 'Set #', formulas: ['Strike Price', 'Profit', 'ROI %'], defaults: ['Fee %', 'Target Profit'],
    map: { 'Set #': 'Set #', 'Set Name': 'Set Name', 'Theme': '@theme', 'Qty': 'Qty', 'Condition': 'Condition',
      'Box Cond.': 'Box Cond.', 'Complete?': 'Complete?', 'Bought For': 'Bought For', 'Purchase Date': 'Purchase Date',
      'Shipping': 'Shipping', 'Prep Cost': 'Prep Cost',
      'Status': 'Listing Status', 'Notes': 'Notes' },
  },
};
// Brickset theme name (lowercase) -> the word your dropdowns use. Anything not in your list is left blank.
const THEME_ALIAS = { 'marvel super heroes': 'Marvel', 'the lord of the rings': 'LOTR', 'lord of the rings': 'LOTR',
  'botanical collection': 'Botanicals', 'formula 1': 'F1', 'creator expert': 'Creator', 'creator 3-in-1': 'Creator' };

function onOpen() {
  SpreadsheetApp.getUi().createMenu('LEGO Scan')
    .addItem('Move selected staging rows to inventory', 'moveSelected')
    .addItem('Update values for selected rows (Brickset)', 'updateValues')
    .addToUi();
}

// ---------- market values from the Brickset set page ----------
// Brickset's API has no market value, but each set page shows "Current value" (New / Used, from BrickLink) for
// retired sets and only the RRP for sets still in production. Rule: sealed/new -> New value, anything else -> Used
// value, and if the page has no current value (not retired) -> the US retail price (RRP).
const VALUE_TABS = {
  'Personal Inventory': { set: 'Set #', cond: 'Condition', qty: 'Qty', unit: 'Value of One', total: 'Estimated Current Value' },
  'Sale Inventory': { set: 'Set #', cond: 'Condition', price: 'Est. Sale Price' },
};

function parseBricksetValues(html) {
  const money = s => { const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(s || ''); return m ? parseFloat(m[1].replace(/,/g, '')) : null; };
  const cv = /<dt>\s*Current value\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i.exec(html);
  const nw = cv ? /New:([\s\S]*?)(?:<br|$)/i.exec(cv[1]) : null;
  const us = cv ? /Used:([\s\S]*)$/i.exec(cv[1]) : null;
  const rrp = /<dt>\s*RRP\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i.exec(html);
  return { newValue: nw ? money(nw[1]) : null, usedValue: us ? money(us[1]) : null, rrp: rrp ? money(rrp[1]) : null };
}

function bricksetPage(setNum) {
  const n = /-\d+$/.test(setNum) ? setNum : setNum + '-1';
  const res = UrlFetchApp.fetch('https://brickset.com/sets/' + encodeURIComponent(n), {
    muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (personal LEGO inventory sheet)' },
  });
  if (res.getResponseCode() !== 200) return null;
  const html = res.getContentText();
  if (/Page not found/i.test(html) && !/<dt>\s*Number\s*<\/dt>/i.test(html)) return null;
  return parseBricksetValues(html);
}

function pickValue(v, condition) {
  const isNew = /^(sealed|new)$/i.test(String(condition).trim());
  const want = isNew ? v.newValue : v.usedValue;
  if (want != null) return { price: want, source: isNew ? 'new value' : 'used value' };
  if (v.rrp != null) return { price: v.rrp, source: 'retail (no market value listed)' };
  return null;
}

function updateValues() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  const t = VALUE_TABS[sh.getName()];
  if (!t) { ui.alert('Open "Personal Inventory" or "Sale Inventory" and select the rows to update first.'); return; }

  const list = ss.getActiveRangeList();
  const ranges = list ? list.getRanges() : [ss.getActiveRange()];
  const rowNums = {};
  ranges.forEach(r => { for (let i = r.getRow(); i < r.getRow() + r.getNumRows(); i++) if (i >= 2) rowNums[i] = true; });
  const rows = Object.keys(rowNums).map(Number).sort((a, b) => a - b);
  if (!rows.length) { ui.alert('Select the rows to update (not the header) first.'); return; }
  if (rows.length > 120) { ui.alert('That is ' + rows.length + ' rows. Please select 120 or fewer at a time.'); return; }

  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const col = name => head.indexOf(name) + 1;
  const setCol = col(t.set), condCol = col(t.cond);
  const target = t.price ? col(t.price) : col(t.unit) || col(t.total);
  if (!setCol || !condCol || !target) { ui.alert('Could not find the expected columns on this tab.'); return; }

  const todo = [], skipped = [];
  rows.forEach(r => {
    const setNum = String(sh.getRange(r, setCol).getDisplayValue()).trim();
    const cond = String(sh.getRange(r, condCol).getDisplayValue()).trim();
    if (!setNum) skipped.push('row ' + r + ': no set number');
    else if (!cond) skipped.push('row ' + r + ' (' + setNum + '): no condition');
    else todo.push({ r: r, setNum: setNum, cond: cond });
  });
  if (!todo.length) { ui.alert('Nothing to update.\n\n' + skipped.join('\n')); return; }

  const what = t.price ? '"' + t.price + '"' : '"' + (t.unit || t.total) + '"' + (t.unit && t.total ? ' and "' + t.total + '"' : '');
  const ask = 'Look up ' + todo.length + ' row(s) on Brickset and overwrite ' + what + '?' +
    '\nSealed/New use the New value; everything else uses the Used value; sets without a market value use retail.' +
    (skipped.length ? '\n\nSkipping:\n' + skipped.join('\n') : '');
  if (ui.alert('Update values', ask, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  const cache = {}, notes = [];
  let done = 0;
  todo.forEach(o => {
    if (!(o.setNum in cache)) {
      try { cache[o.setNum] = bricksetPage(o.setNum); } catch (e) { cache[o.setNum] = null; }
      Utilities.sleep(500); // be gentle with Brickset
    }
    const v = cache[o.setNum];
    const pick = v ? pickValue(v, o.cond) : null;
    if (!pick) { notes.push('row ' + o.r + ' (' + o.setNum + '): no price found, left unchanged'); return; }
    if (t.price) {
      sh.getRange(o.r, target).setValue(pick.price);
    } else if (t.unit && t.total && col(t.qty)) {
      sh.getRange(o.r, col(t.unit)).setValue(pick.price); // Value of One
      const u = sh.getRange(o.r, col(t.unit)).getA1Notation(), q = sh.getRange(o.r, col(t.qty)).getA1Notation();
      sh.getRange(o.r, col(t.total)).setFormula('=' + u + '*' + q); // Est. Current Value = value x qty
    } else {
      const qty = Number(sh.getRange(o.r, col(t.qty)).getValue()) || 1;
      sh.getRange(o.r, target).setValue(pick.price * qty);
    }
    notes.push('row ' + o.r + ' (' + o.setNum + ', ' + o.cond + '): $' + pick.price + ' - ' + pick.source);
    done++;
  });
  ui.alert('Updated ' + done + ' of ' + todo.length + ' row(s).\n\n' + notes.slice(0, 25).join('\n') +
    (notes.length > 25 ? '\n...and ' + (notes.length - 25) + ' more' : ''));
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

'use strict';
// LEGO Scan - step 1: standalone scanner. All data lives in localStorage.
// Each scan carries synced:false so step 3 (Google Sheets) can push the queue later.

const $ = id => document.getElementById(id);
const LS = { scans: 'legoscan.scans', dest: 'legoscan.dest', cache: 'legoscan.lookupCache',
  cfg: 'legoscan.cfg', removals: 'legoscan.removals', cond: 'legoscan.cond', kept: 'legoscan.kept' };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let scans = load(LS.scans, []);
let dest = load(LS.dest, 'Personal');
const lookupCache = load(LS.cache, {}); // barcode -> {setNumber,name,year}

// ---------- code helpers ----------
function validBarcode(c) {
  if (!/^\d{12,13}$/.test(c)) return false;
  const d = c.padStart(13, '0').split('').map(Number);
  const sum = d.slice(0, 12).reduce((a, n, i) => a + n * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}
const normBarcode = c => c.padStart(13, '0'); // UPC-A == EAN-13 with leading 0

// ---------- optional Google Sheets backend (personal Apps Script) ----------
// URL + secret are typed in on the phone and kept in localStorage only; nothing private is in the repo.
let cfg = load(LS.cfg, { url: '', secret: '' });
let removals = load(LS.removals, []);
const configured = () => !!(cfg.url && cfg.secret);

async function api(action, payload) {
  const r = await fetch(cfg.url, { method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // text/plain avoids a CORS preflight
    body: JSON.stringify({ token: cfg.secret, action, ...payload }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'request failed');
  return j;
}

async function lookup(barcode) {
  if (lookupCache[barcode]) return lookupCache[barcode];
  if (!configured() || !navigator.onLine || notFound.has(barcode)) return null;
  try {
    const j = await api('lookup', { barcode });
    if (!j.found) { notFound.add(barcode); return null; } // definitive miss: don't ask again this session
    const rec = { setNumber: j.setNumber, name: j.name, theme: j.theme, year: j.year };
    lookupCache[barcode] = rec; save(LS.cache, lookupCache);
    return rec;
  } catch (e) { lookupError = e.message; return null; } // network/script error: keep the scan, retry on a later sync
}
let lookupError = '';
const notFound = new Set();

let syncing = false;
async function sync() {
  if (!configured() || !navigator.onLine || syncing) return;
  syncing = true;
  try {
    for (const s of scans.filter(s => s.status === 'needs' && s.barcode)) { // retry failed lookups
      const info = await lookup(s.barcode);
      if (info) Object.assign(s, { setNumber: info.setNumber, name: info.name, theme: info.theme || '', year: info.year || '', status: 'matched', synced: false });
    }
    if (removals.length) { await api('remove', { ids: removals }); removals = []; save(LS.removals, removals); }
    const pending = scans.filter(s => !s.synced);
    if (pending.length) {
      await api('upsert', { scans: pending });
      pending.forEach(s => { s.synced = true; });
    }
    save(LS.scans, scans); render();
  } catch (e) { $('net').textContent = 'Sync failed: ' + e.message; }
  syncing = false;
}
setInterval(sync, 30000);

// ---------- in-page dialog (native confirm/prompt pause the camera feed on iOS) ----------
function ask(text) {
  return new Promise(res => {
    $('dlgText').textContent = text; $('dlg').hidden = false;
    const done = v => { $('dlg').hidden = true; $('dlgYes').onclick = $('dlgNo').onclick = null; res(v); };
    $('dlgYes').onclick = () => done(true);
    $('dlgNo').onclick = () => done(false);
  });
}
const resumeCam = () => { if (video.srcObject && video.paused) video.play().catch(() => {}); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeCam(); });

// ---------- feedback ----------
let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 1200; g.gain.value = 0.15;
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.12);
  } catch {}
  if (navigator.vibrate) navigator.vibrate(80); // not supported on iOS; beep + flash cover it
  const f = $('flash'); f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 120);
}
const say = t => { $('msg').textContent = t; };

// ---------- adding scans ----------
const handleBarcode = barcode => addEntry({ barcode }); // step 2 swaps this for the lookup-miss prompt
async function addEntry({ barcode = '', setNumber = '' }) {
  let info = null;
  if (barcode && !setNumber) { say('Looking up ' + barcode + '...'); lookupError = ''; info = await lookup(barcode); }
  if (info) setNumber = info.setNumber;

  // duplicate: same set (or same unresolved barcode) in the same destination
  const dup = scans.find(s => s.dest === dest && s.condition === $('cond').value && !s.undone &&
    ((setNumber && s.setNumber === setNumber) || (!setNumber && barcode && s.barcode === barcode && !s.setNumber)));
  if (dup && await ask(`${dup.setNumber || dup.barcode} is already in ${dest} (qty ${dup.qty}). Add 1 to it, or make a new row?`)) {
    dup.qty += 1; dup.synced = false; dup.ts = Date.now();
    scans = scans.filter(s => s !== dup).concat(dup);
    save(LS.scans, scans); render(); sync();
    say(`Qty is now ${dup.qty} for ${dup.setNumber || dup.barcode}`);
    return;
  }

  scans.push({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    barcode, setNumber, name: info?.name || '', theme: info?.theme || '', year: info?.year || '',
    dest, condition: $('cond').value, extra: getExtra(), qty: 1, ts: Date.now(), synced: false,
    status: setNumber ? (barcode ? 'matched' : 'saved') : 'needs',
  });
  clearOneOffFields();
  save(LS.scans, scans); render(); sync();
  say(setNumber ? `Added set ${setNumber}${info?.name ? ' - ' + info.name : ''}`
    : `Saved barcode ${barcode} - needs set number` + (lookupError ? ` (lookup error: ${lookupError})` : configured() && navigator.onLine ? ' (not found in Brickset)' : ''));
}

// ---------- scanning ----------
const video = $('video');
// ZXing path (iPhone): decode only the aiming box, downscaled, instead of the full 1080p frame.
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
let detector = null, fastReader = null, hardReader = null, lastCode = '', lastAt = 0, loopOn = false, frameNo = 0;
const DECODE_W = 640;   // width the crop is scaled to before decoding
const HARD_EVERY = 4;   // run the slow TRY_HARDER pass only on every Nth frame (and only if the fast pass missed)
const LOOP_MS = 90;     // minimum time between frames; the next frame is scheduled only after the last decode ends
const stats = { ms: [], frames: [], scans: [], hardTries: 0, hardHits: 0 };

function onCode(raw) {
  const now = Date.now();
  if (raw === lastCode && now - lastAt < 2500) { lastAt = now; return; } // duplicate read
  if (!validBarcode(raw)) return;
  lastCode = raw; lastAt = now;
  stats.scans.push(now);
  beep();
  handleBarcode(normBarcode(raw));
}

// Part of the video frame that sits under the on-screen aiming box (video is shown with object-fit: cover).
function cropRect(sw, sh) {
  const cam = document.querySelector('.cam'), ret = document.querySelector('.reticle');
  const cr = cam.getBoundingClientRect(), rr = ret.getBoundingClientRect();
  if (!cr.width || !rr.width) return { x: sw * 0.1, y: sh * 0.3, w: sw * 0.8, h: sh * 0.4 };
  const scale = Math.max(cr.width / sw, cr.height / sh);
  const offX = (cr.width - sw * scale) / 2, offY = (cr.height - sh * scale) / 2;
  let x = (rr.left - cr.left - offX) / scale, y = (rr.top - cr.top - offY) / scale;
  let w = rr.width / scale, h = rr.height / scale;
  x = Math.max(0, x); y = Math.max(0, y); w = Math.min(w, sw - x); h = Math.min(h, sh - y);
  return { x, y, w, h };
}

function zxingDecode(source, sw, sh, hard) {
  const r = cropRect(sw, sh), k = Math.min(1, DECODE_W / r.w);
  work.width = Math.max(1, Math.round(r.w * k)); work.height = Math.max(1, Math.round(r.h * k));
  wctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, work.width, work.height);
  const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(work)));
  return (hard ? hardReader : fastReader).decode(bmp).getText();
}

// One attempt on the current frame. Returns the decoded text or ''.
async function scanOnce(source = video, sw = video.videoWidth, sh = video.videoHeight) {
  frameNo++;
  const t0 = performance.now();
  let text = '';
  if (detector) {
    try { const r = await detector.detect(source); if (r[0]) text = r[0].rawValue; } catch {}
  } else {
    try { text = zxingDecode(source, sw, sh, false); } catch { /* NotFound on empty frames */ }
    if (!text && frameNo % HARD_EVERY === 0) {
      stats.hardTries++;
      try { text = zxingDecode(source, sw, sh, true); stats.hardHits++; } catch {}
    }
  }
  const t1 = performance.now();
  stats.ms.push(t1 - t0); if (stats.ms.length > 30) stats.ms.shift();
  stats.frames.push(t1);
  return text;
}

async function scanLoop() {
  if (!loopOn) return;
  const t0 = performance.now();
  if (video.videoWidth && $('dlg').hidden && !document.hidden) {
    const text = await scanOnce();
    if (text) onCode(text);
  }
  setTimeout(scanLoop, Math.max(20, LOOP_MS - (performance.now() - t0))); // never overlaps itself
}

// ---------- debug readout (toggle with the Debug button) ----------
let debugOn = load('legoscan.debug', false);
function renderDebug() {
  $('dbg').hidden = !debugOn;
  $('dbgBtn').textContent = debugOn ? 'Debug on' : 'Debug';
  if (!debugOn) return;
  const now = performance.now(), wall = Date.now();
  stats.frames = stats.frames.filter(t => now - t < 5000);
  stats.scans = stats.scans.filter(t => wall - t < 60000);
  const avg = stats.ms.length ? stats.ms.reduce((a, b) => a + b, 0) / stats.ms.length : 0;
  $('dbg').textContent = `${detector ? 'native' : 'zxing'} | ${avg.toFixed(0)} ms/decode | ${(stats.frames.length / 5).toFixed(1)} fps | ` +
    `${stats.scans.length} scans/min` + (detector ? '' : ` | hard ${stats.hardHits}/${stats.hardTries}`);
}
$('dbgBtn').onclick = () => { debugOn = !debugOn; save('legoscan.debug', debugOn); renderDebug(); };
setInterval(renderDebug, 500);

async function startCamera() {
  $('startBtn').hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    video.srcObject = stream; await video.play();
    // Best-effort focus help; iOS Safari may ignore any of these.
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.focusMode = 'continuous';
    // Zoom lets you hold the phone farther back, where the lens can focus.
    if (caps.zoom) adv.zoom = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 2));
    if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] }).catch(() => {});
  } catch (e) {
    $('startBtn').hidden = false;
    say(location.protocol === 'http:' && location.hostname !== 'localhost'
      ? 'Camera needs HTTPS. Use the GitHub Pages link.' : 'Camera blocked. Allow it in Settings, or type a code below.');
    return;
  }
  if ('BarcodeDetector' in window) {
    try { detector = new BarcodeDetector({ formats: ['ean_13', 'upc_a'] }); } catch { detector = null; }
  }
  if (!detector) makeReaders();
  say('Point at a box barcode');
  loopOn = true; scanLoop();
}
function makeReaders() {
  const formats = [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.UPC_A];
  const mk = hard => {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    if (hard) hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const r = new ZXing.MultiFormatReader(); r.setHints(hints); return r;
  };
  fastReader = mk(false); hardReader = mk(true);
}
$('startBtn').onclick = startCamera;

// ---------- UI ----------
const CONDS = {
  Personal: ['Sealed', 'Open Box', 'Used', 'Damaged', 'Missing Pieces', 'Built'],
  Sale: ['New', 'Used', 'Damaged'],
};
let condChoice = load(LS.cond, {}); // remembered per destination
function fillConds() {
  const sel = $('cond'); sel.textContent = '';
  CONDS[dest].forEach(c => { const o = document.createElement('option'); o.textContent = c; sel.append(o); });
  sel.value = CONDS[dest].includes(condChoice[dest]) ? condChoice[dest] : CONDS[dest][0];
}
$('cond').onchange = () => { condChoice[dest] = $('cond').value; save(LS.cond, condChoice); };

// Optional per-copy details. Anything Brickset can tell us (name, theme, year, category) is NOT here.
// `keep` fields remember the last value so a batch of similar items needs no retyping.
const MONEY = { type: 'text', mode: 'decimal' };
const FIELDS = {
  Personal: [
    { key: 'boughtFor', label: 'Bought For', ...MONEY },
    { key: 'purchaseDate', label: 'Purchase Date', type: 'date' },
    { key: 'location', label: 'Location', type: 'text', keep: true },
    { key: 'notes', label: 'Notes', type: 'text' },
  ],
  Sale: [
    { key: 'boughtFor', label: 'Bought For', ...MONEY },
    { key: 'purchaseDate', label: 'Purchase Date', type: 'date' },
    { key: 'boxCond', label: 'Box Cond.', type: 'select', options: ['Mint', 'Great', 'Good', 'Fair', 'Poor'], keep: true },
    { key: 'complete', label: 'Complete?', type: 'select', options: ['Yes', 'No', 'Unknown'], keep: true },
    { key: 'shipping', label: 'Shipping', ...MONEY },
    { key: 'prepCost', label: 'Prep Cost', ...MONEY },
    { key: 'listingStatus', label: 'Status', type: 'select', options: ['Hold', 'Listed', 'Offer'], keep: true, dflt: 'Hold' },
    { key: 'notes', label: 'Notes', type: 'text' },
  ],
};
const kept = load(LS.kept, {}); // `${dest}.${key}` -> last value

function renderFields() {
  const box = $('fields'); box.textContent = '';
  FIELDS[dest].forEach(f => {
    const label = document.createElement('label'); label.textContent = f.label;
    let el;
    if (f.type === 'select') {
      el = document.createElement('select');
      ['', ...f.options].forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o || '-'; el.append(op); });
    } else {
      el = document.createElement('input'); el.type = f.type;
      if (f.mode) el.inputMode = f.mode;
    }
    el.id = 'f_' + f.key;
    const saved = kept[dest + '.' + f.key];
    el.value = f.keep ? (saved ?? f.dflt ?? '') : '';
    label.append(el); box.append(label);
  });
}
function getExtra() {
  const x = {};
  FIELDS[dest].forEach(f => {
    const v = $('f_' + f.key).value.trim();
    if (v) x[f.key] = v;
    if (f.keep) kept[dest + '.' + f.key] = v;
  });
  save(LS.kept, kept);
  return x;
}
function clearOneOffFields() { // fields that aren't remembered start empty for the next item
  FIELDS[dest].filter(f => !f.keep).forEach(f => { $('f_' + f.key).value = ''; });
}

function setDest(d) {
  dest = d; save(LS.dest, d); fillConds(); renderFields();
  $('destPersonal').classList.toggle('on', d === 'Personal');
  $('destSale').classList.toggle('on', d === 'Sale');
}
$('destPersonal').onclick = () => setDest('Personal');
$('destSale').onclick = () => setDest('Sale');

$('manual').onsubmit = e => {
  e.preventDefault();
  const v = $('manualInput').value.trim();
  if (!v) return;
  $('manualInput').value = '';
  if (/^\d{12,13}$/.test(v)) {
    if (!validBarcode(v)) { say('That barcode has a bad check digit - retype it.'); return; }
    addEntry({ barcode: normBarcode(v) });
  } else if (/^\d{4,6}(-\d)?$/.test(v)) {
    addEntry({ setNumber: v.replace(/-\d$/, '') });
  } else say('Enter a 4-6 digit set number or a 12/13 digit barcode.');
};

$('undoBtn').onclick = () => {
  const last = [...scans].reverse().find(s => !s.undone);
  if (!last) return;
  scans = scans.filter(s => s !== last);
  if (configured()) { removals.push(last.id); save(LS.removals, removals); }
  save(LS.scans, scans); render(); sync();
  say(`Removed ${last.setNumber || last.barcode}`);
};

function fixSetNumber(s) {
  const v = prompt(`Set number for barcode ${s.barcode}?`, '');
  resumeCam();
  if (!v || !/^\d{4,6}$/.test(v.trim())) return;
  s.setNumber = v.trim(); s.status = 'matched'; s.synced = false;
  if (s.barcode) { lookupCache[s.barcode] = { setNumber: s.setNumber, name: s.name, year: s.year }; save(LS.cache, lookupCache); }
  save(LS.scans, scans); render(); sync();
}

function render() {
  const ul = $('list'); ul.textContent = '';
  scans.slice(-5).reverse().forEach(s => {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const t = document.createElement('div'); t.className = 't';
    t.textContent = s.setNumber ? `${s.setNumber}${s.name ? ' ' + s.name : ''} x${s.qty}` : `? x${s.qty}`;
    const sub = document.createElement('div'); sub.className = 's';
    sub.textContent = `${s.dest} - ${s.barcode || 'manual'} - ${new Date(s.ts).toLocaleTimeString()}`;
    left.append(t, sub);
    const b = document.createElement('span');
    b.className = 'badge ' + s.status;
    b.textContent = s.status === 'needs' ? 'needs set number' : s.status;
    li.append(left, b);
    if (s.status === 'needs') li.onclick = () => fixSetNumber(s);
    ul.append(li);
  });
  $('undoBtn').disabled = !scans.length;
  const pending = scans.filter(s => !s.synced).length;
  $('net').textContent = `${navigator.onLine ? 'Online' : 'Offline'} - ${scans.length} scans` +
    (configured() ? ` (${pending} waiting to sync)` : ' (Sheets not connected)');
}
window.addEventListener('online', () => { render(); sync(); });
window.addEventListener('offline', render);

$('csvBtn').onclick = () => {
  const extraKeys = [...new Set(Object.values(FIELDS).flat().map(f => f.key))];
  const cols = ['setNumber', 'name', 'theme', 'year', 'barcode', 'dest', 'condition', 'qty', 'status', 'ts'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const val = (s, c) => c === 'ts' ? new Date(s.ts).toISOString() : extraKeys.includes(c) ? s.extra?.[c] : s[c];
  const all = cols.concat(extraKeys);
  const rows = [all.join(',')].concat(scans.map(s => all.map(c => esc(val(s, c))).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = 'lego-scans.csv'; a.click();
};

$('cfgBtn').onclick = () => {
  const url = prompt('Apps Script web app URL (leave blank to disconnect):', cfg.url);
  if (url === null) { resumeCam(); return; }
  const secret = url ? prompt('Secret token:', cfg.secret) : '';
  resumeCam();
  if (secret === null) return;
  cfg = { url: url.trim(), secret: (secret || '').trim() };
  save(LS.cfg, cfg); render(); sync();
};

setDest(dest); render(); sync();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

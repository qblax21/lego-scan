'use strict';
// LEGO Scan - step 1: standalone scanner. All data lives in localStorage.
// Each scan carries synced:false so step 3 (Google Sheets) can push the queue later.

const $ = id => document.getElementById(id);
const LS = { scans: 'legoscan.scans', dest: 'legoscan.dest', cache: 'legoscan.lookupCache',
  cfg: 'legoscan.cfg', removals: 'legoscan.removals', cond: 'legoscan.cond' };
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
    dest, condition: $('cond').value, qty: 1, ts: Date.now(), synced: false,
    status: setNumber ? (barcode ? 'matched' : 'saved') : 'needs',
  });
  save(LS.scans, scans); render(); sync();
  say(setNumber ? `Added set ${setNumber}${info?.name ? ' - ' + info.name : ''}`
    : `Saved barcode ${barcode} - needs set number` + (lookupError ? ` (lookup error: ${lookupError})` : configured() && navigator.onLine ? ' (not found in Brickset)' : ''));
}

// ---------- scanning ----------
const video = $('video');
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let detector = null, zxingReader = null, lastCode = '', lastAt = 0, busy = false;

function onCode(raw) {
  const now = Date.now();
  if (raw === lastCode && now - lastAt < 2500) { lastAt = now; return; } // duplicate read
  if (!validBarcode(raw)) return;
  lastCode = raw; lastAt = now;
  beep();
  addEntry({ barcode: normBarcode(raw) });
}

async function tick() {
  if (!video.videoWidth || busy || !$('dlg').hidden) return;
  busy = true;
  try {
    if (detector) {
      const r = await detector.detect(video);
      if (r[0]) onCode(r[0].rawValue);
    } else {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const src = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
      try { onCode(zxingReader.decode(bmp).getText()); } catch (e) { /* NotFound each empty frame */ }
    }
  } catch {}
  busy = false;
}

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
  if (!detector) {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.UPC_A]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zxingReader = new ZXing.MultiFormatReader(); zxingReader.setHints(hints);
  }
  say('Point at a box barcode');
  setInterval(tick, 150);
}
$('startBtn').onclick = startCamera;

// ---------- UI ----------
const CONDS = {
  Personal: ['Sealed', 'Open box', 'Used', 'Damaged', 'Missing pieces', 'Built'],
  Sale: ['New', 'Used', 'Damaged'],
};
let condChoice = load(LS.cond, {}); // remembered per destination
function fillConds() {
  const sel = $('cond'); sel.textContent = '';
  CONDS[dest].forEach(c => { const o = document.createElement('option'); o.textContent = c; sel.append(o); });
  sel.value = CONDS[dest].includes(condChoice[dest]) ? condChoice[dest] : CONDS[dest][0];
}
$('cond').onchange = () => { condChoice[dest] = $('cond').value; save(LS.cond, condChoice); };

function setDest(d) {
  dest = d; save(LS.dest, d); fillConds();
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
  const cols = ['setNumber', 'name', 'year', 'barcode', 'dest', 'qty', 'status', 'ts'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [cols.join(',')].concat(scans.map(s => cols.map(c => esc(c === 'ts' ? new Date(s.ts).toISOString() : s[c])).join(',')));
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

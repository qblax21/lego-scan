'use strict';
// LEGO Scan - step 1: standalone scanner. All data lives in localStorage.
// Each scan carries synced:false so step 3 (Google Sheets) can push the queue later.

const $ = id => document.getElementById(id);
const LS = { scans: 'legoscan.scans', dest: 'legoscan.dest', cache: 'legoscan.lookupCache',
  cfg: 'legoscan.cfg', removals: 'legoscan.removals', cond: 'legoscan.cond', kept: 'legoscan.kept',
  binds: 'legoscan.pendingBinds', bs: 'legoscan.bsUsed', mode: 'legoscan.mode', recount: 'legoscan.recount',
  rreset: 'legoscan.recountReset', syncErr: 'legoscan.syncErr', retry: 'legoscan.setRetry' };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let scans = load(LS.scans, []);
let dest = load(LS.dest, 'Personal');
let mode = load(LS.mode, 'scan');                 // 'scan' (adds rows to Scan Staging) or 'recount' (tallies per set)
let recount = load(LS.recount, {});               // setNumber -> { setNumber, name, qty, ts, synced }
let recountResetPending = load(LS.rreset, false); // "New recount" done offline; clear the Recount tab on next sync
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

// Brickset API calls the script has made today (UTC), as last reported by the script. Limit is about 100 a day.
const BS_LIMIT = 100;
let bsInfo = load(LS.bs, null);
const utcDay = () => new Date().toISOString().slice(0, 10);
function renderBs() {
  const el = $('bsUse');
  if (!configured()) { el.textContent = ''; return; }
  const used = bsInfo && bsInfo.day === utcDay() ? bsInfo.used : 0;
  el.textContent = `Brickset lookups used today: ${used}/${BS_LIMIT}`;
  el.classList.toggle('warn', used >= BS_LIMIT * 0.8);
}

// Background retries stop at this many Brickset calls a day, leaving headroom for real scans.
const BS_RETRY_CAP = 80;
const bsUsedToday = () => (bsInfo && bsInfo.day === utcDay() ? bsInfo.used : 0);
const bsBudget = () => bsUsedToday() < BS_RETRY_CAP;

// Per-set retry bookkeeping: miss = Brickset definitively doesn't have the set (never asked again);
// tried = last day we asked, so each set (or barcode) is retried at most once a day.
let setRetry = load(LS.retry, { miss: {}, tried: {} });
const triedToday = key => setRetry.tried[key] === utcDay();
function markTried(key) {
  const today = utcDay();
  Object.keys(setRetry.tried).forEach(k => { if (setRetry.tried[k] !== today) delete setRetry.tried[k]; });
  setRetry.tried[key] = today; save(LS.retry, setRetry);
}
function markMiss(setNum) { setRetry.miss[setNum] = utcDay(); save(LS.retry, setRetry); }

// Sync problems stay on screen until the step that failed next succeeds (render() never overwrites them).
let syncErr = load(LS.syncErr, {}); // step -> message
const syncErrText = () => Object.entries(syncErr).map(([k, v]) => `${k}: ${v}`).join('; ');
function setStepErr(step, e) {
  let m = (e && e.message) || String(e);
  if (/unknown action/i.test(m)) m += ' (redeploy Code.gs as a new version)';
  syncErr[step] = m; save(LS.syncErr, syncErr); render();
}
function clearStepErr(step) { if (step in syncErr) { delete syncErr[step]; save(LS.syncErr, syncErr); render(); } }

async function api(action, payload) {
  const r = await fetch(cfg.url, { method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // text/plain avoids a CORS preflight
    body: JSON.stringify({ token: cfg.secret, action, ...payload }) });
  const j = await r.json();
  if (typeof j.bsUsed === 'number') { bsInfo = { day: utcDay(), used: j.bsUsed }; save(LS.bs, bsInfo); renderBs(); }
  if (!j.ok) throw new Error(j.error || 'request failed');
  return j;
}

// Pull every barcode -> set the sheet knows into the local cache, so known barcodes match offline
// and never spend a Brickset call. Barcodes with a set number still waiting to sync are left alone.
async function pullCache() {
  if (!configured() || !navigator.onLine) return;
  try {
    const j = await api('cache');
    const pending = new Set(pendingBinds.map(b => b.barcode));
    (j.rows || []).forEach(r => {
      const bc = normBarcode(String(r.barcode));
      if (!pending.has(bc)) lookupCache[bc] = { setNumber: String(r.setNumber), name: r.name || '', theme: r.theme || '', year: r.year || '' };
    });
    save(LS.cache, lookupCache);
  } catch { /* offline or script error: keep what we have */ }
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

// "12345-1" or "12345" -> { num: '12345', full: '12345-1' }
function parseSetInput(v) {
  const m = /^(\d{3,6})(?:-(\d{1,2}))?$/.exec(String(v).trim());
  return m ? { num: m[1], full: m[1] + '-' + (m[2] || '1') } : null;
}

// Ask the script for a set by number (fills name/theme/year) and, when a barcode is given, remember barcode -> set.
// Offline or failing: keep the mapping locally and retry the bind on the next sync.
let pendingBinds = load(LS.binds, []);
async function bindSet(barcode, parsed) {
  const local = { setNumber: parsed.num, name: '', theme: '', year: '' };
  if (configured() && navigator.onLine) {
    try {
      const j = await api('bind', { barcode, setNumber: parsed.full });
      const rec = { setNumber: String(j.setNumber), name: j.name || '', theme: j.theme || '', year: j.year || '' };
      if (barcode) { lookupCache[barcode] = rec; save(LS.cache, lookupCache); }
      if (!j.found && !j.error) markMiss(rec.setNumber); // Brickset really doesn't have it: stop asking
      // j.error = Brickset trouble inside the script; the mapping is saved there, the name is filled in by a later retry
      return { rec, found: j.found, error: j.error };
    } catch (e) { lookupError = e.message; }
  }
  if (barcode) {
    lookupCache[barcode] = local; save(LS.cache, lookupCache);
    if (configured()) { pendingBinds.push({ barcode, setNumber: parsed.full }); save(LS.binds, pendingBinds); }
  }
  return { rec: local, found: false, queued: true };
}

// Copy a found set's name/theme/year onto every row, tally and cached barcode that has that set number but no name.
function fillNames(rec) {
  if (!rec.name) return;
  scans.filter(s => s.setNumber === rec.setNumber && !s.name)
    .forEach(s => Object.assign(s, { name: rec.name, theme: rec.theme, year: rec.year, synced: false }));
  Object.values(recount).filter(x => x.setNumber === rec.setNumber && !x.name)
    .forEach(x => { x.name = rec.name; x.synced = false; });
  Object.keys(lookupCache).forEach(k => {
    const c = lookupCache[k];
    if (c.setNumber === rec.setNumber && !c.name) lookupCache[k] = { ...c, name: rec.name, theme: rec.theme, year: rec.year };
  });
  save(LS.scans, scans); save(LS.recount, recount); save(LS.cache, lookupCache);
}

// Set numbers typed (with a barcode) while offline or while the script was failing. A failure keeps the bind queued and
// backs off; it never throws, so it can't block the upload steps after it.
async function syncBinds() {
  let tried = false, failed = null;
  for (const b of [...pendingBinds]) {
    if (b.next && b.next > Date.now()) continue;
    if (!bsBudget()) break;
    tried = true;
    try {
      const j = await api('bind', { barcode: b.barcode, setNumber: b.setNumber });
      const rec = { setNumber: String(j.setNumber), name: j.name || '', theme: j.theme || '', year: j.year || '' };
      markTried(rec.setNumber);
      if (j.error) { const e = new Error(j.error); e.brickset = true; throw e; }
      lookupCache[b.barcode] = rec; save(LS.cache, lookupCache);
      if (!j.found) markMiss(rec.setNumber);
      fillNames(rec);
      pendingBinds = pendingBinds.filter(x => x !== b); save(LS.binds, pendingBinds);
    } catch (e) {
      b.tries = (b.tries || 0) + 1;
      // Brickset trouble already cost a call: wait 6h. Network / old-script failures cost none: 2, 4, 8... min up to 1h.
      b.next = Date.now() + (e.brickset ? 6 * 3600e3 : Math.min(3600e3, 60e3 * 2 ** b.tries));
      save(LS.binds, pendingBinds); failed = e;
    }
  }
  if (failed) setStepErr('bind', failed); else if (tried) clearStepErr('bind');
  return tried;
}

// Rows with a set number but no name (typed while offline, or Brickset missed): ask Brickset by number.
// One call per set (deduped), each set at most once a day, never a set Brickset said it doesn't have,
// and none once today's count reaches BS_RETRY_CAP.
async function syncNames() {
  if (syncErr.bind || (setRetry.cool || 0) > Date.now()) return false; // the bind action is failing / cooling off: don't pile on
  const sets = [...new Set(scans.filter(s => s.setNumber && !s.name).map(s => s.setNumber))]
    .filter(n => !(n in setRetry.miss) && !triedToday(n));
  let tried = false, calls = 0;
  for (const num of sets) {
    if (!bsBudget() || calls >= 10) break;
    calls++; tried = true; markTried(num);
    const barcode = (scans.find(s => s.setNumber === num && s.barcode) || {}).barcode || '';
    try {
      const j = await api('bind', { barcode, setNumber: num + '-1' });
      if (j.error) throw new Error(j.error);
      if (!j.found) { markMiss(num); continue; }
      fillNames({ setNumber: String(j.setNumber), name: j.name || '', theme: j.theme || '', year: j.year || '' });
    } catch (e) { // keep the rows, pause this step for 15 min, try the rest tomorrow; never stops the sync
      setRetry.cool = Date.now() + 15 * 60e3; save(LS.retry, setRetry);
      setStepErr('names', e);
      return tried;
    }
  }
  if (tried) clearStepErr('names');
  return tried;
}

let syncing = false;
async function sync() {
  if (!configured() || !navigator.onLine || syncing) return;
  syncing = true;
  let didWork = false;
  // Every step is isolated: a failure is recorded (and stays on screen) but never stops the steps after it,
  // so lookup/bind trouble can never block the upload of scans.
  const step = async (name, fn, own) => {
    try { if (await fn()) didWork = true; if (!own) clearStepErr(name); } catch (e) { setStepErr(name, e); }
  };
  await step('bind', syncBinds, true);
  await step('names', syncNames, true);
  await step('lookup', async () => { // retry barcodes that missed; once a day each, within the daily budget
    let tried = false;
    for (const s of scans.filter(s => s.status === 'needs' && s.barcode)) {
      let info = lookupCache[s.barcode] || null; // a cache hit (e.g. fixed on another device) costs nothing
      if (!info) {
        if (triedToday('bc:' + s.barcode) || !bsBudget()) continue;
        markTried('bc:' + s.barcode); tried = true;
        info = await lookup(s.barcode);
      }
      if (info) Object.assign(s, { setNumber: info.setNumber, name: info.name, theme: info.theme || '', year: info.year || '', status: 'matched', synced: false });
    }
    return tried;
  });
  await step('remove', async () => {
    if (!removals.length) return false;
    const ids = [...removals];
    await api('remove', { ids });
    removals = removals.filter(id => !ids.includes(id)); save(LS.removals, removals);
    return true;
  });
  await step('upload', async () => {
    const pending = scans.filter(s => !s.synced).map(s => [s, s.ts, s.qty, s.name, s.setNumber]);
    if (!pending.length) return false;
    await api('upsert', { scans: pending.map(p => p[0]) });
    // a row edited during the request (qty, name, set number) stays pending
    pending.forEach(([s, ts, qty, name, num]) => { if (s.ts === ts && s.qty === qty && s.name === name && s.setNumber === num) s.synced = true; });
    return true;
  });
  // recount tally -> Recount tab (a reset from "New recount" goes first)
  await step('recount', async () => {
    let did = false;
    if (recountResetPending) { did = true; await api('recountReset'); recountResetPending = false; save(LS.rreset, false); }
    const rp = Object.values(recount).filter(x => !x.synced).map(x => [x, x.qty, x.name]);
    if (rp.length) {
      did = true;
      await api('recount', { items: rp.map(([x, q]) => ({ setNumber: x.setNumber, name: x.name, counted: q, ts: x.ts })) });
      rp.forEach(([x, q, n]) => { if (x.qty === q && x.name === n) x.synced = true; }); // a tap during the request stays pending
      Object.keys(recount).forEach(k => { if (recount[k].qty <= 0 && recount[k].synced) delete recount[k]; });
      save(LS.recount, recount); renderRecount();
    }
    return did;
  });
  save(LS.scans, scans); render();
  if (didWork) await pullCache(); // after a sync that changed something, refresh the offline cache
  syncing = false;
}
setInterval(sync, 30000);

// ---------- in-page dialog (native confirm/prompt pause the camera feed on iOS) ----------
function ask(text, yes = 'Add 1', no = 'New row') {
  return new Promise(res => {
    $('dlgText').textContent = text; $('dlgYes').textContent = yes; $('dlgNo').textContent = no; $('dlg').hidden = false;
    const done = v => { $('dlg').hidden = true; $('dlgYes').onclick = $('dlgNo').onclick = null; lastAt = Date.now(); res(v); };
    $('dlgYes').onclick = () => done(true);
    $('dlgNo').onclick = () => done(false);
  });
}
const resumeCam = () => { if (video.srcObject && video.paused) video.play().catch(() => {}); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeCam(); });

// Numeric-keypad prompt for a set number. Resolves to parseSetInput's result, or null if skipped.
function askSetNumber(text) {
  return new Promise(res => {
    $('dlgSetText').textContent = text; $('dlgSetErr').textContent = ''; $('dlgSetInput').value = '';
    $('dlgSet').hidden = false;
    setTimeout(() => $('dlgSetInput').focus(), 60); // iOS may need one tap on the field to raise the keypad
    const done = v => { $('dlgSet').hidden = true; $('dlgSetForm').onsubmit = null; $('dlgSetSkip').onclick = null; lastAt = Date.now(); res(v); };
    $('dlgSetForm').onsubmit = e => {
      e.preventDefault();
      const p = parseSetInput($('dlgSetInput').value);
      if (!p) { $('dlgSetErr').textContent = 'Enter a set number like 75192 or 75192-1'; return; }
      done(p);
    };
    $('dlgSetSkip').onclick = () => done(null);
  });
}

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
// A scanned/typed barcode: cache or Brickset first; on a miss, ask for the set number right away.
async function handleBarcode(barcode) {
  say('Looking up ' + barcode + '...'); lookupError = '';
  let info = await lookup(barcode);
  if (!info) {
    const why = lookupError ? ` (lookup error: ${lookupError})` : '';
    const parsed = await askSetNumber(`Barcode ${barcode} isn't in Brickset${why}. What's the set number?`);
    if (parsed) {
      say('Looking up set ' + parsed.full + '...');
      const r = await bindSet(barcode, parsed);
      info = r.rec;
      bindNote = r.found ? '' : r.queued ? ' (saved locally, will sync)' : r.error ? ' (Brickset error, name will fill in later)' : ' (set not found in Brickset, saved your number)';
    }
  }
  return addEntry({ barcode, info });
}
let bindNote = '';

async function addEntry({ barcode = '', setNumber = '', info = null }) {
  if (!info && barcode && !setNumber) { say('Looking up ' + barcode + '...'); lookupError = ''; info = await lookup(barcode); }
  if (info) setNumber = info.setNumber;
  if (mode === 'recount') return recountAdd(setNumber, info, barcode);

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
  say(setNumber ? `Added set ${setNumber}${info?.name ? ' - ' + info.name : ''}${bindNote}`
    : `Saved barcode ${barcode} - needs set number` + (lookupError ? ` (lookup error: ${lookupError})` : configured() && navigator.onLine ? ' (not found in Brickset)' : ''));
  bindNote = '';
}

// ---------- recount mode: one tally per set, synced to the "Recount" tab (never Scan Staging or the inventory) ----------
function recountAdd(setNumber, info, barcode) {
  if (!setNumber) { say(`Recount needs a set number - skipped barcode ${barcode || ''}`); return; }
  const it = recount[setNumber] || (recount[setNumber] = { setNumber, name: '', qty: 0 });
  if (info?.name && !it.name) it.name = info.name;
  it.qty += 1; it.ts = Date.now(); it.synced = false;
  save(LS.recount, recount); renderRecount(); sync();
  say(`Counted set ${setNumber}${it.name ? ' - ' + it.name : ''}: ${it.qty}`);
}
function recountAdjust(setNumber, d) {
  const it = recount[setNumber]; if (!it) return;
  it.qty = Math.max(0, it.qty + d); it.ts = Date.now(); it.synced = false;
  save(LS.recount, recount); renderRecount(); sync();
}
function renderRecount() {
  const ul = $('rcList'); ul.textContent = '';
  const items = Object.values(recount).filter(x => x.qty > 0).sort((a, b) => b.ts - a.ts);
  items.forEach(it => {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const t = document.createElement('div'); t.className = 't'; t.textContent = it.setNumber;
    const s = document.createElement('div'); s.className = 's'; s.textContent = it.name || '(name not looked up)';
    left.append(t, s);
    const ctl = document.createElement('div'); ctl.className = 'rc';
    const minus = document.createElement('button'); minus.textContent = '-'; minus.setAttribute('aria-label', 'one less');
    const n = document.createElement('b'); n.textContent = it.qty;
    const plus = document.createElement('button'); plus.textContent = '+'; plus.setAttribute('aria-label', 'one more');
    minus.onclick = () => recountAdjust(it.setNumber, -1); plus.onclick = () => recountAdjust(it.setNumber, 1);
    ctl.append(minus, n, plus);
    li.append(left, ctl); ul.append(li);
  });
  const boxes = items.reduce((a, x) => a + x.qty, 0);
  $('rcTitle').textContent = `Recount: ${items.length} sets, ${boxes} boxes`;
}
function setMode(m) {
  mode = m; save(LS.mode, m);
  $('modeScan').classList.toggle('on', m === 'scan');
  $('modeRecount').classList.toggle('on', m === 'recount');
  $('scanOnly').hidden = $('scanBox').hidden = m === 'recount';
  $('recountBox').hidden = m !== 'recount';
  say(m === 'recount' ? 'Recount: scan each box once; use + and - to fix a count' : 'Point at a box barcode');
  renderRecount();
}
$('modeScan').onclick = () => setMode('scan');
$('modeRecount').onclick = () => setMode('recount');
$('rcReset').onclick = async () => {
  if (!await ask('Start a new recount? This clears the tally here and the Recount tab in your sheet. Your inventory is not touched.', 'Clear it', 'Cancel')) return;
  recount = {}; save(LS.recount, recount);
  if (configured()) { recountResetPending = true; save(LS.rreset, true); }
  renderRecount(); sync();
};

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
  if (video.videoWidth && $('dlg').hidden && $('dlgSet').hidden && !document.hidden) {
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
    handleBarcode(normBarcode(v));
  } else if (parseSetInput(v)) {
    const p = parseSetInput(v);
    say('Looking up set ' + p.full + '...');
    bindSet('', p).then(r => addEntry({ setNumber: r.rec.setNumber, info: r.rec }));
  } else say('Enter a set number (75192 or 75192-1) or a 12/13 digit barcode.');
};

$('undoBtn').onclick = () => {
  const last = [...scans].reverse().find(s => !s.undone);
  if (!last) return;
  scans = scans.filter(s => s !== last);
  if (configured()) { removals.push(last.id); save(LS.removals, removals); }
  save(LS.scans, scans); render(); sync();
  say(`Removed ${last.setNumber || last.barcode}`);
};

// Tap a "needs set number" row to fix it: same keypad prompt, same Brickset-by-number lookup and cache save.
async function fixSetNumber(s) {
  const parsed = await askSetNumber(s.barcode ? `Set number for barcode ${s.barcode}?` : 'Set number for this scan?');
  if (!parsed) return;
  say('Looking up set ' + parsed.full + '...');
  const r = await bindSet(s.barcode, parsed);
  const same = scans.filter(x => x === s || (x.status === 'needs' && s.barcode && x.barcode === s.barcode));
  same.forEach(x => Object.assign(x, { setNumber: r.rec.setNumber, name: r.rec.name, theme: r.rec.theme, year: r.rec.year, status: 'matched', synced: false }));
  save(LS.scans, scans); render(); sync();
  say(`Set ${r.rec.setNumber}${r.rec.name ? ' - ' + r.rec.name : ''} saved` + (same.length > 1 ? ` (fixed ${same.length} rows)` : ''));
}

function render() {
  const ul = $('list'); ul.textContent = '';
  scans.slice(-5).reverse().forEach(s => {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const t = document.createElement('div'); t.className = 't';
    t.textContent = s.setNumber ? `${s.setNumber}${s.name ? ' ' + s.name : ''} x${s.qty}` : `? x${s.qty}`;
    const sub = document.createElement('div'); sub.className = 's';
    sub.textContent = `${s.dest} - ${s.barcode || 'manual'} - ${new Date(s.ts).toLocaleTimeString()}` + (s.status === 'needs' ? ' - tap to fix' : '');
    left.append(t, sub);
    const b = document.createElement('span');
    b.className = 'badge ' + s.status;
    b.textContent = s.status === 'needs' ? 'needs set number' : s.status;
    li.append(left, b);
    if (s.status === 'needs') { li.classList.add('fix'); li.onclick = () => fixSetNumber(s); }
    ul.append(li);
  });
  $('undoBtn').disabled = !scans.length;
  renderBs();
  const pending = scans.filter(s => !s.synced).length;
  const err = syncErrText();
  $('net').textContent = `${navigator.onLine ? 'Online' : 'Offline'} - ${scans.length} scans` +
    (configured() ? ` (${pending} waiting to sync)` : ' (Sheets not connected)') +
    (err ? ` - Sync problem: ${err}` : '');
  $('net').classList.toggle('err', !!err);
}
$('net').onclick = () => { pendingBinds.forEach(b => { delete b.next; }); sync(); }; // tap the status line to retry now
window.addEventListener('online', () => { render(); sync(); });
window.addEventListener('offline', render);

$('csvBtn').onclick = () => {
  if (mode === 'recount') { // export the tally instead of the scan list
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = ['setNumber,name,counted'].concat(Object.values(recount).filter(x => x.qty > 0).map(x => [x.setNumber, x.name, x.qty].map(esc).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
    a.download = 'lego-recount.csv'; a.click();
    return;
  }
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
  save(LS.cfg, cfg); render(); sync(); pullCache();
};

setDest(dest); render(); setMode(mode); pullCache().then(sync);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

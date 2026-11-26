// GinkgoCam — STATION MAISON (le vieux téléphone posé dans l'appartement).
// Filme, écoute, reconnaît les aboiements (YAMNet, sur l'appareil), enregistre un clip,
// envoie une notification (ntfy), accepte l'appel vidéo de l'iPhone et efface tout chaque soir.
import {
  DOG_LABELS, fr, DEFAULTS, randId, iceServers, encodePairing, hhmm, dur, summarize, sleep,
} from './common.js';
import { AudioClassifier, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@0.10.14/audio_bundle.mjs';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';
const $ = (s) => document.querySelector(s);
const log = (...a) => console.log('[GinkgoCam]', ...a);

// ---------------------------------------------------------------- réglages
const CFG_KEY = 'ginkgocam.home';
function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch { /* stockage bloqué */ } }
function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch { c = {}; }
  c = { ...DEFAULTS, facing: 'user', ...c };
  if (!c.peerId) {
    c.peerId = 'ginkgocam-' + randId(20);
    c.token = randId(32);
    c.ntfyTopic = 'ginkgo-' + randId(18);
    saveCfg(c);
  }
  return c;
}
let cfg = loadCfg();

// ---------------------------------------------------------------- stockage local (IndexedDB)
let db;
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ginkgocam', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('events', { keyPath: 'id' });
      r.result.createObjectStore('clips', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
const idb = {
  put: (s, v) => tx(s, 'readwrite', (o) => o.put(v)),
  get: (s, k) => tx(s, 'readonly', (o) => o.get(k)),
  all: (s) => tx(s, 'readonly', (o) => o.getAll()),
  del: (s, k) => tx(s, 'readwrite', (o) => o.delete(k)),
};

let events = [];
const newId = () => Date.now().toString(36) + randId(4);
async function saveEvent(e) {
  const i = events.findIndex((x) => x.id === e.id);
  if (i >= 0) events[i] = e; else events.push(e);
  events.sort((a, b) => a.start - b.start);
  try { await idb.put('events', { ...e }); } catch (err) { log('save', err); }
  broadcast({ type: 'event', event: e });
  renderToday();
}
function sysEvent(label) { saveEvent({ id: newId(), type: 'system', start: Date.now(), label }); }

// Purge du soir : tout ce qui date d'avant la dernière « heure de purge » disparaît.
function lastPurgeBoundary() {
  const b = new Date(); b.setHours(cfg.purgeHour, 0, 0, 0);
  if (Date.now() < b.getTime()) b.setDate(b.getDate() - 1);
  return b.getTime();
}
async function purge() {
  const limit = lastPurgeBoundary();
  const old = events.filter((e) => e.start < limit && !(det.ep && det.ep.id === e.id));
  if (!old.length) return;
  for (const e of old) {
    await idb.del('events', e.id).catch(() => {});
    if (e.clipId) await idb.del('clips', e.clipId).catch(() => {});
  }
  events = events.filter((e) => !old.includes(e));
  // clips orphelins
  const clips = await idb.all('clips').catch(() => []);
  for (const c of clips) if (c.start < limit) await idb.del('clips', c.id).catch(() => {});
  broadcast({ type: 'state', ...statePayload() });
  renderToday();
  log('purge', old.length, 'événements');
}

// ---------------------------------------------------------------- horaires
let manualPause = false;
function inSchedule(d = new Date()) {
  if (cfg.scheduleMode === 'always') return true;
  if (!cfg.days.includes(d.getDay())) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = cfg.start.split(':').map(Number);
  const [eh, em] = cfg.end.split(':').map(Number);
  return m >= sh * 60 + sm && m < eh * 60 + em;
}
const watching = () => running && !manualPause && inSchedule();
function statusText() {
  if (!running) return 'Arrêtée';
  if (manualPause) return 'En pause';
  if (!inSchedule()) return 'Hors horaires';
  return 'Surveille';
}

// ---------------------------------------------------------------- caméra + micro
let stream, running = false;
async function startMedia() {
  // AGC coupé : le niveau en dB reste comparable d'une heure à l'autre.
  const audio = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cfg.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 20, max: 24 } },
      audio,
    });
  } catch (err) {
    if (err && err.name === 'NotAllowedError') throw new Error('Caméra/micro refusés : autorise-les dans les réglages du navigateur.');
    // Pas de caméra utilisable : on continue en micro seul (détection + clips audio).
    log('caméra indisponible, micro seul', err);
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch { throw new Error('Aucun micro trouvé sur cet appareil.'); }
  }
  const v = $('#cam');
  v.srcObject = stream;
  await v.play().catch(() => {});
}

// ---------------------------------------------------------------- écoute (YAMNet)
let audioCtx, classifier, HOP_SEC = 0.5;
async function startAudio() {
  setBoot('Chargement du modèle de reconnaissance des sons…');
  const fileset = await FilesetResolver.forAudioTasks(WASM);
  classifier = await AudioClassifier.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL },
    maxResults: 20,
    scoreThreshold: 0.05,
  });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  const src = audioCtx.createMediaStreamSource(stream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  const sink = audioCtx.createGain(); sink.gain.value = 0;
  src.connect(proc); proc.connect(sink); sink.connect(audioCtx.destination);

  const sr = audioCtx.sampleRate;
  const win = Math.round(sr * 0.975);          // fenêtre YAMNet
  const hop = Math.floor(win / 2);             // 50 % de recouvrement → une analyse toutes les ~0,5 s
  HOP_SEC = hop / sr;
  const buf = new Float32Array(win);
  let fill = 0;
  proc.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    let i = 0;
    while (i < input.length) {
      const n = Math.min(input.length - i, win - fill);
      buf.set(input.subarray(i, i + n), fill);
      fill += n; i += n;
      if (fill === win) {
        analyze(buf.slice(0), sr);
        buf.copyWithin(0, hop);
        fill = win - hop;
      }
    }
  };
}

function analyze(samples, sr) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const db = 10 * Math.log10(sum / samples.length + 1e-12);
  let res;
  try { res = classifier.classify(samples, sr); } catch (err) { log('classify', err); return; }
  let dog = 0, dogLabel = null, top = null;
  for (const r of res) {
    for (const c of r.classifications[0].categories) {
      if (DOG_LABELS.has(c.categoryName) && c.score > dog) { dog = c.score; dogLabel = c.categoryName; }
      if (!top || c.score > top.score) top = c;
    }
  }
  onFrame({ t: Date.now(), db, dog, dogLabel, top: top ? top.categoryName : null, topScore: top ? top.score : 0 });
}

// ---------------------------------------------------------------- détection des épisodes
const det = { recent: [], ep: null, lastNotif: 0, lastSound: null, rec: null, recStart: 0 };
let lastLevelSent = 0;

function onFrame(f) {
  renderMeter(f);
  if (f.t - lastLevelSent > 500 && conns.size) {
    lastLevelSent = f.t;
    broadcast({ type: 'level', db: f.db, dog: f.dog, top: f.top });
  }
  if (det.ep && det.ep.test) return; // un test en cours ne doit pas être mélangé aux vrais sons
  if (!watching()) { if (det.ep) endEpisode(); det.recent = []; return; }

  const isDog = f.dog >= cfg.threshold && f.db >= cfg.minDb;
  det.recent.push(isDog);
  if (det.recent.length > 4) det.recent.shift();
  const hits = det.recent.filter(Boolean).length;

  if (!det.ep && hits >= 2) startEpisode(f, hits);
  else if (det.ep) {
    const ep = det.ep;
    if (isDog) {
      ep.barkSec += HOP_SEC; ep.last = f.t;
      ep.peak = Math.max(ep.peak, f.dog); ep.maxDb = Math.max(ep.maxDb, f.db);
      if (f.t - (ep._saved || 0) > 5000) { ep._saved = f.t; saveEvent(publicEp(ep)); }
    } else if (f.t - ep.last > cfg.episodeGapSec * 1000) {
      endEpisode();
    }
    if (det.rec && f.t - det.recStart > cfg.maxClipSec * 1000) stopClip();
  } else if (!isDog && f.db >= cfg.loudDb && f.top && f.top !== 'Silence' && f.topScore >= 0.3) {
    logSound(f);
  }
}

const publicEp = (ep) => {
  const { _saved, last, ...rest } = ep;
  return { ...rest, end: last, barkSec: Math.round(ep.barkSec * 10) / 10 };
};

function startEpisode(f, hits, test = false) {
  const ep = {
    id: newId(), type: 'bark', test, start: f.t - hits * HOP_SEC * 1000, last: f.t,
    barkSec: hits * HOP_SEC, peak: f.dog, maxDb: f.db, label: f.dogLabel || 'Bark', clipId: null,
  };
  det.ep = ep;
  det.lastSound = null;
  startClip(ep);
  saveEvent(publicEp(ep));
  const now = Date.now();
  if (!activeCall && now - det.lastNotif > cfg.cooldownMin * 60000) {
    det.lastNotif = now;
    notify(
      test ? 'Test — Ginkgo aboie' : '🐶 Ginkgo aboie',
      `${fr(ep.label)} détecté à ${hhmm(ep.start)} (confiance ${Math.round(ep.peak * 100)} %). Touche pour voir en direct.`,
      4,
    );
  }
}

function endEpisode() {
  const ep = det.ep;
  if (!ep) return;
  det.ep = null;
  det.recent = [];
  saveEvent(publicEp(ep));
  // 3 s de « queue » pour voir comment ça se calme
  setTimeout(() => { if (det.rec && det.rec._epId === ep.id) stopClip(); }, 3000);
}

function logSound(f) {
  const s = det.lastSound;
  if (s && s.label === f.top && f.t - s.endT < 30000) {
    s.count += 1; s.endT = f.t; s.maxDb = Math.max(s.maxDb, f.db);
    if (s.count % 4 === 0) saveEvent({ ...s });
    return;
  }
  det.lastSound = { id: newId(), type: 'sound', start: f.t, endT: f.t, label: f.top, maxDb: f.db, count: 1 };
  saveEvent({ ...det.lastSound });
}

// ---------------------------------------------------------------- clips vidéo
function pickMime() {
  if (!window.MediaRecorder) return null;
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
function startClip(ep) {
  const mime = pickMime();
  if (mime === null) return;
  if (det.rec) stopClip();
  let rec;
  try {
    rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 600000, audioBitsPerSecond: 64000 });
  } catch (err) { log('MediaRecorder', err); return; }
  const chunks = [];
  const clipId = 'clip-' + ep.id;
  ep.clipId = clipId;
  rec._epId = ep.id;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    const blob = new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' });
    try {
      await idb.put('clips', { id: clipId, start: ep.start, blob, mime: blob.type, size: blob.size });
    } catch (err) { log('clip save', err); }
    const e = events.find((x) => x.id === ep.id);
    if (e) saveEvent({ ...e, clipSize: blob.size, clipSec: Math.round((Date.now() - rec._t0) / 1000) });
  };
  rec._t0 = Date.now();
  rec.start(1000);
  det.rec = rec;
  det.recStart = Date.now();
}
function stopClip() {
  const r = det.rec;
  det.rec = null;
  if (r && r.state !== 'inactive') r.stop();
}

// ---------------------------------------------------------------- notification (ntfy)
async function notify(title, message, priority = 3) {
  if (!cfg.ntfyTopic) return false;
  const click = new URL('view.html', location.href).href;
  try {
    // corps en texte brut = requête « simple », pas de pré-vol CORS
    const r = await fetch(cfg.ntfyServer.replace(/\/$/, '') + '/', {
      method: 'POST',
      body: JSON.stringify({ topic: cfg.ntfyTopic, title, message, priority, tags: ['dog'], click }),
    });
    return r.ok;
  } catch (err) { log('ntfy', err); return false; }
}

// ---------------------------------------------------------------- liaison avec l'iPhone (WebRTC / PeerJS)
let peer, activeCall = null, retryTimer;
const conns = new Set();
function setNet(t, ok = false) { const el = $('#net'); el.textContent = t; el.dataset.ok = ok ? '1' : '0'; }

function startPeer() {
  peer = new window.Peer(cfg.peerId, { config: { iceServers: iceServers(cfg) }, debug: 1 });
  peer.on('open', () => setNet('En ligne', true));
  peer.on('disconnected', () => {
    setNet('Reconnexion…');
    setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 3000);
  });
  peer.on('error', (err) => {
    log('peer', err.type, err.message);
    if (['unavailable-id', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      setNet('Hors ligne — nouvel essai…');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { try { peer.destroy(); } catch { /* déjà fermé */ } startPeer(); }, 6000);
    }
  });
  peer.on('connection', (conn) => {
    if (!conn.metadata || conn.metadata.token !== cfg.token) { conn.on('open', () => conn.close()); return; }
    conn.on('open', () => { conns.add(conn); conn.send({ type: 'state', ...statePayload() }); });
    conn.on('data', (msg) => handleMsg(conn, msg));
    conn.on('close', () => conns.delete(conn));
    conn.on('error', () => conns.delete(conn));
  });
  peer.on('call', (call) => {
    if (!call.metadata || call.metadata.token !== cfg.token) { call.close(); return; }
    if (activeCall) activeCall.close();
    activeCall = call;
    call.answer(stream);
    call.on('stream', (remote) => showRemote(remote));
    const done = () => { if (activeCall === call) { activeCall = null; hideRemote(); } };
    call.on('close', done);
    call.on('error', done);
  });
}

function broadcast(msg) {
  for (const c of conns) { if (c.open) { try { c.send(msg); } catch { /* canal fermé */ } } }
}

let battery = null;
function statePayload() {
  return {
    events,
    status: {
      text: statusText(), watching: watching(), paused: manualPause,
      schedule: cfg.scheduleMode === 'always' ? 'Tout le temps' : `${cfg.start}–${cfg.end}`,
      purgeHour: cfg.purgeHour,
      battery: battery ? Math.round(battery.level * 100) : null,
      charging: battery ? battery.charging : null,
    },
  };
}

async function handleMsg(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'hello') conn.send({ type: 'state', ...statePayload() });
  else if (msg.type === 'clip') sendClip(conn, msg.id);
  else if (msg.type === 'pause') { manualPause = !!msg.value; sysEvent(manualPause ? 'Mise en pause depuis l’iPhone' : 'Reprise depuis l’iPhone'); renderStatus(); }
  else if (msg.type === 'test') runTest();
}

async function sendClip(conn, id) {
  const c = await idb.get('clips', id).catch(() => null);
  if (!c) { conn.send({ type: 'clipMissing', id }); return; }
  const buf = await c.blob.arrayBuffer();
  const CH = 64 * 1024;
  const n = Math.ceil(buf.byteLength / CH);
  conn.send({ type: 'clipStart', id, mime: c.mime, size: buf.byteLength, n });
  for (let i = 0; i < n; i++) {
    while (conn.dataChannel && conn.dataChannel.bufferedAmount > 1000000) await sleep(40);
    if (!conn.open) return;
    conn.send({ type: 'clipChunk', id, i, data: buf.slice(i * CH, (i + 1) * CH) });
  }
  conn.send({ type: 'clipEnd', id });
}

function showRemote(remote) {
  const v = $('#remote');
  v.srcObject = remote;
  v.muted = false;
  v.volume = 1;
  v.play().catch(() => {});
  document.body.classList.add('in-call');
  wake();
}
function hideRemote() {
  const v = $('#remote');
  v.srcObject = null;
  document.body.classList.remove('in-call');
}

// ---------------------------------------------------------------- écran : veille, wake lock
let wakeLock = null, idleTimer;
async function keepAwake() {
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* refusé */ }
}
function wake() {
  document.body.classList.remove('dim');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!activeCall) document.body.classList.add('dim'); }, 60000);
}
document.addEventListener('pointerdown', wake);
document.addEventListener('visibilitychange', () => {
  if (!running) return;
  if (document.visibilityState === 'visible') { keepAwake(); sysEvent('Application revenue au premier plan'); }
  else sysEvent('Application passée en arrière-plan — l’écoute peut être coupée');
});

// ---------------------------------------------------------------- interface
function setBoot(t) { $('#boot-msg').textContent = t; }
function renderMeter(f) {
  const lvl = Math.max(0, Math.min(1, (f.db + 80) / 60));
  $('#lvl').style.width = (lvl * 100).toFixed(0) + '%';
  $('#dogbar').style.width = (f.dog * 100).toFixed(0) + '%';
  $('#dogpct').textContent = Math.round(f.dog * 100) + ' %';
  $('#heard').textContent = f.top && f.topScore > 0.2 ? fr(f.top) : '—';
}
function renderStatus() {
  const st = statusText();
  $('#status').textContent = st;
  $('#status').dataset.state = watching() ? 'on' : 'off';
  $('#saver-status').textContent = `GinkgoCam · ${st}`;
  $('#btn-pause').textContent = manualPause ? 'Reprendre' : 'Pause';
  broadcast({ type: 'status', status: statePayload().status });
}
function renderToday() {
  const s = summarize(events);
  $('#sum').textContent = s.episodes
    ? `Aujourd’hui : ${s.episodes} épisode${s.episodes > 1 ? 's' : ''} · ${dur(s.barkSec)} d’aboiements`
    : 'Aujourd’hui : aucun aboiement';
  const list = $('#events');
  list.innerHTML = '';
  for (const e of events.slice(-8).reverse()) {
    const li = document.createElement('li');
    li.className = e.type;
    if (e.type === 'bark') li.textContent = `${hhmm(e.start)} · ${e.test ? 'TEST · ' : ''}Aboiements ${dur(e.barkSec)}`;
    else if (e.type === 'sound') li.textContent = `${hhmm(e.start)} · ${fr(e.label)}${e.count > 1 ? ` ×${e.count}` : ''}`;
    else li.textContent = `${hhmm(e.start)} · ${e.label}`;
    list.appendChild(li);
  }
  $('#saver-sum').textContent = $('#sum').textContent;
}

function pairingUrl() {
  const p = { id: cfg.peerId, t: cfg.token, n: cfg.ntfyTopic, s: cfg.ntfyServer, turnUrl: cfg.turnUrl, turnUser: cfg.turnUser, turnPass: cfg.turnPass };
  return new URL('view.html', location.href).href + '#p=' + encodePairing(p);
}
function openPair() {
  const url = pairingUrl();
  const qr = window.qrcode(0, 'L');
  qr.addData(url);
  qr.make();
  $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  $('#pair-link').value = url;
  $('#ntfy-topic').textContent = cfg.ntfyTopic;
  $('#dlg-pair').showModal();
}

function openSettings() {
  const f = $('#form-settings');
  f.scheduleMode.value = cfg.scheduleMode;
  f.start.value = cfg.start; f.end.value = cfg.end;
  f.querySelectorAll('input[name=day]').forEach((cb) => { cb.checked = cfg.days.includes(Number(cb.value)); });
  f.threshold.value = Math.round(cfg.threshold * 100);
  f.minDb.value = cfg.minDb;
  f.cooldownMin.value = cfg.cooldownMin;
  f.purgeHour.value = cfg.purgeHour;
  f.facing.value = cfg.facing;
  f.ntfyServer.value = cfg.ntfyServer;
  f.turnUrl.value = cfg.turnUrl; f.turnUser.value = cfg.turnUser; f.turnPass.value = cfg.turnPass;
  $('#thr-val').textContent = f.threshold.value + ' %';
  $('#dlg-settings').showModal();
}
async function saveSettings(ev) {
  ev.preventDefault();
  const f = $('#form-settings');
  const oldFacing = cfg.facing;
  const oldIce = JSON.stringify(iceServers(cfg));
  cfg = {
    ...cfg,
    scheduleMode: f.scheduleMode.value,
    start: f.start.value || '08:00', end: f.end.value || '19:00',
    days: [...f.querySelectorAll('input[name=day]:checked')].map((cb) => Number(cb.value)),
    threshold: Number(f.threshold.value) / 100,
    minDb: Number(f.minDb.value),
    cooldownMin: Number(f.cooldownMin.value),
    purgeHour: Number(f.purgeHour.value),
    facing: f.facing.value,
    ntfyServer: f.ntfyServer.value.trim() || DEFAULTS.ntfyServer,
    turnUrl: f.turnUrl.value.trim(), turnUser: f.turnUser.value.trim(), turnPass: f.turnPass.value,
  };
  saveCfg(cfg);
  $('#dlg-settings').close();
  renderStatus();
  if (running && cfg.facing !== oldFacing) location.reload();
  if (running && JSON.stringify(iceServers(cfg)) !== oldIce) { try { peer.destroy(); } catch { /* */ } startPeer(); }
}

// Simule un épisode complet (notification + clip + journal) sans le chien.
function runTest() {
  if (det.ep) return;
  const f = { t: Date.now(), dog: 0.9, db: -30, dogLabel: 'Bark' };
  const prevNotif = det.lastNotif;
  det.lastNotif = 0;
  startEpisode(f, 2, true);
  if (!det.lastNotif) det.lastNotif = prevNotif;
  const ep = det.ep;
  const iv = setInterval(() => {
    if (det.ep !== ep) { clearInterval(iv); return; }
    ep.barkSec += 1; ep.last = Date.now();
  }, 1000);
  setTimeout(() => { clearInterval(iv); if (det.ep === ep) endEpisode(); }, 8000);
}

// ---------------------------------------------------------------- démarrage
async function start() {
  $('#btn-start').disabled = true;
  try {
    if (!window.isSecureContext) throw new Error('Il faut ouvrir l’appli en https (ou localhost).');
    setBoot('Autorise la caméra et le micro…');
    await startMedia();
    db = await openDb();
    events = (await idb.all('events')).sort((a, b) => a.start - b.start);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await purge();
    await startAudio();
    running = true;
    startPeer();
    keepAwake();
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        battery = b;
        let warned = false;
        const check = () => {
          if (!b.charging && b.level < 0.2 && !warned) { warned = true; notify('🔋 GinkgoCam', 'Le téléphone de la maison n’est plus branché (batterie < 20 %).', 3); }
          if (b.charging) warned = false;
          renderStatus();
        };
        b.addEventListener('levelchange', check); b.addEventListener('chargingchange', check); check();
      }).catch(() => {});
    }
    document.body.classList.add('running');
    sysEvent('Surveillance démarrée');
    renderStatus();
    renderToday();
    wake();
    setInterval(() => { renderStatus(); purge(); }, 60000);
  } catch (err) {
    log(err);
    setBoot('Impossible de démarrer : ' + (err && err.message ? err.message : err));
    $('#btn-start').disabled = false;
  }
}

$('#btn-start').addEventListener('click', start);
$('#btn-pause').addEventListener('click', () => { manualPause = !manualPause; sysEvent(manualPause ? 'Mise en pause' : 'Reprise'); renderStatus(); });
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-settings-boot').addEventListener('click', openSettings);
$('#btn-pair').addEventListener('click', openPair);
$('#btn-pair-boot').addEventListener('click', openPair);
$('#btn-test').addEventListener('click', () => { if (running) runTest(); });
$('#btn-test-notif').addEventListener('click', async (e) => {
  const ok = await notify('GinkgoCam', 'Test de notification : si tu lis ça, c’est branché ✅', 3);
  e.target.textContent = ok ? 'Envoyée ✅' : 'Échec ❌';
});
$('#btn-copy').addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText($('#pair-link').value); });
$('#form-settings').addEventListener('submit', saveSettings);
$('#form-settings').threshold.addEventListener('input', (e) => { $('#thr-val').textContent = e.target.value + ' %'; });
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
setBoot(window.isSecureContext ? 'Pose le téléphone face à la pièce, branché, puis démarre.' : '⚠️ Ouvre cette page en https, sinon la caméra est bloquée.');

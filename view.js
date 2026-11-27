// GinkgoCam — VUE IPHONE : direct de l'appartement, parler à Ginkgo, journal du jour, clips.
import { fr, iceServers, encodePairing, decodePairing, hhmm, dur, summarize, sleep } from './common.js';

const $ = (s) => document.querySelector(s);
const log = (...a) => console.log('[GinkgoCam]', ...a);
const KEY = 'ginkgocam.view';

// ---------------------------------------------------------------- appairage
// L'appairage vit dans l'adresse (#p=…) ET dans le stockage local.
// Sur iPhone, Safari, l'icône d'écran d'accueil et les autres navigateurs n'ont pas la même mémoire :
// garder l'adresse complète fait qu'une icône ou un favori ouvre toujours GinkgoCam déjà appairé.
let pair = null;
if (location.hash.startsWith('#p=')) {
  try { pair = decodePairing(location.hash.slice(3)); } catch (err) { log('pairing', err); }
}
if (pair) {
  try { localStorage.setItem(KEY, JSON.stringify(pair)); } catch { /* stockage bloqué : l'adresse suffit */ }
} else {
  try { pair = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { pair = null; }
  if (pair) history.replaceState(null, '', location.pathname + '#p=' + encodePairing(pair));
}

// ---------------------------------------------------------------- état
let peer, conn, call, local, events = [], status = null, reconnectTimer;
const clips = new Map();   // id -> objectURL
const incoming = new Map(); // id -> {mime, n, parts}

function setNet(t, ok = false) { const el = $('#net'); el.textContent = t; el.dataset.ok = ok ? '1' : '0'; }

function connect() {
  if (peer && !peer.destroyed) { try { peer.destroy(); } catch { /* */ } }
  setNet('Connexion à la maison…');
  peer = new window.Peer({ config: { iceServers: iceServers(pair) }, debug: 1 });
  peer.on('open', openData);
  peer.on('error', (err) => {
    log('peer', err.type, err.message);
    if (err.type === 'peer-unavailable') setNet('Maison injoignable');
    else setNet('Hors ligne');
    scheduleReconnect();
  });
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
}

function openData() {
  conn = peer.connect(pair.id, { metadata: { token: pair.t }, reliable: true });
  conn.on('open', () => { setNet('Connecté à la maison', true); conn.send({ type: 'hello' }); });
  conn.on('data', onData);
  conn.on('close', () => { setNet('Déconnecté'); scheduleReconnect(); });
  conn.on('error', () => scheduleReconnect());
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (conn && conn.open) return;
    if (peer && peer.open) openData(); else connect();
  }, 5000);
}

function onData(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'state': events = msg.events || []; status = msg.status; renderAll(); break;
    case 'status': status = msg.status; renderStatus(); break;
    case 'event': {
      const i = events.findIndex((e) => e.id === msg.event.id);
      if (i >= 0) events[i] = msg.event; else events.push(msg.event);
      events.sort((a, b) => a.start - b.start);
      renderAll();
      break;
    }
    case 'level': renderLevel(msg); break;
    case 'clipStart': incoming.set(msg.id, { mime: msg.mime, n: msg.n, parts: new Array(msg.n), got: 0 }); progress(msg.id, 0); break;
    case 'clipChunk': {
      const c = incoming.get(msg.id);
      if (!c) break;
      c.parts[msg.i] = msg.data; c.got += 1;
      progress(msg.id, c.got / c.n);
      break;
    }
    case 'clipEnd': {
      const c = incoming.get(msg.id);
      if (!c) break;
      incoming.delete(msg.id);
      const url = URL.createObjectURL(new Blob(c.parts, { type: c.mime }));
      clips.set(msg.id, url);
      playClip(msg.id);
      break;
    }
    case 'clipMissing': {
      const b = document.querySelector(`[data-clip="${msg.id}"]`);
      if (b) { b.textContent = 'Clip pas encore prêt'; b.disabled = false; }
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------- direct
async function startLive() {
  if (!peer || !peer.open) { setNet('Pas encore connecté…'); return; }
  $('#btn-live').disabled = true;
  try {
    local = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    log('getUserMedia', err);
    local = new MediaStream(); // on regarde quand même, sans se montrer
  }
  setMic(false); // micro coupé par défaut : rien de ton travail n'est diffusé chez toi
  $('#self').srcObject = local;
  call = peer.call(pair.id, local, { metadata: { token: pair.t } });
  if (!call) { $('#btn-live').disabled = false; return; }
  document.body.classList.add('in-call');
  $('#live-msg').textContent = 'Connexion à la caméra…';
  call.on('stream', (s) => {
    const v = $('#remote');
    v.srcObject = s;
    v.muted = false;
    v.play().catch(() => { v.muted = true; v.play(); $('#live-msg').textContent = 'Touche la vidéo pour le son'; });
    $('#live-msg').textContent = '';
  });
  call.on('close', stopLive);
  call.on('error', stopLive);
  setTimeout(() => {
    if (call && !$('#remote').srcObject) $('#live-msg').textContent = 'Le direct ne passe pas : réseau 4G trop fermé ? (voir README, relais TURN)';
  }, 15000);
}
function stopLive() {
  if (call) { const c = call; call = null; try { c.close(); } catch { /* */ } }
  if (local) local.getTracks().forEach((t) => t.stop());
  local = null;
  $('#remote').srcObject = null;
  $('#self').srcObject = null;
  document.body.classList.remove('in-call');
  $('#btn-live').disabled = false;
}
function setMic(on) {
  if (local) local.getAudioTracks().forEach((t) => { t.enabled = on; });
  $('#btn-mic').textContent = on ? '🎙️ Micro ouvert' : '🔇 Parler';
  $('#btn-mic').dataset.on = on ? '1' : '0';
}
function toggleCam() {
  if (!local) return;
  const tracks = local.getVideoTracks();
  const on = !(tracks[0] && tracks[0].enabled);
  tracks.forEach((t) => { t.enabled = on; });
  $('#btn-cam').textContent = on ? '📷 Me cacher' : '📷 Me montrer';
  $('#btn-cam').setAttribute('aria-pressed', on ? 'false' : 'true');
}

// ---------------------------------------------------------------- clips
function requestClip(id, btn) {
  if (clips.has(id)) { playClip(id); return; }
  if (!conn || !conn.open) return;
  btn.disabled = true;
  btn.textContent = 'Téléchargement…';
  conn.send({ type: 'clip', id });
}
function progress(id, r) {
  const b = document.querySelector(`[data-clip="${id}"]`);
  if (b) b.textContent = `Téléchargement ${Math.round(r * 100)} %`;
}
function playClip(id) {
  const b = document.querySelector(`[data-clip="${id}"]`);
  if (b) { b.textContent = '▶ Revoir'; b.disabled = false; }
  const v = $('#clip-video');
  v.src = clips.get(id);
  $('#dlg-clip').showModal();
  v.play().catch(() => {});
}

// ---------------------------------------------------------------- rendu
function renderLevel(m) {
  const lvl = Math.max(0, Math.min(1, (m.db + 80) / 60));
  $('#lvl').style.width = (lvl * 100).toFixed(0) + '%';
  $('#dogbar').style.width = (m.dog * 100).toFixed(0) + '%';
  $('#heard').textContent = m.top ? fr(m.top) : '—';
}
function renderStatus() {
  if (!status) return;
  $('#home-status').textContent = status.text;
  $('#home-status').dataset.state = status.watching ? 'on' : 'off';
  let info = `Horaires : ${status.schedule} · effacement à ${status.purgeHour} h`;
  if (status.battery != null) info += ` · batterie ${status.battery} %${status.charging ? ' ⚡' : ' (débranché !)'}`;
  if (status.viaNtfy && journalSeen) {
    const ago = Math.round((Date.now() - journalSeen) / 60000);
    info += ` · direct indisponible : journal reçu par ntfy, nouvelles de la maison à ${hhmm(journalSeen)}`
      + (ago > 75 ? ' ⚠️ (la station ne donne plus signe de vie)' : '');
  }
  $('#home-info').textContent = info;
  $('#btn-pause').textContent = status.paused ? 'Reprendre la surveillance' : 'Mettre en pause';
}
function renderAll() {
  renderStatus();
  const real = events.filter((e) => !e.test);
  const s = summarize(real);
  $('#k-ep').textContent = s.episodes;
  $('#k-bark').textContent = dur(s.barkSec);
  $('#k-long').textContent = s.episodes ? dur(s.longest) : '—';
  $('#verdict').textContent = verdict(s);

  // aboiements par heure
  const hours = new Array(24).fill(0);
  for (const e of real) if (e.type === 'bark') hours[new Date(e.start).getHours()] += e.barkSec || 0;
  const max = Math.max(60, ...hours);
  const chart = $('#chart');
  chart.innerHTML = '';
  for (let h = 6; h < 23; h++) {
    const col = document.createElement('div');
    col.className = 'col';
    col.title = `${h} h : ${dur(hours[h])}`;
    col.innerHTML = `<i style="height:${(hours[h] / max) * 100}%"></i><span>${h % 3 === 0 ? h : ''}</span>`;
    chart.appendChild(col);
  }

  const list = $('#timeline');
  list.innerHTML = '';
  if (!events.length) list.innerHTML = '<li class="muted">Rien pour l’instant aujourd’hui.</li>';
  for (const e of [...events].reverse()) {
    const li = document.createElement('li');
    li.className = e.type;
    const t = `<time>${hhmm(e.start)}</time>`;
    if (e.type === 'bark') {
      const len = Math.max(1, Math.round(((e.end || e.start) - e.start) / 1000));
      li.innerHTML = `${t}<div><strong>${e.test ? 'TEST · ' : ''}🐶 ${fr(e.label)}</strong>
        <small>${dur(e.barkSec)} d’aboiements sur ${dur(len)} · confiance ${Math.round((e.peak || 0) * 100)} %</small></div>`;
      if (e.clipId) {
        const b = document.createElement('button');
        b.dataset.clip = e.clipId;
        b.textContent = clips.has(e.clipId) ? '▶ Revoir' : '▶ Clip';
        b.addEventListener('click', () => requestClip(e.clipId, b));
        li.appendChild(b);
      }
    } else if (e.type === 'sound') {
      li.innerHTML = `${t}<div>${fr(e.label)}${e.count > 1 ? ` <small>×${e.count}</small>` : ''}</div>`;
    } else {
      li.innerHTML = `${t}<div class="muted">${e.label}</div>`;
    }
    list.appendChild(li);
  }
}
function verdict(s) {
  if (!status) return '';
  if (!s.episodes) return 'Aucun aboiement détecté aujourd’hui.';
  const m = s.barkSec / 60;
  if (m < 2) return 'Quelques aboiements isolés : rien d’anormal.';
  if (m < 10) return 'Il aboie par moments : regarde à quelles heures.';
  return 'Ginkgo aboie beaucoup aujourd’hui : la voisine n’a peut-être pas tort.';
}

// ---------------------------------------------------------------- notifications ntfy
function setupNtfy() {
  const server = (pair.s || 'https://ntfy.sh').replace(/\/$/, '');
  $('#v-topic').textContent = pair.n || '(sujet manquant : ré-appaire avec le QR code)';
  try { if (!localStorage.getItem('ginkgocam.ntfyOk')) $('#ntfy-box').open = true; } catch { /* */ }
  $('#btn-copy-topic').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pair.n); $('#ntfy-msg').textContent = 'Sujet copié ✅ — colle-le dans ntfy.'; }
    catch { $('#ntfy-msg').textContent = 'Copie impossible : sélectionne le sujet à la main.'; }
  });
  $('#btn-self-notif').addEventListener('click', async () => {
    $('#ntfy-msg').textContent = 'Envoi…';
    try {
      const r = await fetch(server + '/', {
        method: 'POST',
        body: JSON.stringify({ topic: pair.n, title: 'GinkgoCam', message: 'Test depuis ton iPhone : l’abonnement ntfy marche ✅', tags: ['dog'], click: location.href.split('#')[0] }),
      });
      if (!r.ok) throw new Error('ntfy a répondu ' + r.status);
      $('#ntfy-msg').textContent = 'Envoyée ✅. Rien dans ntfy d’ici 10 s ? Le sujet dans ntfy n’est pas exactement celui-ci : supprime-le et recolle-le.';
      try { localStorage.setItem('ginkgocam.ntfyOk', '1'); } catch { /* */ }
    } catch (err) {
      $('#ntfy-msg').textContent = 'Échec de l’envoi : ' + err.message + ' (pas de réseau ?)';
    }
  });
}

// ---------------------------------------------------------------- journal de secours (ntfy)
// Quand la liaison directe ne passe pas (4G, wifi du travail), on relit le résumé que la station
// dépose dans le sujet ntfy « <sujet>-journal » (silencieux, ntfy le garde 12 h).
let journalTimer = null, journalSeen = 0;
function purgeBoundary(hour) {
  const b = new Date(); b.setHours(hour, 0, 0, 0);
  if (Date.now() < b.getTime()) b.setDate(b.getDate() - 1);
  return b.getTime();
}
async function pollJournal() {
  clearTimeout(journalTimer);
  journalTimer = setTimeout(pollJournal, 60000);
  if (!pair.n || (conn && conn.open)) return;
  const server = (pair.s || 'https://ntfy.sh').replace(/\/$/, '');
  let msgs;
  try {
    const r = await fetch(`${server}/${encodeURIComponent(pair.n + '-journal')}/json?poll=1&since=12h`, { cache: 'no-store' });
    if (!r.ok) throw new Error('ntfy ' + r.status);
    msgs = (await r.text()).split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m && m.event === 'message')
      .map((m) => { try { return JSON.parse(m.message); } catch { return null; } })
      .filter((p) => p && p.v === 1);
  } catch (err) { log('journal ntfy', err); return; }
  if (!msgs.length || (conn && conn.open)) return;
  msgs.sort((a, b) => a.at - b.at);
  const last = msgs[msgs.length - 1];
  const limit = purgeBoundary(last.ph != null ? last.ph : 23);
  const got = [];
  for (const p of msgs) for (const e of p.eps || []) {
    if (e.s < limit) continue;
    got.push({ id: 'n' + e.s, type: 'bark', test: !!e.t, start: e.s, end: e.e, barkSec: e.b, peak: (e.p || 0) / 100, label: e.l || 'Bark' });
  }
  // fusion avec ce qu'on connaît déjà (un même épisode ne compte qu'une fois)
  for (const g of got) {
    if (!events.some((e) => e.type === 'bark' && Math.abs(e.start - g.start) < 3000)) events.push(g);
  }
  events.sort((a, b) => a.start - b.start);
  journalSeen = last.at;
  status = {
    text: last.st, watching: !!last.w, paused: false, schedule: last.sch, purgeHour: last.ph,
    battery: last.bat, charging: last.chg, viaNtfy: true,
  };
  renderAll();
}

// Propose l'icône d'écran d'accueil tant que la page n'est pas ouverte depuis elle.
function setupInstallHint() {
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  let dismissed = false;
  try { dismissed = localStorage.getItem('ginkgocam.installHint') === 'off'; } catch { /* */ }
  if (standalone || dismissed) return;
  $('#install-hint').hidden = false;
  $('#btn-install-ok').addEventListener('click', () => {
    $('#install-hint').hidden = true;
    try { localStorage.setItem('ginkgocam.installHint', 'off'); } catch { /* */ }
  });
}

// ---------------------------------------------------------------- démarrage
if (!pair) {
  document.body.classList.add('unpaired');
} else {
  connect();
  setTimeout(pollJournal, 8000); // laisse 8 s à la liaison directe avant de passer par ntfy
  setupNtfy();
  setupInstallHint();
  $('#btn-live').addEventListener('click', startLive);
  $('#btn-hang').addEventListener('click', stopLive);
  $('#btn-mic').addEventListener('click', () => setMic($('#btn-mic').dataset.on !== '1'));
  $('#btn-cam').addEventListener('click', toggleCam);
  $('#remote').addEventListener('click', (e) => { e.target.muted = false; e.target.play(); $('#live-msg').textContent = ''; });
  $('#btn-pause').addEventListener('click', () => { if (conn && conn.open) conn.send({ type: 'pause', value: !(status && status.paused) }); });
  $('#btn-test').addEventListener('click', () => { if (conn && conn.open) conn.send({ type: 'test' }); });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { $('#clip-video').pause(); b.closest('dialog').close(); }));
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && !(conn && conn.open)) { await sleep(300); connect(); setTimeout(pollJournal, 8000); }
  });
}

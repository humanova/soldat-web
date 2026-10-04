// Soldat TV: the channel guide and the spectator client (soldat-spectate.wasm), fed by the
// spectator hub (relay/spectator.mjs). The game ignores its own keys and mouse in this
// build; this page drives the camera through the soldat_spectator_* exports.
import { SoldatRuntime } from '../runtime.js';
import { flag } from '../flags.js';
import { TvChat, MAX_TEXT, MAX_NAME } from './chat.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const debug = params.has('debug');
const TITLE = document.title;
// a server's own address, /<id> (older links: ?watch=<id>)
const directId = params.get('watch') || decodeURIComponent(location.pathname.split('/').pop()) || null;

const MIN_ZOOM = -0.9, MAX_ZOOM = 1.6;  // Spectator.pas: view scale exp(z)
const TEAMS = { 1: 'Alpha', 2: 'Bravo', 3: 'Charlie', 4: 'Delta' };
const TEAM_GAMES = new Set([2, 3, 5, 6]);  // team match, CTF, infiltration, hold the flag
const TEAM_TEXT = { 1: 'var(--alpha-text)', 2: 'var(--bravo-text)', 3: 'var(--charlie-text)', 4: 'var(--delta-text)' };
const MODES = { DM: 'Deathmatch', PM: 'Pointmatch', TM: 'Teammatch', CTF: 'Capture the Flag',
  RM: 'Rambomatch', INF: 'Infiltration', HTF: 'Hold the Flag' };

// ?hub=wss://example.org lets a page hosted elsewhere use a hub
function hubBase() {
  const hub = params.get('hub');
  if (hub) return hub.replace(/\/+$/, '').replace(/\/watch$/, '');
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}
const httpBase = () => hubBase().replace(/^ws/, 'http');

const prefs = (() => {
  try { return { muted: false, ...JSON.parse(localStorage.getItem('soldattv') || '{}') }; } catch (_) { return { muted: false }; }
})();
function savePrefs() {
  try { localStorage.setItem('soldattv', JSON.stringify(prefs)); } catch (_) {}
}

// passwords of servers that ask for one, kept while the tab is open (a link's ?password= goes in
// here and out of the address bar)
const passwords = (() => {
  try { return new Map(Object.entries(JSON.parse(sessionStorage.getItem('soldattv.passwords') || '{}'))); } catch (_) { return new Map(); }
})();
function savePasswords() {
  try { sessionStorage.setItem('soldattv.passwords', JSON.stringify(Object.fromEntries(passwords))); } catch (_) {}
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ======================================================================= game

const canvas = $('canvas');
let watching = null;  // the channel being watched

const game = new SoldatRuntime(canvas, {
  input: false,
  relayUrl: () => hubBase() + '/watch',
  relayRequest(kind, d) {
    if (kind === 'files') return { type: 'files', server: watching && watching.id, files: d.files };
    return { type: 'watch', server: watching && watching.id, password: watching ? passwords.get(watching.id) : undefined };
  },
  onRelayMessage: onHubMessage,
  args: debug ? ['-log_level', params.get('debug') || '1'] : [],
  displaySize() {
    // always a landscape picture; phones get at most 2x their CSS size (sharp and cheap)
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.round(Math.max(screen.width, screen.height) * dpr);
    let h = Math.round(Math.min(screen.width, screen.height) * dpr);
    const max = 2560 * 1600;
    if (w * h > max) { const s = Math.sqrt(max / (w * h)); w = Math.round(w * s); h = Math.round(h * s); }
    return [w, h];
  },
  onNetError(message, data) {
    const ch = watching;
    const password = !!(ch && data && data.reason === 'password');
    if (!password) setStatus(message, true);
    if (watching) game.leave();
    // the server's password was wrong or is needed: ask for it
    if (password) {
      passwords.delete(ch.id);
      savePasswords();
      askPassword(ch, message);
    }
  },
  onLeave: () => showGuide(),
  onExit: () => showGuide(),
});
window.soldat = game; // for debugging from the browser console

// a client setting, without the console line game.command would print
function setCvar(name, value) {
  const n = game.rt.allocCString(name), v = game.rt.allocCString(value);
  try { game.call('soldat_spectator_set', n, v); } finally { game.rt.free(n); game.rt.free(v); }
}

function call(name, ...args) {
  if (!game.running) return 0;
  try { return game.call(name, ...args); } catch (e) { console.error(e); return 0; }
}

// ================================================================= the hub

function onHubMessage(msg) {
  if (msg.type === 'ready') {
    // the client recognizes "its" spectator by the name: it plays the hub's part
    setCvar('cl_player_name', String(msg.name));
    notice('');
    $('ch-delay').hidden = !msg.delay;
    $('ch-delay').textContent = `${msg.delay} s delay`;
    joinedAt = performance.now();
  } else if (msg.type === 'status') {
    notice(msg.message);
  } else if (msg.type === 'follow') {
    director = msg.slot | 0;
    if (debug) console.log('[tv] director follows slot', director);
    if (mode === 'auto') call('soldat_spectator_follow', director);
  }
}

function notice(text) {
  $('notice').textContent = text || '';
  $('notice').hidden = !text;
}

// =============================================================== watching

let mode = 'auto';      // auto (the hub's director), player, free, overview
let director = 0;       // the director's pick
let zoom = 0;
let zoomBeforeMap = 0;
let joinedAt = 0;
let match = null;       // the last state snapshot
let pollTimer = 0;

function watch(ch) {
  watching = ch;
  tab = ch.group || null;
  setStatus('');
  $('ch-name').textContent = ch.name;
  $('ch-delay').hidden = true;
  $('scorebug').hidden = true;
  $('card').hidden = true;
  $('banners').textContent = '';
  $('bigmsg').hidden = true;
  scoreKey = cardKey = rosterKey = '';
  chatLines.length = 0;
  $('chat-lines').textContent = '';
  toggleChat(!!prefs.chat);
  listen();
  $('tvchat-btn').querySelector('.unread').hidden = true;
  toggleTvChat(!!prefs.tvchat);
  director = 0;
  zoom = 0;
  match = null;
  setMode('auto', true);
  notice('Tuning in...');
  $('guide').hidden = true;
  $('watch').hidden = false;
  fitPicture();
  // phones watch on the whole screen, held sideways (not on an iPhone: no full screen for pages)
  if (phone && document.fullscreenEnabled && !document.fullscreenElement) enterFullscreen();
  history.replaceState(null, '', './' + encodeURIComponent(ch.id) + (debug ? '?debug' : ''));
  document.title = `${ch.name} · Soldat TV`;
  setCvar('cl_player_team', '5');  // join as a spectator, no team menu
  setCvar('snd_volume', prefs.muted ? '0' : '60');
  if (!game.join('tv', 1, '')) {
    showGuide();
    setStatus('Could not start watching.', true);
    return;
  }
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 250);
  wake();
  canvas.focus();
}

function showGuide() {
  watching = null;
  clearInterval(pollTimer);
  notice('');
  closeRoster();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('watch').hidden = true;
  $('guide').hidden = false;
  listen();
  showTabAddress();
  document.title = TITLE;
  refresh();
}

// ---------- camera modes

function setMode(m, quiet) {
  const was = mode;
  mode = m;
  $('auto').setAttribute('aria-pressed', String(m === 'auto'));
  $('map').setAttribute('aria-pressed', String(m === 'overview'));
  if (match) renderTarget(match);
  if (quiet) return;
  if (m === 'overview') {
    if (was !== 'overview') zoomBeforeMap = zoom;
    const z = call('soldat_spectator_overview');
    setZoom(z, 0.5, 0.5);
    return;
  }
  if (was === 'overview' && m !== 'free') setZoom(zoomBeforeMap, 0.5, 0.5);
  if (m === 'auto') follow(director || firstPlayer());
  else if (m === 'player') follow((match && match.follow) || firstPlayer());
  else if (m === 'free') call('soldat_spectator_follow', 0);
}

function follow(slot) {
  if (slot) call('soldat_spectator_follow', slot);
}

function players() {
  return match ? match.players : [];
}

function firstPlayer() {
  const p = players().find(q => !q.dead) || players()[0];
  return p ? p.slot : 0;
}

// next or previous player, in the order of the roster
function cycle(step) {
  const list = orderedPlayers();
  if (!list.length) return;
  const cur = list.findIndex(p => p.slot === (match && match.follow));
  const next = list[(cur + step + list.length) % list.length];
  setMode('player', true);
  follow(next.slot);
}

function orderedPlayers() {
  return players().slice().sort((a, b) => a.team - b.team || b.kills - a.kills || a.slot - b.slot);
}

// ---------- zoom (the game's spectator zoom; fx, fy: the point that stays put)

function setZoom(z, fx = 0.5, fy = 0.5) {
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  call('soldat_spectator_zoom', zoom, fx, fy);
}

// phones: the picture fills the screen. The game draws it in the screen's shape; what the
// browser's own bars take off that is cut from the edges, not shown as black bars.
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 600;
const MAX_CROP = 0.15;  // more than this off the picture: black bars after all

function fitPicture() {
  const r = canvas.getBoundingClientRect();
  const ar = canvas.width / canvas.height;
  let cover = false;
  if (phone && r.width && r.height && ar) {
    const a = r.width / r.height;
    cover = 1 - Math.min(a, ar) / Math.max(a, ar) <= MAX_CROP;
  }
  canvas.classList.toggle('cover', cover);
}

// where the picture is on the page (object-fit: contain, or cover on phones)
function picture() {
  const r = canvas.getBoundingClientRect();
  const ar = canvas.width / canvas.height || 16 / 9;
  let w = r.width, h = r.height;
  if ((w / h > ar) !== canvas.classList.contains('cover')) w = h * ar; else h = w / ar;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
}
function frac(clientX, clientY) {
  const p = picture();
  return [(clientX - p.x) / p.w, (clientY - p.y) / p.h];
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  // a touchpad pinch arrives as a wheel event with ctrlKey
  const k = e.ctrlKey ? 0.012 : 0.0016;
  const [fx, fy] = frac(e.clientX, e.clientY);
  setZoom(zoom + e.deltaY * unit * k, fx, fy);
  wake();
}, { passive: false });

// drag to look around (switches to the free camera), two fingers to zoom
const pointers = new Map();
let gesture = null;

canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gesture = startGesture();
  game.al.resume();
});
$('watch').addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wake(); });
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;
  moveGesture();
});
const endPointer = (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const g = gesture;
  gesture = pointers.size ? startGesture() : null;
  canvas.classList.toggle('dragging', false);
  // a tap shows or hides the controls on touch screens
  if (g && !g.moved && !pointers.size && e.pointerType !== 'mouse' && performance.now() - g.t < 300) toggleUi();
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', () => { if (mode !== 'overview') setZoom(0); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function centroid() {
  let x = 0, y = 0;
  for (const p of pointers.values()) { x += p.x; y += p.y; }
  return { x: x / pointers.size, y: y / pointers.size };
}
function spread() {
  const [a, b] = [...pointers.values()];
  return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
function startGesture() {
  const c = centroid();
  return { c, c0: c, d: spread(), z: zoom, moved: false, panned: false, t: performance.now() };
}
function moveGesture() {
  if (!gesture || !pointers.size) return;
  const c = centroid();
  const pic = picture();
  const dx = c.x - gesture.c.x, dy = c.y - gesture.c.y;
  if (!gesture.moved && Math.hypot(dx, dy) < 6 && (pointers.size < 2 || Math.abs(spread() - gesture.d) < 8)) return;
  gesture.moved = true;
  canvas.classList.toggle('dragging', true);
  if (pointers.size >= 2 && gesture.d > 0) {
    const [fx, fy] = frac(c.x, c.y);
    setZoom(gesture.z - Math.log(spread() / gesture.d), fx, fy);
  }
  // one finger looks around; two only once they move together (a pinch alone keeps following)
  if (pointers.size === 1 || gesture.panned || Math.hypot(c.x - gesture.c0.x, c.y - gesture.c0.y) > 24) {
    gesture.panned = true;
    if (mode !== 'free') setMode('free', true);
    call('soldat_spectator_pan', -dx / pic.w, -dy / pic.h);
  }
  gesture.c = c;
}

// ---------- controls

$('auto').addEventListener('click', () => setMode('auto'));
// Map again goes back to following the action
$('map').addEventListener('click', () => setMode(mode === 'overview' ? 'auto' : 'overview'));
$('prev').addEventListener('click', () => cycle(-1));
$('next').addEventListener('click', () => cycle(1));
$('target').addEventListener('click', () => toggleRoster());
$('zoom-in').addEventListener('click', () => setZoom(zoom - 0.25));
$('zoom-out').addEventListener('click', () => setZoom(zoom + 0.25));
$('roster-btn').addEventListener('click', () => toggleRoster());
$('chat-btn').addEventListener('click', () => toggleChat());
$('tvchat-btn').addEventListener('click', () => toggleTvChat());
$('back').addEventListener('click', () => game.leave());
$('sound').addEventListener('click', () => {
  prefs.muted = !prefs.muted;
  savePrefs();
  showSound();
  setCvar('snd_volume', prefs.muted ? '0' : '60');
  game.al.resume();
});
$('fullscreen').addEventListener('click', toggleFullscreen);

function showSound() {
  $('sound').querySelector('use').setAttribute('href', prefs.muted ? '#i-mute' : '#i-sound');
  $('sound').setAttribute('aria-label', prefs.muted ? 'Unmute' : 'Mute');
}
showSound();

async function toggleFullscreen() {
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
  await enterFullscreen();
}
async function enterFullscreen() {
  try {
    await $('watch').requestFullscreen({ navigationUI: 'hide' });
    // phones: keep the landscape picture (works only in full screen, not everywhere)
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch (_) {}
}
if (!document.fullscreenEnabled) $('fullscreen').hidden = true;

window.addEventListener('keydown', (e) => {
  if (!watching || e.ctrlKey || e.metaKey || e.altKey) return;
  // Enter on a button presses it
  if (e.code === 'Enter' && e.target.closest && e.target.closest('button')) return;
  const keys = {
    ArrowLeft: () => cycle(-1), ArrowRight: () => cycle(1),
    KeyA: () => setMode('auto'), KeyP: () => setMode('player'), KeyF: () => setMode('free'),
    KeyO: () => setMode('overview'), KeyM: () => setMode('overview'),
    Equal: () => setZoom(zoom - 0.25), NumpadAdd: () => setZoom(zoom - 0.25),
    Minus: () => setZoom(zoom + 0.25), NumpadSubtract: () => setZoom(zoom + 0.25),
    Digit0: () => setZoom(0), Tab: () => toggleRoster(), KeyC: () => toggleChat(),
    Escape: () => closeRoster(), Enter: () => sayKey(),
  };
  const pan = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1] }[e.code];
  if (pan) {
    if (mode !== 'free') setMode('free', true);
    call('soldat_spectator_pan', pan[0] * 0.08, pan[1] * 0.08);
  } else if (keys[e.code]) {
    keys[e.code]();
  } else {
    return;
  }
  e.preventDefault();
  wake();
});

// Enter: to Soldat TV's chat
function sayKey() {
  if ($('tvchat').hidden) toggleTvChat(true);
  $('tvchat').querySelector('.say-text').focus();
}

// ---------- controls fade out while nothing happens

let idleTimer = 0;
function wake() {
  $('watch').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!$('dock').matches(':hover') && $('roster').hidden) $('watch').classList.add('idle');
  }, 3200);
}
function toggleUi() {
  if ($('watch').classList.contains('idle')) wake();
  else { clearTimeout(idleTimer); $('watch').classList.add('idle'); }
}
for (const id of ['dock', 'roster']) $(id).addEventListener('pointerdown', wake);

// ---------- movable panels: dragged by their bar (the score and the flag news anywhere), a
// double-click on it puts the panel back. Kept as fractions of the free room across and down,
// so a panel at an edge stays there on any screen.

const layout = (prefs.layout && typeof prefs.layout === 'object') ? prefs.layout : (prefs.layout = {});
const movables = [...document.querySelectorAll('#watch .move')];

function place(box) {
  const pos = layout[box.dataset.move];
  if (!Array.isArray(pos)) {
    box.classList.remove('placed');
    box.style.left = box.style.top = '';
    delete box.dataset.align;
    return;
  }
  const area = $('watch');
  box.classList.add('placed');
  box.style.left = `${Math.round(Math.max(0, area.clientWidth - box.offsetWidth) * pos[0])}px`;
  box.style.top = `${Math.round(Math.max(0, area.clientHeight - box.offsetHeight) * pos[1])}px`;
  box.dataset.align = pos[0] < 0.34 ? 'start' : pos[0] > 0.66 ? 'end' : 'center';
}

function startMove(e, box) {
  if (e.button !== 0 || (e.target.closest('button') && !e.target.closest('.handle'))) return;
  e.preventDefault();
  wake();
  const area = $('watch').getBoundingClientRect();
  const r = box.getBoundingClientRect();
  const dx = e.clientX - r.left, dy = e.clientY - r.top;
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
    moved = true;
    box.classList.add('moving');
    const freeX = area.width - box.offsetWidth, freeY = area.height - box.offsetHeight;
    const x = Math.min(Math.max(0, ev.clientX - area.left - dx), Math.max(0, freeX));
    const y = Math.min(Math.max(0, ev.clientY - area.top - dy), Math.max(0, freeY));
    layout[box.dataset.move] = [freeX > 0 ? x / freeX : 0.5, freeY > 0 ? y / freeY : 0.5];
    place(box);
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    box.classList.remove('moving');
    if (moved) savePrefs();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

for (const box of movables) {
  const handles = box.querySelector('.handle') ? box.querySelectorAll('.handle') : [box];
  for (const h of handles) {
    h.addEventListener('pointerdown', (e) => startMove(e, box));
    h.addEventListener('dblclick', () => { delete layout[box.dataset.move]; savePrefs(); place(box); });
  }
  // a panel that grows or shrinks keeps its place against the nearest edges
  new ResizeObserver(() => place(box)).observe(box);
}
window.addEventListener('resize', () => { fitPicture(); movables.forEach(place); });
document.addEventListener('fullscreenchange', () => { fitPicture(); movables.forEach(place); });

// ---------- the match state (soldat_spectator_state, Spectator.pas)

const stateBuf = { ptr: 0, size: 16384 };

function readState() {
  if (!stateBuf.ptr) stateBuf.ptr = game.rt.alloc(stateBuf.size);
  const n = call('soldat_spectator_state', stateBuf.ptr, stateBuf.size);
  if (!n) return null;
  const text = new TextDecoder('latin1').decode(game.rt.u8().subarray(stateBuf.ptr, stateBuf.ptr + n));
  const s = { players: [], spectators: [], flags: [] };
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'M') {
      Object.assign(s, { style: +f[1], map: f[2], seconds: +f[3], scores: [0, +f[4], +f[5], +f[6], +f[7]],
        follow: +f[8], zoom: +f[9] });
    } else if (f[0] === 'P') {
      s.players.push({ slot: +f[1], team: +f[2], kills: +f[3], deaths: +f[4], caps: +f[5], dead: f[6] === '1',
        flag: +f[7], health: +f[8], color: '#' + f[9], gun: +f[10], weapon: f[11], name: f.slice(12).join('\t') });
    } else if (f[0] === 'S') {
      s.spectators.push({ slot: +f[1], name: f.slice(2).join('\t') });
    } else if (f[0] === 'G') {
      s.flags.push({ flag: +f[1], state: +f[2], carrier: +f[3] });  // state: 0 base, 1 carried, 2 dropped
    }
  }
  return s;
}

// chat and flag events since the last poll (soldat_spectator_events, Spectator.pas)
const eventBuf = { ptr: 0, size: 32768 };
function readEvents() {
  if (!eventBuf.ptr) eventBuf.ptr = game.rt.alloc(eventBuf.size);
  const n = call('soldat_spectator_events', eventBuf.ptr, eventBuf.size);
  if (!n) return;
  const text = new TextDecoder('utf-8').decode(game.rt.u8().subarray(eventBuf.ptr, eventBuf.ptr + n));
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'C') {
      addChat({ slot: +f[1], team: +f[2], kind: +f[3], name: f[4], text: f.slice(5).join('\t') });
    } else if (f[0] === 'F') {
      flagEvent({ kind: f[1], flag: +f[2], slot: +f[3], team: +f[4], name: f.slice(5).join('\t') });
    }
  }
}

function poll() {
  if (!game.running) return;
  readEvents();
  const s = readState();
  if (!s) return;
  match = s;
  // the followed player left: the game shows the free camera
  if (!s.follow && (mode === 'auto' || mode === 'player') && s.players.length) {
    follow(mode === 'auto' && director && s.players.some(p => p.slot === director) ? director : firstPlayer());
  }
  // joining resets the zoom
  if (Math.abs(s.zoom - zoom) > 0.01 && performance.now() - joinedAt < 5000) setZoom(zoom);
  renderScorebug(s);
  renderTarget(s);
  renderCard(s);
  if (!$('roster').hidden) renderRoster(s);
}

function clock(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

const FLAG_NAMES = { 1: 'Red', 2: 'Blue', 3: 'Yellow' };
const FLAG_COLORS = { 1: 'var(--alpha)', 2: 'var(--bravo)', 3: 'var(--charlie)' };

function flagIcon(style) {
  const f = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  f.setAttribute('class', 'flag');
  f.style.color = FLAG_COLORS[style] || 'var(--charlie)';
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-flag');
  f.append(u);
  return f;
}

// ---------- the score, always on screen

let scoreKey = '';
function renderScorebug(s) {
  const bug = $('scorebug');
  const teams = TEAM_GAMES.has(s.style)
    ? [1, 2, 3, 4].filter(t => t <= 2 || s.players.some(p => p.team === t)) : [];
  const name = (slot) => (s.players.find(p => p.slot === slot) || {}).name || '';
  const flags = s.flags.map(g => ({ ...g, name: name(g.carrier) }));
  const lead = teams.length ? null : s.players.slice().sort((a, b) => b.kills - a.kills)[0];
  const key = JSON.stringify([teams, s.scores, s.seconds, flags, lead && [lead.name, lead.kills]]);
  if (key === scoreKey) return;
  scoreKey = key;
  bug.textContent = '';

  const row = el('div', 'sb-row');
  const side = (t) => {
    const box = el('span', `side t${t}`);
    box.append(el('span', 'tname', TEAMS[t]), el('b', 'score', String(s.scores[t])));
    return box;
  };
  if (teams.length) {
    const half = Math.ceil(teams.length / 2);
    for (const t of teams.slice(0, half)) row.append(side(t));
    row.append(el('span', 'clock', clock(s.seconds)));
    for (const t of teams.slice(half)) row.append(side(t));
  } else {
    row.append(el('span', 'clock', clock(s.seconds)));
    if (lead) {
      const l = el('span', 'leader');
      l.append(el('span', 'tname', 'Leader'), el('span', 'who', lead.name), el('b', 'score', String(lead.kills)));
      row.append(l);
    }
  }
  bug.append(row);

  // where the flags are: under their team (the yellow one in the middle)
  if (flags.length) {
    const st = el('div', 'sb-flags');
    const status = (g) => {
      const box = el('span', 'fstat ' + ['base', 'taken', 'dropped'][g.state]);
      box.append(flagIcon(g.flag), el('span', '', g.state === 1 ? g.name || 'Taken' : g.state === 2 ? 'Dropped' : 'In base'));
      box.title = `${FLAG_NAMES[g.flag]} flag: ` +
        (g.state === 1 ? `carried by ${g.name}` : g.state === 2 ? 'dropped' : 'in its base');
      return box;
    };
    const red = flags.find(g => g.flag === 1), blue = flags.find(g => g.flag === 2), yellow = flags.find(g => g.flag === 3);
    st.append(red ? status(red) : el('span'), yellow ? status(yellow) : el('span'), blue ? status(blue) : el('span'));
    bug.append(st);
  }
  bug.hidden = false;
}

// ---------- flag news: the newest two lines; a score is the game's big message

function flagEvent(e) {
  if (e.kind === 'score') { bigMessage(e); return; }
  const inf = match && match.style === 5;
  const thing = inf ? 'the objective' : `the ${FLAG_NAMES[e.flag] || ''} flag`;
  const li = el('li', 'banner ' + e.kind);
  li.style.setProperty('--c', FLAG_COLORS[e.flag] || 'var(--charlie)');
  li.append(flagIcon(e.flag));
  if (e.name) {
    const who = el('b', '', e.name);
    who.style.color = teamColor({ team: e.team }, true);
    li.append(who);
  }
  li.append(` ${{ take: inf ? 'captured' : 'took', drop: 'dropped', return: 'returned' }[e.kind] || e.kind} ${thing}`);
  const list = $('banners');
  list.append(li);
  while (list.children.length > 2) list.firstElementChild.remove();
  setTimeout(() => { li.classList.add('gone'); setTimeout(() => li.remove(), 400); }, 4500);
}

let bigTimer = 0;
function bigMessage(e) {
  const box = $('bigmsg');
  box.textContent = '';
  box.style.setProperty('--c', teamColor({ team: e.flag }, true));
  box.append(el('span', 'big', `${TEAMS[e.flag] || ''} Team Scores!`));
  if (e.name) box.append(el('span', 'by', e.name));
  box.classList.remove('gone');
  box.hidden = false;
  clearTimeout(bigTimer);
  bigTimer = setTimeout(() => {
    box.classList.add('gone');
    bigTimer = setTimeout(() => { box.hidden = true; }, 600);
  }, 4000);
}

// ---------- chat (off unless the viewer opens it)

const chatLines = [];
function addChat(c) {
  chatLines.push(c);
  if (chatLines.length > 150) chatLines.shift();
  if ($('chat').hidden) { $('chat-btn').querySelector('.unread').hidden = false; return; }
  appendChat(c);
}
// like the game's console: [Name] text, team chat and radio in its team chat colour
function appendChat(c) {
  const li = el('li', 'line' + (c.kind === 3 ? ' server' : c.kind === 1 || c.kind === 2 ? ' team' : ''));
  if (c.kind === 1 || c.kind === 2) li.append(c.kind === 1 ? '(TEAM) ' : '(RADIO) ');
  const who = el('b', '', `[${c.kind === 3 ? 'Server' : c.name}]`);
  if (c.kind !== 3) who.style.color = c.team === 5 ? 'var(--muted)' : teamColor({ team: c.team }, true);
  li.append(who, ' ', c.text);
  pushLine($('chat'), li, 150);
}
function toggleChat(open = $('chat').hidden) {
  $('chat').hidden = !open;
  $('chat-btn').setAttribute('aria-expanded', String(open));
  prefs.chat = open;
  savePrefs();
  if (open) {
    $('chat-btn').querySelector('.unread').hidden = true;
    $('chat-lines').textContent = '';
    $('chat').classList.toggle('has-lines', chatLines.length > 0);
    for (const c of chatLines) appendChat(c);
    const scroll = $('chat').querySelector('.chat-scroll');
    scroll.scrollTop = scroll.scrollHeight;
  }
}

// a chat box: its lines, kept scrolled to the newest unless the viewer scrolled up
function pushLine(box, li, keep = 300) {
  const ol = box.querySelector('.chat-lines'), scroll = box.querySelector('.chat-scroll');
  const stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  ol.append(li);
  while (ol.children.length > keep) ol.firstElementChild.remove();
  box.classList.add('has-lines');
  if (stick) scroll.scrollTop = scroll.scrollHeight;
}

// ---------- Soldat TV's chat (js/spectate/chat.js), on one connection while watching:
// everyone on the site (Global) and who watches the same server (This server). The window
// shows the channels whose boxes are ticked, each line with its channel.

const tvBox = $('tvchat');
const tvChannels = { global: prefs.tvGlobal !== false, server: prefs.tvServer !== false };
let sayTo = prefs.sayTo === 'server' ? 'server' : 'global';
const roomOf = (channel) => channel === 'global' ? null : watching ? watching.id : undefined;

// the rooms the window shows (none on the guide)
function tvRooms() {
  if (!watching) return [];
  return ['global', 'server'].filter(c => tvChannels[c]).map(roomOf);
}

function tvLine(l) {
  const li = el('li', 'line tv');
  if (l.error) { li.classList.add('note'); li.textContent = l.error; return li; }
  const server = l.room !== null;
  li.append(el('span', 'ch-tag' + (server ? ' server' : ''), `[${server ? (watching && watching.id === l.room ? watching.name : l.room) : 'Global'}]`), ' ');
  const who = el('b', '', l.name);
  let h = 0;
  for (const ch of l.name) h = (h * 31 + ch.codePointAt(0)) % 360;
  who.style.color = `hsl(${h} 70% 74%)`;
  li.append(who, ': ', l.text);
  li.title = new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return li;
}

function renderTv() {
  if (!watching || tvBox.hidden) return;
  const rooms = tvRooms();
  tvBox.querySelector('.chat-lines').textContent = '';
  tvBox.querySelector('.chat-empty').textContent = !tv.online ? 'Connecting to the chat...'
    : rooms.length ? 'Nobody said anything in the last 10 minutes.' : 'Tick a channel to see its chat.';
  tvBox.classList.remove('has-lines');
  for (const l of tv.merged(rooms)) pushLine(tvBox, tvLine(l));
  const scroll = tvBox.querySelector('.chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;
}

// the channels listened to: the ticked ones while watching, none on the guide
function listen() {
  tv.listen(tvRooms());
  for (const box of tvBox.querySelectorAll('.chat-filters input')) box.checked = tvChannels[box.dataset.channel];
  if (!tvChannels[sayTo] && tvChannels[sayTo === 'global' ? 'server' : 'global']) sayTo = sayTo === 'global' ? 'server' : 'global';
  renderTv();
  showComposer();
}

for (const box of tvBox.querySelectorAll('.chat-filters input')) {
  box.addEventListener('change', () => {
    tvChannels[box.dataset.channel] = box.checked;
    prefs.tvGlobal = tvChannels.global;
    prefs.tvServer = tvChannels.server;
    savePrefs();
    listen();
  });
}

function toggleTvChat(open = tvBox.hidden) {
  tvBox.hidden = !open;
  $('tvchat-btn').setAttribute('aria-expanded', String(open));
  prefs.tvchat = open;
  savePrefs();
  if (open) {
    $('tvchat-btn').querySelector('.unread').hidden = true;
    renderTv();
  }
}

const tv = new TvChat(() => hubBase() + '/chat', (room, line) => {
  if (line && line.error) { pushLine(tvBox, tvLine(line)); return; }
  if (!line) {
    // a room's last 10 minutes, or the chat went off or on line
    renderTv();
    showComposer();
    return;
  }
  if (!tvRooms().includes(room)) return;
  if (tvBox.hidden) $('tvchat-btn').querySelector('.unread').hidden = false;
  else pushLine(tvBox, tvLine(line));
});

// what to say, and once, the nickname (kept on this device; the nickname button changes it)
let naming = false;
const sayInput = tvBox.querySelector('.say-text');

function showComposer() {
  const nick = tvBox.querySelector('.say-nick'), to = tvBox.querySelector('.say-to');
  const asking = !prefs.nick || naming;
  const channel = tvChannels[sayTo] ? sayTo : null;
  nick.textContent = prefs.nick || '';
  nick.title = 'Change your nickname';
  nick.hidden = asking;
  to.textContent = channel === 'server' && watching ? watching.name : 'Global';
  to.classList.toggle('server', channel === 'server');
  to.hidden = asking || !channel;
  sayInput.maxLength = asking ? MAX_NAME : MAX_TEXT;
  sayInput.disabled = !tv.online || (!asking && !channel);
  sayInput.placeholder = !tv.online ? 'Connecting...' : asking ? 'Choose a nickname to chat'
    : !channel ? 'Tick a channel to chat' : 'Say something';
}

tvBox.querySelector('.say-nick').addEventListener('click', () => {
  naming = true;
  showComposer();
  sayInput.value = prefs.nick || '';
  sayInput.focus();
  sayInput.select();
});
// the channel to write to: the other ticked one
tvBox.querySelector('.say-to').addEventListener('click', () => {
  const other = sayTo === 'global' ? 'server' : 'global';
  if (tvChannels[other]) { sayTo = prefs.sayTo = other; savePrefs(); }
  showComposer();
  sayInput.focus();
});
tvBox.querySelector('form.say').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = sayInput.value.replace(/\s+/g, ' ').trim();
  if (!prefs.nick || naming) {
    if (!text) return;
    prefs.nick = [...text].slice(0, MAX_NAME).join('');
    savePrefs();
    naming = false;
    sayInput.value = '';
    showComposer();
    return;
  }
  const room = roomOf(sayTo);
  if (!text || room === undefined) return;
  tv.say(room, prefs.nick, text);
  sayInput.value = '';
});
sayInput.addEventListener('keydown', (e) => {
  // the match's keys stay out of the text
  e.stopPropagation();
  if (e.key !== 'Escape') return;
  if (naming) { naming = false; sayInput.value = ''; showComposer(); }
  else sayInput.blur();
});
listen();

// ---------- the followed player

function renderTarget(s) {
  const p = s.players.find(q => q.slot === s.follow);
  const t = $('target');
  t.querySelector('span').textContent = p ? p.name : mode === 'overview' ? 'Whole map' : 'Free camera';
  t.querySelector('.swatch').style.background = p ? teamColor(p) : 'transparent';
  t.querySelector('.hp i').style.width = p ? `${p.dead ? 0 : p.health}%` : '0';
  t.title = p ? `${p.name} · ${p.weapon} · ${p.health}%` : '';
}

// the weapon pictures of the game's kill feed (interface-gfx/guns), by the weapon number
// of the state line (Weapons.pas: *_NUM; 1-10 are the primaries, 255 empty hands)
const GUN_FILES = { 0: '10', 11: 'knife', 12: 'chainsaw', 13: 'law', 14: 'flamer', 15: 'bow', 16: 'bow', 30: 'm2',
  255: 'fist' };
const gunUrls = new Map();
function gunPicture(num) {
  const file = num >= 1 && num <= 10 ? String(num % 10) : GUN_FILES[num];
  if (file === undefined) return '';
  if (!gunUrls.has(file)) {
    const pack = game.archives.get('soldat/soldat.smod');
    const entry = pack && pack.get(`interface-gfx/guns/${file}.png`);
    gunUrls.set(file, entry && entry.data ? URL.createObjectURL(new Blob([entry.data], { type: 'image/png' })) : '');
  }
  return gunUrls.get(file);
}

let cardKey = '';
function renderCard(s) {
  const p = s.players.find(q => q.slot === s.follow);
  const card = $('card');
  if (!p || mode === 'overview') { card.hidden = true; cardKey = ''; return; }
  const key = JSON.stringify(p);
  if (key === cardKey && !card.hidden) return;
  cardKey = key;
  card.style.setProperty('--c', teamColor(p));
  card.style.setProperty('--tt', teamColor(p, true));
  const name = card.querySelector('.c-name');
  name.textContent = p.name;
  const head = card.querySelector('.win-head');
  head.querySelector('.flag')?.remove();
  if (p.flag) head.prepend(flagIcon(p.flag));

  const weapon = card.querySelector('.c-weapon');
  const url = p.dead ? '' : gunPicture(p.gun);
  let img = weapon.querySelector('img');
  if (url) {
    if (!img) { weapon.textContent = ''; img = weapon.appendChild(new Image()); }
    if (img.getAttribute('src') !== url) img.src = url;
    img.alt = p.weapon;
  } else {
    weapon.textContent = p.dead ? 'Dead' : p.weapon;
  }
  weapon.title = p.weapon;
  card.querySelector('.k').textContent = p.kills;
  card.querySelector('.d').textContent = p.deaths;
  card.querySelector('.kd').title = `${p.kills} kills, ${p.deaths} deaths`;
  const hp = card.querySelector('.c-hp');
  hp.classList.toggle('low', p.health <= 30);
  hp.firstElementChild.style.width = `${p.dead ? 0 : p.health}%`;
  card.classList.toggle('dead', p.dead);
  card.hidden = false;
}

function teamColor(p, light) {
  const c = { 1: 'alpha', 2: 'bravo', 3: 'charlie', 4: 'delta' }[p.team];
  if (c) return `var(--${c}${light ? '-text' : ''})`;
  return light ? 'var(--text)' : p.color || 'var(--dim)';
}

// ---------- players

function toggleRoster() {
  if ($('roster').hidden) {
    $('roster').hidden = false;
    $('roster-btn').setAttribute('aria-expanded', 'true');
    rosterKey = '';
    if (match) renderRoster(match);
    wake();
  } else {
    closeRoster();
  }
}
function closeRoster() {
  $('roster').hidden = true;
  $('roster-btn').setAttribute('aria-expanded', 'false');
}

// rebuilt only when something in it changes, so a click on a player is not lost
let rosterKey = '';
function renderRoster(s) {
  const key = JSON.stringify([s.style, s.scores, s.follow, s.spectators,
    s.players.map(p => [p.slot, p.team, p.kills, p.deaths, p.dead, p.flag, p.name])]);
  if (key === rosterKey) return;
  rosterKey = key;
  const box = $('roster-list');
  const scroll = box.scrollTop;
  box.textContent = '';
  const groups = new Map();
  for (const p of orderedPlayers()) {
    const key = TEAM_GAMES.has(s.style) ? p.team : 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  if (!groups.size) {
    const h = el('h3');
    h.append(el('span', 'who', 'Nobody is playing'));
    box.append(h);
  }
  for (const [team, list] of groups) {
    const h = el('h3');
    const name = el('span', 'who');
    if (team) {
      const sw = el('i');
      sw.style.background = teamColor({ team });
      h.style.setProperty('--tt', teamColor({ team }, true));
      name.append(sw, document.createTextNode(TEAMS[team] || 'Players'), el('b', '', String(s.scores[team] ?? '')));
    } else {
      name.append(document.createTextNode('Players'));
    }
    h.append(name, el('span', 'num k', 'K'), el('span', 'num d', 'D'));
    box.append(h);
    for (const p of list) {
      const row = el('button', 'player' + (p.dead ? ' dead' : '') + (p.slot === s.follow ? ' followed' : ''));
      row.type = 'button';
      const who = el('span', 'who');
      const sw = el('i', 'swatch');
      sw.style.background = teamColor(p);
      who.append(sw, el('span', '', p.name));
      if (p.flag) who.append(flagIcon(p.flag));
      row.append(who, el('span', 'n k', String(p.kills)), el('span', 'n d', String(p.deaths)));
      row.addEventListener('click', () => { setMode('player', true); follow(p.slot); });
      box.append(row);
    }
  }
  if (s.spectators.length) {
    const h = el('h3', 'spec-head');
    const name = el('span', 'who');
    name.append(document.createTextNode('Spectators'), el('b', '', String(s.spectators.length)));
    h.append(name);
    box.append(h);
    for (const p of s.spectators.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const row = el('div', 'player spectator');
      row.append(el('span', 'who', p.name));
      box.append(row);
    }
  }
  box.scrollTop = scroll;
}

// ================================================================== guide

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

let channels = [];
let tab = null;         // the group whose servers the guide lists (null: the main list)
let listUpdated = null; // when the hub last asked the lobby, in this page's clock (0: never, null: unknown)
let listError = '';

// fresh: the Refresh button (the hub asks the lobby again instead of using its last answer)
async function refresh(fresh = false) {
  // the green strip runs while the hub requests the servers, like Request Servers
  const meter = $('meter');
  meter.classList.remove('loading', 'done');
  void meter.offsetWidth;
  meter.classList.add('loading');
  meterText('Requesting servers...');
  try {
    const res = await fetch(httpBase() + '/api/watch' + (fresh ? '?fresh' : ''), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    channels = data.servers || [];
    listUpdated = data.updated == null ? null : data.updated && Date.now() - Math.max(0, data.now - data.updated);
    listError = '';
  } catch (e) {
    listError = 'The server list is unavailable right now (' + e.message + ').';
  }
  meter.classList.remove('loading');
  meter.classList.toggle('done', !listError);
  renderGuide();
  showAge();
  return channels;
}

function meterText(text, error = false) {
  const t = $('meter').querySelector('.meter-text');
  t.textContent = text;
  t.classList.toggle('error', error);
}

// how old the list is
function showAge() {
  if ($('meter').classList.contains('loading')) return;
  if (listError) { meterText(listError, true); return; }
  if (listUpdated === null) { meterText(''); return; }
  if (!listUpdated) { meterText('Lobby not reached yet'); return; }
  const sec = Math.round((Date.now() - listUpdated) / 1000);
  meterText(sec < 5 ? 'Updated just now' : sec < 120 ? `Updated ${sec} s ago` : `Updated ${Math.round(sec / 60)} min ago`);
}
setInterval(() => { if (!watching) showAge(); }, 1000);

// ---------- tabs: servers with a group (the hub's config) are listed under its own tab

const slug = (group) => group.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function showTabAddress() {
  history.replaceState(null, '', './' + (debug ? '?debug' : '') + (tab ? '#' + slug(tab) : ''));
}

function setTab(group) {
  tab = group;
  showTabAddress();
  renderGuide();
}

function renderTabs() {
  const groups = [...new Set(channels.map(c => c.group).filter(Boolean))];
  if (tab && !groups.includes(tab)) tab = null;
  const logo = document.querySelector('.tabs .logo');
  logo.classList.toggle('active', !tab);
  for (const t of document.querySelectorAll('.tabs .group')) t.remove();
  let after = logo;
  for (const g of groups) {
    const a = el('a', 'tab group' + (g === tab ? ' active' : ''), g);
    a.href = '#' + slug(g);
    a.addEventListener('click', (e) => { e.preventDefault(); setTab(g); });
    after.after(a);
    after = a;
  }
}
document.querySelector('.tabs .logo').addEventListener('click', (e) => { e.preventDefault(); setTab(null); });

function renderGuide() {
  renderTabs();
  const ol = $('channels');
  ol.textContent = '';
  const list = channels.filter(c => (c.group || null) === tab);
  let players = 0;
  for (const c of list) {
    players += c.players || 0;
    const li = el('li');
    const b = el('button', 'channel' + ((c.players || 0) ? '' : ' quiet'));
    b.type = 'button';

    // the name with its tags; on a phone the map and mode go under it
    const main = el('span', 'ch-main');
    const title = el('span', 'ch-title');
    title.append(flag(c.country) || el('i', 'cflag none'), el('span', 'ch-label', c.name));
    if (c.state === 'live') title.append(el('span', 'chip on-air', c.viewers ? `On air · ${c.viewers}` : 'On air'));
    else if (c.state === 'waiting') title.append(el('span', 'chip off-air', 'Off air'));
    if (c.locked) title.append(el('span', 'chip', 'Password'));
    if (c.bots) {
      const humans = Math.max(0, (c.players || 0) - c.bots);
      title.append(el('span', 'chip bots', humans ? `${c.bots} bots` : 'Bots only'));
    }
    main.append(title);
    if (c.map) main.append(el('span', 'ch-sub', [c.map, c.mode].filter(Boolean).join(' · ')));
    if (c.title && c.title !== c.name) title.title = c.title;
    b.append(main);

    b.append(el('span', 'ch-map', c.map || ''));
    const mode = el('span', 'ch-mode', c.mode || '');
    if (c.mode) mode.title = MODES[c.mode] || c.mode;
    b.append(mode);

    const pl = el('span', 'ch-players num');
    if (c.players != null) {
      pl.append(el('b', '', c.maxPlayers ? `${c.players}/${c.maxPlayers}` : String(c.players)));
      if (c.maxPlayers) {
        const fill = el('span', 'fill');
        const i = el('i');
        i.style.width = `${Math.min(100, (100 * c.players) / c.maxPlayers)}%`;
        fill.append(i);
        pl.append(fill);
      }
    } else {
      pl.append(el('b', 'unknown', '—'));
    }
    b.append(pl);
    b.addEventListener('click', () => tuneIn(c));
    li.append(b);
    appendNames(li, c);
    ol.append(li);
  }
  $('list-empty').hidden = list.length > 0;
  $('list-empty').textContent = 'No servers are set up yet.';
  const summary = $('summary');
  summary.textContent = '';
  if (list.length) {
    summary.append('Servers: ', el('b', '', String(list.length)), ' - Players: ', el('b', '', String(players)));
  }
}

// ---------- the password of a server that asks for one (until the hub is in)

let asking = null;  // the server the dialog asks for

function askPassword(ch, error = '') {
  asking = ch;
  $('pw-name').textContent = ch.name;
  $('pw-error').textContent = error;
  $('pw-error').hidden = !error;
  $('pw-input').value = '';
  $('pw').returnValue = '';
  if (!$('pw').open) $('pw').showModal();
  $('pw-input').focus();
}

$('pw-cancel').addEventListener('click', () => $('pw').close());
$('pw').addEventListener('close', () => {
  const ch = asking, pw = $('pw-input').value;
  asking = null;
  $('pw-input').value = '';
  if ($('pw').returnValue !== 'ok' || !ch || !pw) {
    if (!watching) showTabAddress();
    return;
  }
  passwords.set(ch.id, pw);
  savePasswords();
  tuneIn(ch);
});

// the arrow after the player count opens the names of who plays under the row; open rows
// stay open when the list refreshes
const openRows = new Set();
function appendNames(li, c) {
  const names = c.names || [];
  if (!names.length) { li.append(el('span', 'peek-none')); return; }
  const open = openRows.has(c.id);
  const t = el('button', 'peek icon-btn');
  t.type = 'button';
  t.setAttribute('aria-expanded', String(open));
  t.setAttribute('aria-label', `Players on ${c.name}`);
  t.title = open ? 'Hide the players' : 'Show the players';
  t.innerHTML = '<svg><use href="#i-next"/></svg>';
  t.addEventListener('click', () => {
    if (openRows.has(c.id)) openRows.delete(c.id);
    else openRows.add(c.id);
    renderGuide();
  });
  li.append(t);
  if (!open) return;
  // the hub's own list has teams: keep each team together, in the order of the game
  const list = names.map((p, i) => [p, i]).sort((a, b) => (a[0].team || 9) - (b[0].team || 9) || a[1] - b[1]);
  const ul = el('ul', 'names');
  for (const [p] of list) {
    const n = el('li', '', p.name);
    if (p.team >= 1 && p.team <= 4) n.style.color = TEAM_TEXT[p.team];
    ul.append(n);
  }
  li.append(ul);
}

$('refresh').addEventListener('click', () => refresh(true));

// ================================================================== boot

// The guide shows at once and the game loads behind it (search engines see the guide, not
// a loading screen). A channel picked before the game is ready waits on the loading screen.
async function startGame() {
  const text = $('loading-text');
  const bar = $('loading-bar');
  if (!('WebAssembly' in window) || !document.createElement('canvas').getContext('webgl2')) {
    throw new Error('This browser cannot show the matches (it needs WebAssembly and WebGL 2).');
  }
  await game.load({
    base: '',
    wasm: 'soldat-spectate.wasm',
    onStatus: (s) => {
      const m = s.match(/(\d+) \/ (\d+) MB/);
      text.textContent = m ? `Tuning in... ${m[1]} of ${m[2]} MB` : 'Tuning in...';
      if (m) bar.style.width = `${Math.min(100, (100 * m[1]) / m[2])}%`;
    },
  });
  bar.style.width = '100%';
  await new Promise(r => setTimeout(r, 30));
  await game.instantiate();
  game.startGame();
  ready = true;
}

let ready = false, tuning = false;
const started = startGame();
started.catch((e) => console.error(e));

async function tuneIn(ch) {
  if (tuning) return;
  if (ch.locked && !passwords.has(ch.id)) {
    $('loading').hidden = true;
    askPassword(ch);
    return;
  }
  if (!ready) {
    tuning = true;
    $('loading').hidden = false;
    try {
      await started;
    } catch (e) {
      setStatus('Could not start: ' + (e && e.message ? e.message : e), true);
      return;
    } finally {
      tuning = false;
      $('loading').hidden = true;
    }
  }
  watch(ch);
}

async function boot() {
  const direct = directId;
  if (direct) { $('guide').hidden = true; $('loading').hidden = false; }
  document.documentElement.classList.remove('direct');
  // a link with the server's password (/<id>?password=...): kept, but not shown
  if (direct && params.get('password')) {
    passwords.set(direct, params.get('password'));
    savePasswords();
    params.delete('password');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }
  const hash = location.hash.slice(1);
  await refresh();
  setInterval(() => { if (!watching && !document.hidden) refresh(); }, 15000);
  const ch = direct && channels.find(c => c.id === direct);
  tab = ch ? ch.group || null : channels.map(c => c.group).find(g => g && slug(g) === hash) || null;
  renderGuide();
  $('guide').hidden = false;
  if (ch) await tuneIn(ch);
  else $('loading').hidden = true;
}

boot();

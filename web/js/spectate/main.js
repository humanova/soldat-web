// Soldat TV: the channel guide and the spectator client (soldat-spectate.wasm), fed by the
// spectator hub (relay/spectator.mjs). The game ignores its own keys and mouse in this
// build; this page drives the camera through the soldat_spectator_* exports.
import { SoldatRuntime } from '../runtime.js';
import { flag } from '../flags.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const debug = params.has('debug');

const MIN_ZOOM = -0.9, MAX_ZOOM = 1.6;  // Spectator.pas: view scale exp(z)
const TEAMS = { 1: 'Alpha', 2: 'Bravo', 3: 'Charlie', 4: 'Delta' };
const TEAM_GAMES = new Set([2, 3, 5, 6]);  // team match, CTF, infiltration, hold the flag
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
    return { type: 'watch', server: watching && watching.id };
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
  onNetError(message) {
    setStatus(message, true);
    if (watching) game.leave();
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
  setStatus('');
  $('ch-name').textContent = ch.name;
  $('ch-delay').hidden = true;
  $('scorebug').hidden = true;
  $('card').hidden = true;
  $('banners').textContent = '';
  scoreKey = cardKey = '';
  chatLines.length = 0;
  $('chat-lines').textContent = '';
  toggleChat(!!prefs.chat);
  director = 0;
  zoom = 0;
  match = null;
  setMode('auto', true);
  notice('Tuning in...');
  $('guide').hidden = true;
  $('watch').hidden = false;
  history.replaceState(null, '', '?watch=' + encodeURIComponent(ch.id) + (debug ? '&debug' : ''));
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
  history.replaceState(null, '', location.pathname + (debug ? '?debug' : ''));
  document.title = 'Soldat TV';
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

// the part of the canvas the picture covers (object-fit: contain)
function picture() {
  const r = canvas.getBoundingClientRect();
  const ar = canvas.width / canvas.height || 16 / 9;
  let w = r.width, h = r.height;
  if (w / h > ar) w = h * ar; else h = w / ar;
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
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await $('watch').requestFullscreen({ navigationUI: 'hide' });
    // phones: keep the landscape picture (works only in full screen, not everywhere)
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch (_) {}
}
if (!document.fullscreenEnabled) $('fullscreen').hidden = true;

window.addEventListener('keydown', (e) => {
  if (!watching || e.ctrlKey || e.metaKey || e.altKey) return;
  const keys = {
    ArrowLeft: () => cycle(-1), ArrowRight: () => cycle(1),
    KeyA: () => setMode('auto'), KeyP: () => setMode('player'), KeyF: () => setMode('free'),
    KeyO: () => setMode('overview'), KeyM: () => setMode('overview'),
    Equal: () => setZoom(zoom - 0.25), NumpadAdd: () => setZoom(zoom - 0.25),
    Minus: () => setZoom(zoom + 0.25), NumpadSubtract: () => setZoom(zoom + 0.25),
    Digit0: () => setZoom(0), Tab: () => toggleRoster(), KeyC: () => toggleChat(),
    Escape: () => closeRoster(),
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
        flag: +f[7], health: +f[8], color: '#' + f[9], weapon: f[10], name: f.slice(11).join('\t') });
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

// ---------- flag news

function flagEvent(e) {
  const inf = match && match.style === 5;
  const thing = inf ? 'the objective' : `the ${FLAG_NAMES[e.flag] || ''} flag`;
  const li = el('li', 'banner ' + e.kind);
  const who = el('b', '', e.name);
  who.style.color = teamColor({ team: e.team }, true);
  let color = FLAG_COLORS[e.flag];
  if (e.kind === 'score') {
    color = teamColor({ team: e.flag });
    li.append(el('span', 'big', `${TEAMS[e.flag] || ''} scores`), who);
  } else {
    li.append(flagIcon(e.kind === 'score' ? 0 : e.flag), who,
      ` ${{ take: inf ? 'captured' : 'took', drop: 'dropped', return: 'returned' }[e.kind] || e.kind} ${thing}`);
    if (!e.name) who.remove();
  }
  li.style.setProperty('--c', color);
  const list = $('banners');
  list.prepend(li);
  while (list.children.length > 3) list.lastElementChild.remove();
  setTimeout(() => { li.classList.add('gone'); setTimeout(() => li.remove(), 400); }, e.kind === 'score' ? 6000 : 4500);
}

// ---------- chat (off unless the viewer opens it)

const chatLines = [];
function addChat(c) {
  chatLines.push(c);
  if (chatLines.length > 150) chatLines.shift();
  if ($('chat').hidden) { $('chat-btn').querySelector('.unread').hidden = false; return; }
  appendChat(c);
}
function appendChat(c) {
  const ol = $('chat-lines');
  const li = el('li', 'line' + (c.kind === 3 ? ' server' : ''));
  if (c.kind === 1 || c.kind === 2) li.append(el('span', 'tag', c.kind === 1 ? 'Team' : 'Radio'));
  const who = el('b', '', c.kind === 3 ? 'Server' : c.name);
  if (c.kind !== 3) who.style.color = c.team === 5 ? 'var(--muted)' : teamColor({ team: c.team }, true);
  li.append(who, ' ', c.text);
  ol.append(li);
  while (ol.children.length > 150) ol.firstElementChild.remove();
  $('chat').classList.add('has-lines');
  const box = $('chat');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 60) box.scrollTop = box.scrollHeight;
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
    $('chat').scrollTop = $('chat').scrollHeight;
  }
}

// ---------- the followed player

function renderTarget(s) {
  const p = s.players.find(q => q.slot === s.follow);
  const t = $('target');
  t.querySelector('span').textContent = p ? p.name : mode === 'overview' ? 'Whole map' : 'Free camera';
  t.querySelector('.swatch').style.background = p ? teamColor(p) : 'transparent';
  t.querySelector('.hp i').style.width = p ? `${p.dead ? 0 : p.health}%` : '0';
  t.title = p ? `${p.name} · ${p.weapon} · ${p.health}%` : '';
}

let cardKey = '';
function renderCard(s) {
  const p = s.players.find(q => q.slot === s.follow);
  const card = $('card');
  if (!p || mode === 'overview') { card.hidden = true; cardKey = ''; return; }
  const key = JSON.stringify(p);
  if (key === cardKey && !card.hidden) return;
  cardKey = key;
  card.textContent = '';
  card.style.setProperty('--c', teamColor(p));
  const top = el('div', 'c-top');
  if (p.flag) top.append(flagIcon(p.flag));
  top.append(el('b', 'c-name', p.name));
  const hp = el('div', 'c-hp' + (p.health <= 30 ? ' low' : ''));
  const fill = el('i');
  fill.style.width = `${p.dead ? 0 : p.health}%`;
  hp.append(fill);
  const meta = el('div', 'c-meta');
  meta.append(el('span', 'c-weapon', p.dead ? 'Dead' : p.weapon),
    el('span', 'c-kd', `${p.kills} / ${p.deaths}`));
  card.append(top, hp, meta);
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


function renderRoster(s) {
  const box = $('roster');
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
      name.append(sw, document.createTextNode(TEAMS[team] || 'Players'), el('b', '', String(s.scores[team] ?? '')));
    } else {
      name.append(document.createTextNode('Players'));
    }
    h.append(name, el('span', 'num', 'K'), el('span', 'num', 'D'));
    box.append(h);
    for (const p of list) {
      const row = el('button', 'player' + (p.dead ? ' dead' : '') + (p.slot === s.follow ? ' followed' : ''));
      row.type = 'button';
      const who = el('span', 'who');
      const sw = el('i', 'swatch');
      sw.style.background = teamColor(p);
      who.append(sw, el('span', '', p.name));
      if (p.flag) who.append(flagIcon(p.flag));
      row.append(who, el('span', 'n', String(p.kills)), el('span', 'n', String(p.deaths)));
      row.title = `${p.weapon} · ${p.health}%`;
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

function renderGuide() {
  const ol = $('channels');
  ol.textContent = '';
  let players = 0;
  for (const c of channels) {
    players += c.players || 0;
    const li = el('li');
    const b = el('button', 'channel' + ((c.players || 0) ? '' : ' quiet'));
    b.type = 'button';

    const main = el('span', 'ch-main');
    const title = el('span', 'ch-title');
    title.append(flag(c.country) || el('i', 'cflag none'), el('span', '', c.name));
    main.append(title);
    const sub = el('span', 'ch-sub');
    if (c.state === 'live') sub.append(el('span', 'on-air', c.viewers ? `On air · ${c.viewers} watching` : 'On air'));
    else if (c.state === 'waiting') sub.append(el('span', 'unavailable', 'Off air'));
    if (c.map) sub.append(el('span', 'sub-map', [c.map, c.mode].filter(Boolean).join(' · ')));
    main.append(sub);
    if (c.title && c.title !== c.name) main.title = c.title;
    b.append(main);

    b.append(el('span', 'ch-map', c.map || ''));
    const mode = el('span', 'ch-mode', c.mode || '');
    if (c.mode) mode.title = MODES[c.mode] || c.mode;
    b.append(mode);

    const pl = el('span', 'ch-players num');
    if (c.players != null) {
      const humans = Math.max(0, c.players - (c.bots || 0));
      pl.append(el('b', '', c.maxPlayers ? `${c.players}/${c.maxPlayers}` : String(c.players)));
      if (c.maxPlayers) {
        const fill = el('span', 'fill');
        const i = el('i');
        i.style.width = `${Math.min(100, (100 * c.players) / c.maxPlayers)}%`;
        fill.append(i);
        pl.append(fill);
      }
      if (c.bots) pl.append(el('small', '', humans ? `${c.bots} bots` : 'bots only'));
    } else {
      pl.append(el('small', '', '—'));
    }
    b.append(pl);
    b.addEventListener('click', () => watch(c));
    li.append(b);
    ol.append(li);
  }
  $('list-empty').hidden = channels.length > 0;
  $('list-empty').textContent = 'No servers are set up yet.';
  const summary = $('summary');
  summary.textContent = '';
  if (channels.length) {
    summary.append('Servers: ', el('b', '', String(channels.length)), ' - Players: ', el('b', '', String(players)));
  }
}

$('refresh').addEventListener('click', () => refresh(true));

// ================================================================== boot

async function boot() {
  const text = $('loading-text');
  const bar = $('loading-bar');
  try {
    if (!('WebAssembly' in window) || !document.createElement('canvas').getContext('webgl2')) {
      throw new Error('This browser cannot show the matches (it needs WebAssembly and WebGL 2).');
    }
    const list = refresh();
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
    $('loading').hidden = true;
    $('guide').hidden = false;
    await list;
    setInterval(() => { if (!watching && !document.hidden) refresh(); }, 15000);
    const direct = params.get('watch');
    const ch = direct && channels.find(c => c.id === direct);
    if (ch) watch(ch);
  } catch (e) {
    console.error(e);
    $('loading').classList.add('error');
    text.textContent = 'Could not start: ' + (e && e.message ? e.message : e);
  }
}

boot();

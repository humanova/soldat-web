// Soldat TV: the channel guide and the spectator client (soldat-spectate.wasm), fed by the
// spectator hub (relay/spectator.mjs) or a recorded match (js/spectate/replay.js). The game
// ignores its own keys and mouse in this build; this page drives the camera through the
// soldat_spectator_* exports.
import { SoldatRuntime } from '../runtime.js';
import { flag } from '../flags.js';
import { TvChat, MAX_TEXT, MAX_NAME } from './chat.js';
import { Replay, parseDemo, TICKS } from './replay.js';
import { migrateDemo } from './legacy.js';
import { countHighlights, rateMatch, ratingText, weaponName, HIGHLIGHT_TYPES } from './highlights.js';
import { directDemo, DIRECTOR_VERSION } from './director.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const debug = params.has('debug');
const TITLE = document.title;
// a recorded match's address, /replay?id=<demo>[&clip=<n>] (its highlights from the nth clip on)
const replayId = location.pathname.endsWith('/replay') ? params.get('id') : null;
const replayClip = replayId ? Math.max(0, parseInt(params.get('clip'), 10) || 0) : 0;
// a reel of several recorded matches' highlights, /replay?reel=<id>,<id>...[&only=<types>][&player=<name>];
// <id>:<n> is that match's nth clip alone
const reelIds = location.pathname.endsWith('/replay') && !replayId && params.get('reel')
  ? params.get('reel').split(',').filter(Boolean).slice(0, 100).map((e) => {
    const [id, n] = e.split(':');
    return { id, clip: Math.max(0, parseInt(n, 10) || 0) };
  }) : null;
// a server's own address, /<id> (older links: ?watch=<id>)
const directId = replayId || reelIds ? null : params.get('watch') || decodeURIComponent(location.pathname.split('/').pop()) || null;

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
  try { return { muted: false, volume: 60, ...JSON.parse(localStorage.getItem('soldattv') || '{}') }; } catch (_) { return { muted: false, volume: 60 }; }
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
let watching = null;  // the channel being watched (replay: true for a recorded match)
let replay = null;    // the recorded match being played (js/spectate/replay.js)

const game = new SoldatRuntime(canvas, {
  input: false,
  stencil: true,  // players behind scenery are drawn as silhouettes (spec_silhouettes)
  relayUrl: () => hubBase() + '/watch',
  relayRequest(kind, d) {
    if (kind === 'files') return { type: 'files', server: watching && watching.id, files: d.files };
    return { type: 'watch', server: watching && watching.id, password: watching ? passwords.get(watching.id) : undefined };
  },
  onRelayMessage: onHubMessage,
  // a replay stands in for the hub
  openSocket: () => (replay && watching && watching.replay ? replay.socket() : null),
  beforeFrame(now) {
    if (!replay) return;
    replay.pump(now);
    renderBar();
  },
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
Object.defineProperty(window, 'soldatReplay', { get: () => replay });

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
let wanted = 0;         // the player last picked to follow
let lostAt = 0;         // when the picked player could no longer be followed
let zoom = 0;
let zoomBeforeMap = 0;
let joinedAt = 0;
let match = null;       // the last state snapshot
let pollTimer = 0;

function watch(ch) {
  watching = ch;
  if (!ch.local) { tab = ch.group || null; viewer = false; }
  setStatus('');
  $('ch-name').textContent = ch.name;
  $('ch-delay').hidden = true;
  $('scorebug').hidden = true;
  $('card').hidden = true;
  clearNews();
  scoreKey = cardKey = rosterKey = '';
  toggleChat(!!prefs.chat);
  listen();
  $('tvchat-btn').querySelector('.unread').hidden = true;
  toggleTvChat(!!prefs.tvchat);
  director = 0;
  wanted = 0;
  lostAt = 0;
  zoom = 0;
  match = null;
  setMode('auto', true);
  call('soldat_spectator_follow', -1);  // the last match's player is no one here
  notice('Tuning in...');
  $('guide').hidden = true;
  $('loading').hidden = true;  // a link to the match opened on it (boot)
  $('watch').hidden = false;
  fitPicture();
  // phones watch on the whole screen, held sideways (not on an iPhone: no full screen for pages)
  if (phone && document.fullscreenEnabled && !document.fullscreenElement) enterFullscreen();
  $('watch').classList.toggle('replaying', !!ch.replay);
  $('replaybar').hidden = !ch.replay;
  movables.forEach(place);
  document.querySelector('.tally').textContent = ch.replay ? 'REPLAY' : 'LIVE';
  document.querySelector('.tally').classList.toggle('replay', !!ch.replay);
  if (ch.replay) {
    if (ch.local) history.replaceState(null, '', './' + (debug ? '?debug' : '') + '#demo');
    else history.replaceState(null, '', './replay?id=' + encodeURIComponent(replay.meta.id) + (debug ? '&debug' : ''));
    showReplayTitle(ch);
    showBar();
  } else {
    history.replaceState(null, '', './' + encodeURIComponent(ch.id) + (debug ? '?debug' : ''));
    document.title = `${ch.name} · Soldat TV`;
  }
  setCvar('cl_player_team', '5');  // join as a spectator, no team menu
  // a replay may have held the game's clock
  try { game.call('soldat_spectator_speed', 1); } catch (_) {}
  game.al.hold(false);
  applyVolume();
  applyVisuals();
  if (!game.join('tv', 1, '')) {
    showGuide();
    setStatus('Could not start watching.', true);
    return;
  }
  syncAuto(true);
  showSound();  // opened from a link: no sound until a click
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 250);
  wake();
  canvas.focus();
}

function showReplayTitle(ch) {
  const name = replay.meta.serverName || ch.name;
  $('ch-name').textContent = `${name} · ${replay.meta.map} · ${when(replay.meta.start)}`;
  document.title = `Replay: ${replay.meta.map} on ${name} · Soldat TV`;
}

// what happened in the match until now: the flag news, the vote, the game's chat
function clearNews() {
  $('banners').textContent = '';
  $('bigmsg').hidden = true;
  vote = voteEnded = null;
  voteKey = '';
  clearTimeout(voteTimer);
  $('vote').hidden = true;
  chatLines.length = 0;
  $('chat-lines').textContent = '';
}

function showGuide() {
  watching = null;
  replay = null;
  reelSet = null;
  game.al.hold(false);
  $('watch').classList.remove('replaying');
  $('replaybar').hidden = true;
  $('clipcap').hidden = true;
  clearInterval(pollTimer);
  notice('');
  closeRoster();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('watch').hidden = true;
  $('guide').hidden = false;
  listen();
  renderGuideChat();
  showTabAddress();
  document.title = TITLE;
  refresh();
}

// ---------- camera modes

function setMode(m, quiet) {
  const was = mode;
  mode = m;
  syncAuto();
  $('auto').setAttribute('aria-pressed', String(m === 'auto'));
  $('map').setAttribute('aria-pressed', String(m === 'overview'));
  if (match) renderTarget(match);
  // the reel's own zoom is for its camera only
  if (replay && replay.reel && m !== 'overview' && (m === 'auto') !== (was === 'auto')) applyZoom();
  if (quiet) return;
  if (m === 'overview') {
    if (was !== 'overview') zoomBeforeMap = zoom;
    const z = call('soldat_spectator_overview');
    setZoom(z, 0.5, 0.5);
    return;
  }
  // Auto zooms by itself
  if (was === 'overview' && m !== 'free' && m !== 'auto') setZoom(zoomBeforeMap, 0.5, 0.5);
  if (m === 'auto') follow(director || firstPlayer());
  else if (m === 'player') follow((match && match.follow) || firstPlayer());
  else if (m === 'free') call('soldat_spectator_follow', 0);
}

// Auto's camera (Spectator.pas SpectatorAuto): it frames, zooms and cuts by itself, the
// viewer's zoom on top of its own. A reel of highlights has a camera of its own.
let autoCam = false;
function syncAuto(force) {
  const on = mode === 'auto' && !(replay && replay.reel);
  if (on === autoCam && !force) return;
  autoCam = on;
  if (on) {
    zoom = 0;
    call('soldat_spectator_auto', 1, viewZoom());
  } else {
    // another mode: the picture stays as the camera had it (a reel has a zoom of its own)
    const z = call('soldat_spectator_auto', 0, 0);
    if (!force && mode !== 'auto') zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  }
}

function follow(slot) {
  if (!slot) return;
  wanted = slot;
  call('soldat_spectator_follow', slot);
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

// the viewer's zoom; a replay's reel adds its own on top while it has the camera
function setZoom(z, fx = 0.5, fy = 0.5) {
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  // the viewer's own zoom ends a clip's shot camera
  if (replay) replay.dropShot();
  applyZoom(fx, fy);
}

function applyZoom(fx = 0.5, fy = 0.5) {
  call('soldat_spectator_zoom', viewZoom(), fx, fy);
}

const reelCam = { wide: 0, shot: 0, fit: null };  // zoom out for the clip, and for its shot (as far as it went)
const SHOT_MAX_ZOOM = Math.log(3), SHOT_MAX_ZOOM_PHONE = Math.log(2.2);  // farther apart: no shot camera

function viewZoom() {
  const extra = replay && replay.reel && mode === 'auto' ? reelCam.wide + reelCam.shot : 0;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + extra));
}

// the reel's clip (null: the reel stopped): its own zoom (the most its plays want), and no shot yet
function reelClip(h) {
  syncAuto();
  reelCam.wide = h && h.wide ? h.wide : 0;
  reelCam.shot = 0;
  reelCam.fit = null;
  call('soldat_spectator_frame', 0, 0, 0);
  applyZoom();
}

// a shot from afar (Replay.shotAt): the camera between the killer and the victim, zoomed out
// to show both. Whether they fit is decided as it starts; too far apart, the clip cuts to
// the victim instead. The view holds as far out as it went (the two may close in).
function reelShot(shot) {
  if (!shot || mode !== 'auto') {
    call('soldat_spectator_frame', 0, 0, 0);
    if (reelCam.shot) { reelCam.shot = 0; applyZoom(); }
    return;
  }
  const fit = call('soldat_spectator_frame', shot.a, shot.b, shot.mix);
  if (fit < MIN_ZOOM) return;  // one of them is not there (yet)
  const max = phone ? SHOT_MAX_ZOOM_PHONE : SHOT_MAX_ZOOM;
  if (reelCam.fit == null && fit > max + 0.1) { replay.dropShot(); return; }
  reelCam.fit = Math.max(reelCam.fit ?? fit, fit);
  const base = zoom + reelCam.wide;
  reelCam.shot = Math.max(0, Math.min(reelCam.fit, max) - base) * shot.out;
  applyZoom();
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
// a double tap resets the zoom; a mouse's clicks hold it for the free camera (below)
let pressedBy = '';
canvas.addEventListener('pointerdown', (e) => { pressedBy = e.pointerType; });
canvas.addEventListener('dblclick', () => { if (mode !== 'overview' && pressedBy !== 'mouse') setZoom(0); });
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

// ---------- the game's own free camera: a click on the picture holds the mouse (pointer lock)
// and the camera flows towards the cursor, faster the farther it is from the middle, as in
// the game. Esc, or any other camera, lets go.

let downAt = null;  // where a mouse press started (a drag is no click)
canvas.addEventListener('pointerdown', (e) => {
  downAt = e.pointerType === 'mouse' && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
});
canvas.addEventListener('click', (e) => {
  const at = downAt;
  downAt = null;
  if (!at || !watching || mouseHeld() || Math.hypot(e.clientX - at.x, e.clientY - at.y) > 5) return;
  if (mode !== 'free') setMode('free');
  // raw movement where the browser has it; a refusal (no gesture, a frame) is no error
  const lock = (opts) => { try { return Promise.resolve(canvas.requestPointerLock(opts)); } catch (e) { return Promise.reject(e); } };
  lock({ unadjustedMovement: true }).catch(() => lock()).catch(() => {});
});

const mouseHeld = () => document.pointerLockElement === canvas;
let mouseMove = [0, 0];
document.addEventListener('mousemove', (e) => {
  if (!mouseHeld()) return;
  mouseMove[0] += e.movementX;
  mouseMove[1] += e.movementY;
});
// once a frame: the movement since the last, and the cursor back after a zoom centered it
function steer() {
  if (!mouseHeld()) return;
  if (mode !== 'free' || !watching) { document.exitPointerLock(); return; }
  call('soldat_spectator_mouse', mouseMove[0], mouseMove[1], 1);
  mouseMove = [0, 0];
  requestAnimationFrame(steer);
}
document.addEventListener('pointerlockchange', () => {
  mouseMove = [0, 0];
  if (mouseHeld()) {
    requestAnimationFrame(steer);
    wake();
  } else {
    call('soldat_spectator_mouse', 0, 0, 0);
  }
});

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
$('fullscreen').addEventListener('click', toggleFullscreen);

// ---------- sound: the game's volume (snd_volume, 0-100); muting keeps the chosen volume

const volume = () => Math.min(100, Math.max(0, Math.round(+prefs.volume))) || 0;

function applyVolume() {
  setCvar('snd_volume', String(prefs.muted ? 0 : volume()));
}

function showSound() {
  // the browser holds the sound back until the page is clicked: shown as off, with a hint
  const blocked = !prefs.muted && volume() > 0 && !!game.al && game.al.blocked();
  const off = prefs.muted || !volume() || blocked;
  $('sound').querySelector('use').setAttribute('href', off ? '#i-mute' : '#i-sound');
  $('sound').setAttribute('aria-label', off ? 'Unmute' : 'Mute');
  $('unmute').hidden = !blocked;
  $('volume').value = String(prefs.muted ? 0 : volume());
  $('volume').title = `Volume ${prefs.muted ? 0 : volume()}%`;
}
showSound();

// any click or key lets the sound start (the canvas's own handlers may stop the event)
let soundFreed = 0;  // when a click let it start: that click is no mute (below)
for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click']) {
  window.addEventListener(type, () => {
    if (!game.al || !game.al.blocked()) return;
    soundFreed = performance.now();
    game.al.resume();
  }, { capture: true, passive: true });
}
$('unmute').addEventListener('click', () => game.al.resume());
if (matchMedia('(hover: none)').matches) $('unmute').querySelector('span').textContent = 'Tap for sound';

$('sound').addEventListener('click', () => {
  // the sound held back by the browser: the click lets it start (above), not a mute
  if (performance.now() - soundFreed < 1000) return;
  // touch screens: the first tap shows the volume, the next one mutes
  const box = $('sound').parentElement;
  if (matchMedia('(hover: none)').matches && !box.classList.contains('open')) {
    box.classList.add('open');
    wake();
    return;
  }
  // unmuting at volume 0 brings the sound back at the default
  if (prefs.muted || !volume()) { prefs.muted = false; if (!volume()) prefs.volume = 60; } else prefs.muted = true;
  savePrefs();
  showSound();
  applyVolume();
  game.al.resume();
});
$('volume').addEventListener('input', () => {
  prefs.volume = +$('volume').value;
  prefs.muted = prefs.volume === 0;
  savePrefs();
  showSound();
  applyVolume();
  game.al.resume();
  wake();
});

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
  // Enter and Space on a button press it
  if ((e.code === 'Enter' || e.code === 'Space') && e.target.closest && e.target.closest('button, a, label')) return;
  // a choice in the menu takes its own arrow keys
  if (e.target.matches && e.target.matches('select')) return;
  const keys = {
    ...(replay && replayKeys),
    ArrowLeft: () => cycle(-1), ArrowRight: () => cycle(1),
    KeyA: () => setMode('auto'), KeyP: () => setMode('player'), KeyF: () => setMode('free'),
    KeyO: () => setMode('overview'), KeyM: () => setMode('overview'),
    Equal: () => setZoom(zoom - 0.25), NumpadAdd: () => setZoom(zoom - 0.25),
    Minus: () => setZoom(zoom + 0.25), NumpadSubtract: () => setZoom(zoom + 0.25),
    Digit0: () => setZoom(0), Tab: () => toggleRoster(), KeyC: () => toggleChat(),
    KeyV: () => toggleVisuals(),
    Escape: () => { closeRoster(); toggleVisuals(false); }, Enter: () => sayKey(),
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

// ---------- what is shown over the match: the game's spec_* settings (a box starts as it is
// checked in the page, a choice at its selected option), switched in the menu under the eye
// and kept in prefs.visuals

const visuals = (prefs.visuals && typeof prefs.visuals === 'object') ? prefs.visuals : (prefs.visuals = {});
const visualControls = [...$('visuals').querySelectorAll('[data-cvar]')];

// the setting's value for the game ('0', '1', ... ; a choice kept as on/off before is 1 or 0)
function visualValue(el) {
  const v = visuals[el.dataset.cvar];
  if (el.type === 'checkbox') return (typeof v === 'boolean' ? v : el.defaultChecked) ? '1' : '0';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const values = [...el.options].map(o => o.value);
  return values.includes(v) ? v : el.querySelector('option[selected]').value;
}
function applyVisuals() {
  for (const el of visualControls) setCvar(el.dataset.cvar, visualValue(el));
}
for (const el of visualControls) {
  if (el.type === 'checkbox') el.checked = visualValue(el) === '1';
  else el.value = visualValue(el);
  el.addEventListener('change', () => {
    visuals[el.dataset.cvar] = el.type === 'checkbox' ? el.checked : el.value;
    savePrefs();
    if (game.running) setCvar(el.dataset.cvar, visualValue(el));
  });
}
function toggleVisuals(open = $('visuals').hidden) {
  $('visuals').hidden = !open;
  $('visuals-btn').setAttribute('aria-expanded', String(open));
  if (open) wake();
}
$('visuals-btn').addEventListener('click', () => toggleVisuals());
// a click anywhere else closes it
document.addEventListener('pointerdown', (e) => {
  if (!$('visuals').hidden && !e.target.closest('.visuals')) toggleVisuals(false);
});

// ---------- controls fade out while nothing happens

let idleTimer = 0;
function wake() {
  $('watch').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!$('dock').matches(':hover') && !$('replaybar').matches(':hover') && !scrub &&
      !$('volume').parentElement.matches(':hover') && $('roster').hidden && $('visuals').hidden) idle();
  }, 3200);
}
function idle() {
  $('watch').classList.add('idle');
  $('volume').parentElement.classList.remove('open');
}
function toggleUi() {
  if ($('watch').classList.contains('idle')) wake();
  else { clearTimeout(idleTimer); idle(); }
}
for (const id of ['dock', 'roster', 'replaybar']) $(id).addEventListener('pointerdown', wake);

// ---------- movable panels: dragged by their bar (the score and the flag news anywhere), a
// double-click on it puts the panel back. Kept as fractions of the free room across and down,
// so a panel at an edge stays there on any screen.

const layout = (prefs.layout && typeof prefs.layout === 'object') ? prefs.layout : (prefs.layout = {});
const movables = [...document.querySelectorAll('#watch .move')];

// the room the panels have: in a replay the bar along the bottom keeps its strip (a panel
// put at the bottom of a live match sits above the bar)
function panelRoom() {
  const area = $('watch'), bar = $('replaybar');
  const h = area.classList.contains('replaying') && !bar.hidden ? Math.min(area.clientHeight, bar.offsetTop - 6) : area.clientHeight;
  return { w: area.clientWidth, h };
}

function place(box) {
  const pos = layout[box.dataset.move];
  if (!Array.isArray(pos)) {
    box.classList.remove('placed');
    box.style.left = box.style.top = '';
    delete box.dataset.align;
    return;
  }
  const room = panelRoom();
  box.classList.add('placed');
  box.style.left = `${Math.round(Math.max(0, room.w - box.offsetWidth) * pos[0])}px`;
  box.style.top = `${Math.round(Math.max(0, room.h - box.offsetHeight) * pos[1])}px`;
  box.dataset.align = pos[0] < 0.34 ? 'start' : pos[0] > 0.66 ? 'end' : 'center';
}

function startMove(e, box) {
  if (e.button !== 0 || (e.target.closest('button') && !e.target.closest('.handle'))) return;
  e.preventDefault();
  wake();
  const area = $('watch').getBoundingClientRect();
  const room = panelRoom();
  const r = box.getBoundingClientRect();
  const dx = e.clientX - r.left, dy = e.clientY - r.top;
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
    moved = true;
    box.classList.add('moving');
    const freeX = room.w - box.offsetWidth, freeY = room.h - box.offsetHeight;
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
    } else if (f[0] === 'V') {
      // type: 0 map, 1 kick; slot and team: the kick's target
      s.vote = { type: +f[1], left: +f[2], slot: +f[3], team: +f[4], target: f[5], starter: f[6], reason: f.slice(7).join('\t') };
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
    } else if (f[0] === 'K') {
      votedOff.set(+f[1], performance.now());
    } else if (f[0] === 'N') {
      nextMap = { name: f.slice(1).join('\t'), at: performance.now() };
    }
  }
}

function poll() {
  if (!game.running) return;
  readEvents();
  const s = readState();
  if (!s) return;
  match = s;
  // the followed player left: the game shows the free camera. A picked player who is still
  // on the server is followed again as soon as they can be (Spectator.pas); one who is gone
  // for a few seconds gives way to someone else.
  if (!s.follow && (mode === 'auto' || mode === 'player') && s.players.length) {
    const now = performance.now();
    if (mode === 'auto') follow(director && s.players.some(p => p.slot === director) ? director : firstPlayer());
    else if (!s.players.some(p => p.slot === wanted) && now - (lostAt ||= now) > 3000) follow(firstPlayer());
  } else {
    lostAt = 0;
  }
  // joining resets the zoom
  if (!autoCam && Math.abs(s.zoom - viewZoom()) > 0.01 && performance.now() - joinedAt < 5000) applyZoom();
  renderScorebug(s);
  renderVote(s);
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

// ---------- votes: one line under the score while a kick or map vote runs (the game's own
// box is not drawn in this build), then its result for a moment. The server sends no tally.

const VOTE_SECONDS = 20;  // Constants.pas: DEFAULT_VOTING_TIME
let vote = null;          // the running vote
let voteEnded = null;     // a vote that just ended, waiting for its result: { vote, at }
let voteKey = '';
let voteTimer = 0;
const votedOff = new Map();  // slot -> when the server voted the player off
let nextMap = null;          // the map the server announced: { name, at }

function renderVote(s) {
  if (s.vote) {
    vote = s.vote;
    voteEnded = null;
    showVote(s.vote);
  } else if (vote) {
    voteEnded = { vote, at: performance.now() };
    vote = null;
  }
  if (voteEnded) resolveVote();
}

// a kick passed: the target left as voted off; a map vote passed: that map comes next
function resolveVote() {
  const { vote: v, at } = voteEnded;
  const near = (t) => t !== undefined && Math.abs(t - at) < 3000;
  let result = '';
  if (v.type === 1 && near(votedOff.get(v.slot))) result = 'was kicked';
  else if (v.type === 0 && nextMap && near(nextMap.at) && nextMap.name.toLowerCase() === v.target.toLowerCase()) result = 'is next';
  else if (performance.now() - at < 1500) return;  // the result may follow in a moment
  voteEnded = null;
  voteKey = '';
  const box = $('vote');
  box.textContent = '';
  box.classList.add('done');
  box.append(voteKind(v), voteTarget(v));
  box.append(el('span', 'v-by', result || 'vote failed'));
  clearTimeout(voteTimer);
  voteTimer = setTimeout(() => {
    box.classList.add('gone');
    voteTimer = setTimeout(() => { box.hidden = true; }, 400);
  }, 4000);
}

const voteKind = (v) => el('span', 'v-kind', v.type === 1 ? 'KICK' : 'MAP');
function voteTarget(v) {
  const b = el('b', '', v.target);
  if (v.type === 1) b.style.color = teamColor({ team: v.team }, true);
  return b;
}

function showVote(v) {
  const box = $('vote');
  const key = JSON.stringify([v.type, v.slot, v.target, v.starter, v.reason]);
  if (key !== voteKey) {
    voteKey = key;
    clearTimeout(voteTimer);
    box.textContent = '';
    box.className = 'vote move' + (v.type === 1 ? ' kick' : '') + (box.classList.contains('placed') ? ' placed' : '');
    const by = [v.starter && `by ${v.starter}`, v.reason.trim()].filter(Boolean).join(' · ');
    box.append(voteKind(v), voteTarget(v), el('span', 'v-by', by), el('span', 'v-left', ''));
    box.title = `${v.type === 1 ? 'Vote to kick' : 'Vote for the map'} ${v.target}` +
      (v.starter ? `, started by ${v.starter}` : '') + (v.reason.trim() ? `: ${v.reason.trim()}` : '');
    box.hidden = false;
  }
  box.querySelector('.v-left').textContent = `${v.left}s`;
  box.style.setProperty('--p', `${Math.min(100, (100 * v.left) / VOTE_SECONDS)}%`);
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

// ---------- Soldat TV's chat (js/spectate/chat.js), on one connection: everyone on the site
// (the guide's box, the Global channel) and who watches the same server (This server). The
// match's window shows the channels whose boxes are ticked, each line with its channel.

const guideChat = document.querySelector('.tv-chat');
const tvChannels = { global: prefs.tvGlobal !== false, server: prefs.tvServer !== false };
let sayTo = prefs.sayTo === 'server' ? 'server' : 'global';
const roomOf = (channel) => channel === 'global' ? null : watching && !watching.replay ? watching.id : undefined;
// a ticked channel there is (a replay has no server channel: its match is over)
const channelOn = (c) => tvChannels[c] && roomOf(c) !== undefined;

// the rooms the match's window shows (the guide: the global one)
function tvRooms() {
  if (!watching) return [null];
  return ['global', 'server'].filter(channelOn).map(roomOf);
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

function fillTv(box, rooms) {
  box.querySelector('.chat-lines').textContent = '';
  box.querySelector('.chat-empty').textContent = !tv.online ? 'Connecting to the chat...'
    : rooms.length ? 'Nobody said anything in the last 10 minutes.' : 'Tick a channel to see its chat.';
  box.classList.remove('has-lines');
  for (const l of tv.merged(rooms)) pushLine(box, tvLine(l));
  const scroll = box.querySelector('.chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;
}
const renderTv = () => { if (watching && !$('tvchat').hidden) fillTv($('tvchat'), tvRooms()); };
const renderGuideChat = () => fillTv(guideChat, [null]);

// the channels the viewer listens to: the ticked ones while watching, the global one on the guide
function listen() {
  tv.listen(tvRooms());
  for (const box of $('tvchat').querySelectorAll('.chat-filters input')) {
    box.checked = tvChannels[box.dataset.channel];
    box.parentElement.hidden = roomOf(box.dataset.channel) === undefined;
  }
  if (!channelOn(sayTo) && channelOn(sayTo === 'global' ? 'server' : 'global')) sayTo = sayTo === 'global' ? 'server' : 'global';
  renderTv();
  showComposers();
}

for (const box of $('tvchat').querySelectorAll('.chat-filters input')) {
  box.addEventListener('change', () => {
    tvChannels[box.dataset.channel] = box.checked;
    prefs.tvGlobal = tvChannels.global;
    prefs.tvServer = tvChannels.server;
    savePrefs();
    listen();
  });
}

function toggleTvChat(open = $('tvchat').hidden) {
  $('tvchat').hidden = !open;
  $('tvchat-btn').setAttribute('aria-expanded', String(open));
  prefs.tvchat = open;
  savePrefs();
  if (open) {
    $('tvchat-btn').querySelector('.unread').hidden = true;
    renderTv();
  }
}

const tv = new TvChat(() => hubBase() + '/chat', (room, line) => {
  if (line && line.error) {
    pushLine(lastSaid && lastSaid.closest('#tvchat') ? $('tvchat') : guideChat, tvLine(line));
    return;
  }
  if (!line) {
    // a room's last 10 minutes, or the chat went off or on line
    if (watching) renderTv(); else renderGuideChat();
    showComposers();
    return;
  }
  if (!watching) { pushLine(guideChat, tvLine(line)); return; }
  if (!tvRooms().includes(room)) return;
  if ($('tvchat').hidden) $('tvchat-btn').querySelector('.unread').hidden = false;
  else pushLine($('tvchat'), tvLine(line));
});

// what to say, and once, the nickname (kept on this device; the nickname button changes it)
let naming = null;      // the chat box that asks for the nickname
let lastSaid = null;    // the form that said something last (where a "slow down" goes)
const composers = [guideChat, $('tvchat')];

function showComposers() {
  for (const box of composers) {
    const input = box.querySelector('.say-text'), nick = box.querySelector('.say-nick'), to = box.querySelector('.say-to');
    const asking = !prefs.nick || naming === box;
    const channel = box === guideChat ? 'global' : channelOn(sayTo) ? sayTo : null;
    nick.textContent = prefs.nick || '';
    nick.title = 'Change your nickname';
    nick.hidden = asking;
    if (to) {
      to.textContent = channel === 'server' && watching ? watching.name : 'Global';
      to.classList.toggle('server', channel === 'server');
      to.hidden = asking || !channel;
    }
    input.maxLength = asking ? MAX_NAME : MAX_TEXT;
    input.disabled = !tv.online || (!asking && !channel);
    input.placeholder = !tv.online ? 'Connecting...' : asking ? 'Choose a nickname to chat'
      : !channel ? 'Tick a channel to chat' : 'Say something';
  }
}

for (const box of composers) {
  const form = box.querySelector('form.say'), input = box.querySelector('.say-text');
  box.querySelector('.say-nick').addEventListener('click', () => {
    naming = box;
    showComposers();
    input.value = prefs.nick || '';
    input.focus();
    input.select();
  });
  // the channel to write to: the other ticked one
  box.querySelector('.say-to')?.addEventListener('click', () => {
    const other = sayTo === 'global' ? 'server' : 'global';
    if (channelOn(other)) { sayTo = prefs.sayTo = other; savePrefs(); }
    showComposers();
    input.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.replace(/\s+/g, ' ').trim();
    if (!prefs.nick || naming === box) {
      if (!text) return;
      prefs.nick = [...text].slice(0, MAX_NAME).join('');
      savePrefs();
      naming = null;
      input.value = '';
      showComposers();
      return;
    }
    const room = box === guideChat ? null : roomOf(sayTo);
    if (!text || room === undefined) return;
    lastSaid = form;
    tv.say(room, prefs.nick, text);
    input.value = '';
  });
  input.addEventListener('keydown', (e) => {
    // the match's keys stay out of the text
    e.stopPropagation();
    if (e.key !== 'Escape') return;
    if (naming === box) { naming = null; input.value = ''; showComposers(); }
    else input.blur();
  });
}
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
function gunPicture(num) {
  const file = num >= 1 && num <= 10 ? String(num % 10) : GUN_FILES[num];
  return file === undefined ? '' : interfacePicture(`guns/${file}`);
}

// the same by the weapon number of a kill (NetworkClientSprite.pas: the kill feed's), as the
// highlights have it
const KILL_FILES = { 0: 'guns/10', 10: 'guns/0', 205: 'guns/flamer', 206: 'guns/fist', 207: 'guns/bow', 208: 'guns/bow',
  210: 'cluster-nade', 211: 'guns/knife', 212: 'guns/chainsaw', 222: 'nade', 224: 'guns/law', 225: 'guns/m2' };
const KILL_SCALE = 0.3;
const killPictures = new Map();
// { url, width, height } (null if the picture is not there): cut to what is drawn of it,
// as the pictures have their own margins, and drawn at one scale, the weapons' sizes as in
// the game
function killPicture(num) {
  const file = num >= 1 && num <= 9 ? `guns/${num}` : KILL_FILES[num];
  if (file === undefined) return Promise.resolve(null);
  if (!killPictures.has(file)) killPictures.set(file, trimPicture(interfacePicture(file)).catch(() => null));
  return killPictures.get(file);
}

async function trimPicture(url) {
  if (!url) return null;
  const pic = await createImageBitmap(await (await fetch(url)).blob());
  const c = document.createElement('canvas');
  c.width = pic.width;
  c.height = pic.height;
  const g = c.getContext('2d');
  g.drawImage(pic, 0, 0);
  const a = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (!a[(y * c.width + x) * 4 + 3]) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return null;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, -x0, -y0);
  const blob = await new Promise((done) => out.toBlob(done));
  return { url: URL.createObjectURL(blob), width: Math.round(out.width * KILL_SCALE), height: Math.round(out.height * KILL_SCALE) };
}

const pictureUrls = new Map();
function interfacePicture(file) {
  if (!pictureUrls.has(file)) {
    const pack = game.archives.get('soldat/soldat.smod');
    const entry = pack && pack.get(`interface-gfx/${file}.png`);
    pictureUrls.set(file, entry && entry.data ? URL.createObjectURL(new Blob([entry.data], { type: 'image/png' })) : '');
  }
  return pictureUrls.get(file);
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
  const kick = s.vote && s.vote.type === 1 ? s.vote.slot : 0;
  const key = JSON.stringify([s.style, s.scores, s.follow, s.spectators, kick,
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
      if (p.slot === kick) who.append(el('span', 'chip vote', 'Vote'));
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

// ================================================================= replays

// A recorded match plays in the same view: the bar at the bottom has play/pause, the time,
// the timeline (drag it: the picture follows; captures and highlights are marked on it), the
// highlights only (highlights.js: a reel of clips, the camera on whoever made each) and the speed.
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const bar = {
  play: $('rp-play'), time: $('rp-time'), line: $('rp-line'), speed: $('rp-speed'),
  done: document.querySelector('.rp-done'), thumb: document.querySelector('.rp-thumb'),
  tip: document.querySelector('.rp-tip'), marks: document.querySelector('.rp-marks'),
  hl: $('rp-hl'), hlPrev: $('rp-hl-prev'), hlNext: $('rp-hl-next'),
};
let scrub = null;   // a drag on the timeline: { tick, playing, seeked, at, timer }
let barKey = '';

// m:ss (h:mm:ss), with tenths when asked
function timeText(ticks, tenths = false) {
  const t = Math.max(0, ticks) / TICKS;
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60;
  const sec = tenths ? (Math.floor((t % 60) * 10) / 10).toFixed(1).padStart(4, '0') : String(Math.floor(t % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// when a match was played: "Today 18:20", "Yesterday 21:05", "Oct 2 18:20"
function when(ms) {
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

const demoUrl = (id) => httpBase() + '/demos/' + encodeURIComponent(id) + '.sdm';

// a recorded match: { meta (the hub's listing), demo (parseDemo's) }; progress(got, of) as it loads
async function loadRecording(id, progress = () => {}) {
  const res = await fetch(httpBase() + '/api/demos?id=' + encodeURIComponent(id), { cache: 'no-store' });
  const meta = res.ok ? (await res.json()).demos[0] : null;
  if (!meta) throw new Error('This recording is not available (any more).');
  const file = await fetch(demoUrl(id));
  if (!file.ok) throw new Error(`The recording did not load (HTTP ${file.status}).`);
  const reader = file.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    progress(got, meta.rawBytes);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return { meta, demo: parseDemo(buf) };
}

function loadingProgress(what) {
  const text = $('loading-text'), meter = $('loading-bar');
  text.textContent = `Loading ${what}...`;
  meter.style.width = '0%';
  return (got, of) => {
    const mb = (n) => (n / 1048576).toFixed(1);
    text.textContent = `Loading ${what}... ${mb(got)} of ${mb(of)} MB`;
    meter.style.width = `${Math.min(100, (100 * got) / of)}%`;
  };
}

const replayChannel = (meta) => ({ id: meta.server, name: meta.serverName, group: meta.group, replay: true });

async function openReplay(id) {
  if (tuning) return;
  tuning = true;
  $('guide').hidden = true;
  $('loading').hidden = false;
  try {
    await started;
    const { meta, demo } = await loadRecording(id, loadingProgress('the recording'));
    playDemo(demo, meta, replayChannel(meta));
    // a link to a clip: the highlights from it on, the camera on whoever made each
    if (replayClip && replay.highlights.length) {
      if (mode !== 'auto') setMode('auto', true);
      replay.playReel(replayClip - 1);
    }
  } catch (e) {
    $('loading').hidden = true;
    $('guide').hidden = false;
    setStatus(e && e.message ? e.message : String(e), true);
    showTabAddress();
  } finally {
    tuning = false;
  }
}

function playDemo(demo, meta, ch) {
  replay = makeReplay(demo, meta);
  $('loading').hidden = true;
  watch(ch);
}

// clip: a reel's match asked for its nth clip alone
function makeReplay(demo, meta, clip = 0) {
  // recorded before the hub's director: its picks worked out again
  if (!(meta && meta.director >= DIRECTOR_VERSION)) demo.cams = directDemo(demo);
  const r = new Replay(demo, meta, {
    call: (name, ...args) => call(name, ...args),
    onFollow: (slot) => onHubMessage({ type: 'follow', slot }),
    onHold: (held) => game.al.hold(held),
    onTime: () => { barKey = ''; renderBar(); },
    onEnd: () => {
      barKey = '';
      renderBar();
      wake();
      // a reel of several matches goes on to the next one's highlights
      if (reelSet && replay && replay.reel && replay.reel.done) reelMatch(1);
    },
    onClip: (h) => {
      reelClip(h);
      // a match's own highlights: the address is a link to the clip playing (?clip=<n>)
      if (!reelSet && meta && meta.id) {
        history.replaceState(null, '', './replay?id=' + encodeURIComponent(meta.id) + (h ? `&clip=${r.reel.i + 1}` : '') + (debug ? '&debug' : ''));
      }
      if (!h) return;
      clearNews();
      showClip(h.parts[0]);
      barKey = '';
      renderBar();
    },
    onPart: (p) => { reelCam.fit = null; showClip(p); },
    onShot: (shot) => reelShot(shot),
  });
  // a reel of several matches: the clip it asks for, or the clips with the plays it asks for,
  // from the first of them to the last
  if (reelSet && clip) r.highlights = r.highlights.slice(clip - 1, clip);
  else if (reelSet) {
    r.highlights = r.highlights.flatMap((c) => {
      const first = c.parts.findIndex(reelSet.wants), last = c.parts.findLastIndex(reelSet.wants);
      if (first < 0) return [];
      // each end as that play's own clip has it
      const parts = c.parts.slice(first, last + 1);
      const from = Math.min(parts[0].start, parts[0].from), to = Math.max(parts[parts.length - 1].end, parts[parts.length - 1].to);
      parts[0] = { ...parts[0], start: from };
      parts[parts.length - 1] = { ...parts[parts.length - 1], end: to };
      return [{ ...c, parts, from, to }];
    });
  }
  return r;
}

// ---------- a reel of several matches (/replay?reel=...: the stats page's selection): their
// highlights one after another, in one connection of the game (Replay.takeOver)

let reelSet = null;  // { ids ({ id, clip }), i (the match playing), wants(play), loads (the matches loaded or loading, by index: the last few) }

async function openReel(ids) {
  tuning = true;
  $('guide').hidden = true;
  $('loading').hidden = false;
  const only = new Set((params.get('only') || '').split(',').filter((t) => HIGHLIGHT_TYPES.includes(t)));
  const player = (params.get('player') || '').trim().toLowerCase();
  // a play of the kind and by the player asked for
  const wants = (p) => (!only.size || only.has(p.type)) && (!player || p.name.toLowerCase() === player);
  reelSet = { ids, i: -1, wants, loads: new Map(), address: location.pathname + location.search };
  try {
    await started;
    if (!(await reelMatch(1))) throw new Error('These matches have no such highlights (or are not available any more).');
  } catch (e) {
    reelSet = null;
    $('loading').hidden = true;
    $('guide').hidden = false;
    setStatus(e && e.message ? e.message : String(e), true);
    showTabAddress();
  } finally {
    tuning = false;
  }
}

// match i of the reel, loaded once (the last few are kept, for going back)
function reelLoad(set, i, progress) {
  if (!set.loads.has(i)) {
    set.loads.set(i, loadRecording(set.ids[i].id, progress));
    for (const k of set.loads.keys()) if (set.loads.size > 3 && k !== i) set.loads.delete(k);
  }
  return set.loads.get(i);
}

// the next (step 1) or previous (-1) match of the reel that has clips to show; from its last
// clip when asked. False when there is none.
let reelBusy = false;
async function reelMatch(step, last = false) {
  if (!reelSet || reelBusy) return false;
  reelBusy = true;
  const set = reelSet;
  try {
    for (let j = set.i + step; j >= 0 && j < set.ids.length; j += step) {
      let got;
      try {
        got = await reelLoad(set, j, replay ? undefined : loadingProgress(`match ${j + 1} of ${set.ids.length}`));
      } catch (_) {
        continue;  // gone: the next one
      }
      if (reelSet !== set) return false;
      const r = makeReplay(got.demo, got.meta, set.ids[j].clip);
      if (!r.highlights.length) continue;
      set.i = j;
      if (replay && replay.sock) {
        r.takeOver(replay);
        replay = r;
        clearNews();
        showReplayTitle(watching);
        showBar();
      } else {
        replay = r;
        $('loading').hidden = true;
        watch(replayChannel(got.meta));
      }
      history.replaceState(null, '', set.address);
      if (mode !== 'auto') setMode('auto', true);
      replay.playReel(last ? replay.highlights.length - 1 : 0);
      // the one after loads meanwhile
      if (j + 1 < set.ids.length) reelLoad(set, j + 1).catch(() => {});
      return true;
    }
    return false;
  } finally {
    reelBusy = false;
  }
}

function showBar() {
  bar.marks.textContent = '';
  for (const m of replay.markers) {
    const i = el('i', 'mark t' + m.team);
    i.style.left = `${(100 * m.tick) / replay.length}%`;
    bar.marks.append(i);
  }
  // the captures have their marks already
  for (const h of plays()) {
    if (h.type === 'cap') continue;
    const i = el('i', 'hl');
    i.style.left = `${(100 * h.tick) / replay.length}%`;
    bar.marks.append(i);
  }
  bar.hl.hidden = !replay.highlights.length;
  bar.hl.title = `Highlights only (H): ${highlightsText(countHighlights(replay.highlights))}`;
  $('clipcap').hidden = true;
  bar.line.setAttribute('aria-valuemax', String(Math.round(replay.length / TICKS)));
  // a demo from the viewer's computer is theirs already, but for one of an older Soldat:
  // it can have it as it plays here, in Soldat 1.7.1's layout
  const conv = replay.meta.converted;
  $('rp-download').hidden = !replay.meta.id && !conv;
  if (replay.meta.id) {
    $('rp-download').href = demoUrl(replay.meta.id);
    $('rp-download').setAttribute('download', replay.meta.id + '.sdm');
    $('rp-download').title = `Download the demo (${replay.meta.id}.sdm, ${(replay.meta.bytes / 1048576).toFixed(1)} MB)`;
  } else if (conv) {
    if (convertedUrl) URL.revokeObjectURL(convertedUrl);
    convertedUrl = URL.createObjectURL(new Blob([conv.data], { type: 'application/octet-stream' }));
    $('rp-download').href = convertedUrl;
    $('rp-download').setAttribute('download', conv.file);
    $('rp-download').title = `Download the demo converted from ${conv.from} to Soldat 1.7.1 (${conv.file}, ${sizeText(conv.data.length)})`;
  }
  barKey = '';
  renderBar();
}

function renderBar() {
  if (!replay) return;
  const t = scrub ? scrub.tick : replay.time;
  const playing = scrub ? scrub.playing : replay.playing;
  const key = `${Math.round(t)} ${playing} ${replay.speed}`;
  if (key === barKey) return;
  barKey = key;
  const f = replay.length ? Math.min(1, t / replay.length) : 0;
  bar.done.style.width = bar.thumb.style.left = `${100 * f}%`;
  bar.time.textContent = `${timeText(t)} / ${timeText(replay.length)}`;
  bar.line.setAttribute('aria-valuenow', String(Math.round(t / TICKS)));
  bar.line.setAttribute('aria-valuetext', timeText(t));
  bar.play.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  bar.play.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
  bar.speed.textContent = `${replay.speed}×`;
  const clip = replay.reel ? replay.reel.i : -1;
  bar.hl.setAttribute('aria-pressed', String(clip >= 0));
  bar.hl.querySelector('span').textContent = clip >= 0 ? `${clip + 1} / ${replay.highlights.length}` : String(replay.highlights.length);
  bar.hlPrev.hidden = bar.hlNext.hidden = clip < 0;
}

// the replay's plays (its clips have one or more)
const plays = () => replay.highlights.flatMap((c) => c.parts);

// "2 multi-kills, 1 long shot, 3 saves, 9 captures"
const HIGHLIGHT_NAMES = { multi: ['multi-kill', 'multi-kills'], double: ['one-shot double', 'one-shot doubles'],
  combo: ['weapon combo', 'weapon combos'], long: ['long shot', 'long shots'], knife: ['knife throw', 'knife throws'],
  save: ['save', 'saves'], clutch: ['late capture', 'late captures'], carry: ['fought capture', 'fought captures'],
  cap: ['capture', 'captures'] };
function highlightsText(n) {
  return Object.entries(HIGHLIGHT_NAMES).filter(([k]) => n[k]).map(([k, [one, more]]) => `${n[k]} ${n[k] === 1 ? one : more}`).join(', ') || 'none';
}
// what a match is listed with: the plays, not the captures (the score has those)
const playsOf = (n) => (n ? Object.entries(n).reduce((a, [k, v]) => a + (k === 'cap' ? 0 : v), 0) : 0);

let clipTimer = 0;
function showClip(h) {
  const box = $('clipcap');
  box.textContent = '';
  const who = el('span', 'by', h.name);
  who.style.color = teamColor({ team: h.team }, true);
  const n = `${replay.reel.i + 1} / ${replay.highlights.length}`;
  // the weapons as the kill feed shows them (their names where the pictures are not there)
  const what = el('b');
  for (const c of h.caption || [h.label]) {
    const part = what.appendChild(el('span', '', typeof c === 'number' ? weaponName(c) : c));
    if (typeof c !== 'number') continue;
    killPicture(c).then((pic) => {
      if (!pic) return;
      const img = new Image(pic.width, pic.height);
      img.src = pic.url;
      img.alt = img.title = weaponName(c);
      part.replaceWith(img);
    });
  }
  // in a reel of several: the match (or, for a match's one clip, the clip) of how many
  const of = reelSet && (reelSet.ids[reelSet.i].clip ? `${reelSet.i + 1} / ${reelSet.ids.length}` : `Match ${reelSet.i + 1}/${reelSet.ids.length} · ${n}`);
  box.append(el('span', 'n', of || n), what, who);
  box.classList.remove('gone');
  box.hidden = false;
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => {
    box.classList.add('gone');
    clipTimer = setTimeout(() => { box.hidden = true; }, 600);
  }, 3500);
}

function toggleHighlights() {
  if (!replay || !replay.highlights.length) return;
  if (replay.reel) {
    replay.stopReel();
    $('clipcap').hidden = true;
    return;
  }
  // the reel follows whoever made the play
  if (mode !== 'auto') setMode('auto', true);
  // from the next one on, when the match is under way
  const i = replay.highlights.findIndex(h => h.to > replay.time + TICKS);
  replay.playReel(replay.time > TICKS && i >= 0 ? i : 0);
}

// the next or previous highlight: in the reel its clip, in the match a jump to it
function stepHighlight(d) {
  if (!replay || !replay.highlights.length) return;
  const list = replay.highlights;
  if (replay.reel) {
    const i = replay.reel.i + d;
    if (i >= 0 && i < list.length) replay.playReel(i);
    else if (reelSet) reelMatch(d, d < 0);
    return;
  }
  const t = replay.time;
  const h = d > 0 ? list.find(x => x.from > t + TICKS / 2) : [...list].reverse().find(x => x.from < t - 2 * TICKS);
  if (h) seekTo(h.from);
}

function seekTo(tick) {
  if (!replay) return;
  // a jump of the viewer's own: the whole match again
  replay.stopReel();
  $('clipcap').hidden = true;
  clearNews();
  replay.seek(tick);
  wake();
}

function togglePlay() {
  if (!replay) return;
  if (replay.playing) { replay.pause(); return; }
  if (replay.time >= replay.length) clearNews();
  replay.play();
}

const step = (seconds) => replay && seekTo(replay.time + seconds * TICKS);

const replayKeys = {
  Space: togglePlay, KeyK: togglePlay,
  KeyJ: () => step(-10), KeyL: () => step(10),
  Comma: () => step(-1), Period: () => step(1),
  Home: () => seekTo(0), End: () => replay && seekTo(replay.length),
  KeyH: toggleHighlights, BracketLeft: () => stepHighlight(-1), BracketRight: () => stepHighlight(1),
};

bar.play.addEventListener('click', togglePlay);
bar.hl.addEventListener('click', toggleHighlights);
bar.hlPrev.addEventListener('click', () => stepHighlight(-1));
bar.hlNext.addEventListener('click', () => stepHighlight(1));
bar.speed.addEventListener('click', () => {
  if (!replay) return;
  replay.setSpeed(SPEEDS[(SPEEDS.indexOf(replay.speed) + 1) % SPEEDS.length]);
});

function tickAt(x) {
  const r = bar.line.getBoundingClientRect();
  return Math.min(1, Math.max(0, (x - r.left) / r.width)) * replay.length;
}

// the time under the pointer (and the capture there)
function showTip(x) {
  if (!replay) return;
  const r = bar.line.getBoundingClientRect();
  const tick = tickAt(x);
  const close = (t) => Math.abs(t - tick) <= replay.length * 0.006;
  const near = !scrub && replay.markers.find(m => close(m.tick));
  const play = !scrub && !near && plays().find(h => h.type !== 'cap' && close(h.tick));
  bar.tip.textContent = near ? `${timeText(near.tick, true)} · ${TEAMS[near.team]} scores${near.name ? ': ' + near.name : ''}`
    : play ? `${timeText(play.tick, true)} · ${play.label}: ${play.name}` : timeText(tick, true);
  bar.tip.hidden = false;
  const w = bar.tip.offsetWidth;
  bar.tip.style.left = `${Math.min(r.width - w / 2, Math.max(w / 2, x - r.left))}px`;
}

// while the timeline is dragged the picture follows: a jump at most every 90 ms, and one
// where the pointer rests
function scrubSeek(force) {
  if (!scrub) return;
  clearTimeout(scrub.timer);
  const wait = 90 - (performance.now() - scrub.at);
  if (!force && wait > 0) { scrub.timer = setTimeout(() => scrubSeek(true), wait); return; }
  if (Math.round(scrub.tick) === Math.round(scrub.seeked)) return;
  scrub.at = performance.now();
  scrub.seeked = scrub.tick;
  seekTo(scrub.tick);
}

bar.line.addEventListener('pointerdown', (e) => {
  if (!replay || e.button !== 0) return;
  e.preventDefault();
  bar.line.focus({ preventScroll: true });
  try { bar.line.setPointerCapture(e.pointerId); } catch (_) {}
  scrub = { tick: tickAt(e.clientX), playing: replay.playing, seeked: -1, at: 0, timer: 0 };
  if (replay.playing) replay.pause();
  bar.line.classList.add('scrubbing');
  showTip(e.clientX);
  scrubSeek(true);
});
bar.line.addEventListener('pointermove', (e) => {
  showTip(e.clientX);
  if (!scrub) return;
  scrub.tick = tickAt(e.clientX);
  renderBar();
  scrubSeek(false);
});
function endScrub() {
  if (!scrub) return;
  const s = scrub;
  scrub = null;
  clearTimeout(s.timer);
  bar.line.classList.remove('scrubbing');
  bar.tip.hidden = !bar.line.matches(':hover');
  if (Math.round(s.tick) !== Math.round(s.seeked)) seekTo(s.tick);
  if (s.playing) replay.play();
  barKey = '';
  renderBar();
}
bar.line.addEventListener('pointerup', endScrub);
bar.line.addEventListener('pointercancel', endScrub);
bar.line.addEventListener('pointerleave', () => { if (!scrub) bar.tip.hidden = true; });
// the timeline as a slider: arrows 5 s (with Shift 1 s), Page keys 30 s
bar.line.addEventListener('keydown', (e) => {
  const d = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5, PageDown: -30, PageUp: 30 }[e.code];
  if (!d || !replay) return;
  e.preventDefault();
  e.stopPropagation();
  step(e.shiftKey ? Math.sign(d) : d);
});

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
  refreshDemos();
  return channels;
}

// ---------- the recorded matches of the tab's servers (those the hub records)

let demos = [];
let demosOf;          // the tab they are of
const DEMOS_SHOWN = 5;  // the newest: all of them are on the stats page
const recordsTab = () => channels.some(c => (c.group || null) === tab && c.record);

async function refreshDemos() {
  if (!recordsTab()) { renderDemos(); return; }
  const of = tab;
  try {
    const q = new URLSearchParams({ group: tab || '', limit: String(DEMOS_SHOWN) });
    const res = await fetch(httpBase() + '/api/demos?' + q, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (of !== tab) return;
    demos = data.demos || [];
    demosOf = of;
  } catch (_) {}
  renderDemos();
}

function scoreOf(d) {
  if (!['TM', 'CTF', 'INF', 'HTF'].includes(d.mode) || !d.scores) return null;
  const s = el('span', 'score-line');
  const teams = d.scores.map((n, i) => [n, i + 1]).filter(([n, t]) => t <= 2 || n);
  teams.forEach(([n, t], i) => {
    if (i) s.append(el('i', '', ':'));
    const b = el('b', '', String(n));
    b.style.color = TEAM_TEXT[t];
    s.append(b);
  });
  return s;
}

function renderDemos() {
  const show = recordsTab() && demosOf === tab;
  $('demos').hidden = !show;
  if (!show) return;
  const ol = $('demo-list');
  ol.textContent = '';
  for (const d of demos.slice(0, DEMOS_SHOWN)) {
    const li = el('li');
    const b = el('button', 'channel demo');
    b.type = 'button';
    b.title = 'Watch the replay';
    const main = el('span', 'ch-main');
    const title = el('span', 'ch-title');
    title.append(el('span', 'ch-label', when(d.start)), el('span', 'chip', d.serverName));
    main.append(title);
    const sub = el('span', 'ch-sub', d.map);
    const score = scoreOf(d);
    if (score) sub.append(' · ', score.cloneNode(true));
    if (playsOf(d.highlights)) sub.append(' · ', highlightCount(d.highlights));
    if (d.rating) sub.append(' · ', ratingBadge(d.rating));
    main.append(sub);
    const sc = el('span', 'ch-mode num');
    sc.append(score || '—');
    // wide screens: with the map (narrow ones have them on the line under the match)
    const map = el('span', 'ch-map', d.map);
    if (playsOf(d.highlights)) map.append(' ', highlightCount(d.highlights));
    if (d.rating) map.append(' ', ratingBadge(d.rating));
    b.append(main, map, sc, el('span', 'ch-players num', `${Math.max(1, Math.round(d.seconds / 60))} min`));
    b.addEventListener('click', () => openReplay(d.id));
    const dl = el('a', 'peek icon-btn dl');
    dl.href = demoUrl(d.id);
    dl.setAttribute('download', d.id + '.sdm');
    dl.setAttribute('aria-label', 'Download the demo');
    dl.title = `Download the demo (.sdm, ${(d.bytes / 1048576).toFixed(1)} MB)`;
    dl.innerHTML = '<svg><use href="#i-download"/></svg>';
    li.append(b, dl);
    appendNames(li, { id: 'demo:' + d.id, name: d.map, names: d.players });
    ol.append(li);
  }
  $('demos-empty').hidden = demos.length > 0;
  $('demos-all').hidden = !demos.length;
}

// ★ 5: the match's plays (multi-kills, long shots, saves)
function highlightCount(n) {
  const s = el('span', 'hl-count', `★ ${playsOf(n)}`);
  s.title = highlightsText(n);
  return s;
}

// how good the match is to watch (highlights.js rateMatch), what it is of on hover
function ratingBadge(r) {
  const s = el('span', 'rating', String(r.rating));
  s.title = ratingText(r).join('\n');
  return s;
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

// ---------- the demo viewer: a demo file from the viewer's computer, played on the page

let viewer = false;   // the demo viewer is open (in place of the tab's list)
const opened = [];    // the demos opened since the page loaded: { file, name, map, start, ticks, from }
let convertedUrl = null;  // the replay bar's download of a converted demo (a blob: URL)

const sizeText = (n) => `${(n / 1048576).toFixed(1)} MB`;

// a file as it was saved (Soldat TV's are .sdm; a .sdm.gz from the hub's folder works too)
async function readDemoFile(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const body = file.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(body).arrayBuffer());
  }
  return new Uint8Array(await file.arrayBuffer());
}

// Soldat TV names its demos <server>-<date>-<time>: such a file plays under the server's name
function demoName(file) {
  const base = file.name.replace(/\.gz$/i, '').replace(/\.sdm$/i, '');
  const m = /^(.+)-\d{8}-\d{6}(-\d)?$/.exec(base);
  const ch = m && channels.find(c => c.id === m[1]);
  return ch ? ch.name : base;
}

async function openFile(file) {
  if (tuning || !file) return;
  tuning = true;
  viewerStatus('');
  $('guide').hidden = true;
  $('loading').hidden = false;
  $('loading-text').textContent = 'Opening the demo...';
  $('loading-bar').style.width = '0%';
  try {
    await started;
    // a demo of an older Soldat is converted to 1.7.1's layout first (js/spectate/legacy.js)
    const migrated = await migrateDemo(await readDemoFile(file));
    const demo = parseDemo(migrated.data);
    if (!demo.msgs.length) throw new Error('This demo has nothing in it to play.');
    const name = demoName(file);
    // the header's start: a Unix time (the file's own date if there is none)
    const start = demo.start > 0 ? demo.start * 1000 : file.lastModified;
    const i = opened.findIndex(o => o.file.name === file.name && o.file.size === file.size);
    if (i >= 0) opened.splice(i, 1);
    const old = migrated.from !== '1.7.1' ? migrated.name : null;
    const entry = { file, name, map: demo.map, start, ticks: demo.ticks, from: old, highlights: null, rating: null };
    opened.unshift(entry);
    opened.length = Math.min(opened.length, 8);
    const converted = old && {
      from: old, data: migrated.data,
      file: file.name.replace(/\.gz$/i, '').replace(/\.sdm$/i, '') + '-171.sdm',
    };
    playDemo(demo, { id: null, map: demo.map, start, serverName: name, bytes: file.size, converted },
      { id: null, name, group: null, replay: true, local: true });
    entry.highlights = countHighlights(replay.highlights);
    entry.rating = rateMatch(replay.highlights, replay.length / TICKS);
    renderOpened();
  } catch (e) {
    $('loading').hidden = true;
    $('guide').hidden = false;
    viewerStatus(e instanceof RangeError || e instanceof TypeError ? 'This file could not be read as a Soldat demo.' : e && e.message ? e.message : String(e));
  } finally {
    tuning = false;
  }
}

function viewerStatus(text) {
  $('viewer-status').textContent = text;
}

function renderOpened() {
  $('opened').hidden = !opened.length;
  const ol = $('opened-list');
  ol.textContent = '';
  for (const o of opened) {
    const li = el('li');
    const b = el('button', 'channel demo');
    b.type = 'button';
    b.title = 'Watch it again';
    const main = el('span', 'ch-main');
    const title = el('span', 'ch-title');
    title.append(el('span', 'ch-label', o.name), el('span', 'chip', when(o.start)));
    const sub = el('span', 'ch-sub', o.map);
    if (o.from) sub.append(' · ', el('span', '', o.from));
    if (playsOf(o.highlights)) sub.append(' · ', highlightCount(o.highlights));
    if (o.rating) sub.append(' · ', ratingBadge(o.rating));
    main.append(title, sub);
    b.append(main, el('span', 'ch-map', o.map), el('span', 'ch-mode num', sizeText(o.file.size)),
      el('span', 'ch-players num', `${Math.max(1, Math.round(o.ticks / TICKS / 60))} min`));
    b.addEventListener('click', () => openFile(o.file));
    li.append(b);
    ol.append(li);
  }
}

function setViewer() {
  viewer = true;
  viewerStatus('');
  showTabAddress();
  renderGuide();
}

$('demo-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  openFile(file);
});
for (const a of document.querySelectorAll('.open-demo')) a.addEventListener('click', (e) => { e.preventDefault(); setViewer(); });
$('viewer-back').addEventListener('click', () => setTab(tab));

// a file dropped anywhere on the guide opens (on a match: nothing; the browser would leave the page for it)
const dragsFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!dragsFiles(e)) return;
  e.preventDefault();
  if (watching || tuning) return;
  if (!dragDepth++ && !viewer) setViewer();
  $('drop').classList.add('over');
});
document.addEventListener('dragleave', (e) => {
  if (!dragsFiles(e) || !dragDepth) return;
  if (!--dragDepth) $('drop').classList.remove('over');
});
document.addEventListener('dragover', (e) => {
  if (!dragsFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = watching || tuning ? 'none' : 'copy';
});
document.addEventListener('drop', (e) => {
  if (!dragsFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.remove('over');
  if (!watching) openFile(e.dataTransfer.files[0]);
});

// ---------- tabs: servers with a group (the hub's config) are listed under its own tab

const slug = (group) => group.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function showTabAddress() {
  history.replaceState(null, '', './' + (debug ? '?debug' : '') + (viewer ? '#demo' : tab ? '#' + slug(tab) : ''));
}

function setTab(group) {
  tab = group;
  viewer = false;
  showTabAddress();
  renderGuide();
  refreshDemos();
}

function renderTabs() {
  const groups = [...new Set(channels.map(c => c.group).filter(Boolean))];
  if (tab && !groups.includes(tab)) tab = null;
  // the demo viewer is opened from a tab's list: that tab stays on
  const live = document.querySelector('.tabs .live-tab');
  live.classList.toggle('active', !tab);
  $('guide').classList.toggle('on-viewer', viewer);
  $('viewer').hidden = !viewer;
  for (const t of document.querySelectorAll('.tabs .group')) t.remove();
  let after = live;
  for (const g of groups) {
    const a = el('a', 'tab group' + (g === tab ? ' active' : ''), g);
    a.href = '#' + slug(g);
    a.addEventListener('click', (e) => { e.preventDefault(); setTab(g); });
    after.after(a);
    after = a;
  }
}
for (const a of document.querySelectorAll('.tabs .logo, .tabs .live-tab')) a.addEventListener('click', (e) => { e.preventDefault(); setTab(null); });

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
  renderDemos();
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
  game.al.onChange(showSound);
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
  if (direct || replayId || reelIds) { $('guide').hidden = true; $('loading').hidden = false; }
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
  viewer = !ch && !replayId && hash === 'demo';
  if (replayId) {
    const demo = await fetch(httpBase() + '/api/demos?id=' + encodeURIComponent(replayId)).then(r => r.json()).catch(() => null);
    const g = demo && demo.demos[0] && demo.demos[0].group;
    if (g && channels.some(c => c.group === g)) tab = g;
  }
  renderGuide();
  refreshDemos();
  $('guide').hidden = false;
  if (replayId) await openReplay(replayId);
  else if (reelIds) await openReel(reelIds);
  else if (ch) await tuneIn(ch);
  else $('loading').hidden = true;
}

boot();

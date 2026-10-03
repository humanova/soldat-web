// Spectator page: the list of watchable matches and the spectator client
// (soldat-spectate.wasm), fed by the spectator hub (relay/spectator.mjs).
import { SoldatRuntime } from '../runtime.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ?hub=wss://example.org lets a page hosted elsewhere use a hub
function hubBase() {
  const hub = params.get('hub');
  if (hub) return hub.replace(/\/+$/, '').replace(/\/watch$/, '');
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}
const httpBase = () => hubBase().replace(/^ws/, 'http');

function setStatus(text, error = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

function showHudStatus(text) {
  $('hud-status').textContent = text || '';
  $('hud-status').hidden = !text;
}

// ---------- game runtime ----------

const canvas = $('canvas');
let watching = null;  // the match being watched: { id, name }
// the hub's director picks whom to follow (the server sends the most detail around that
// player); clicking in the game picks a player yourself
let autoCamera = true;
let director = 0;

function setAutoCamera(on) {
  autoCamera = on;
  $('auto-cam').setAttribute('aria-pressed', String(on));
  $('auto-cam').textContent = on ? 'Auto camera: on' : 'Auto camera: off';
  if (on && director && game.running) game.call('soldat_spectator_follow', director);
}

const game = new SoldatRuntime(canvas, {
  relayUrl: () => hubBase() + '/watch',
  relayRequest(kind, d) {
    if (kind === 'files') return { type: 'files', server: watching && watching.id, files: d.files };
    return { type: 'watch', server: watching && watching.id };
  },
  onRelayMessage(msg) {
    if (msg.type === 'ready') {
      // the client recognizes "its" spectator by the name: it plays the hub's part
      game.command(`cl_player_name "${String(msg.name).replace(/"/g, "'")}"`);
      showHudStatus('');
      $('hud-delay').hidden = !msg.delay;
      $('hud-delay').textContent = `${msg.delay} s delay`;
    } else if (msg.type === 'status') {
      showHudStatus(msg.message);
    } else if (msg.type === 'follow') {
      director = msg.slot | 0;
      if (params.has('debug')) console.log('[spectate] director follows slot', director);
      if (autoCamera && game.running) game.call('soldat_spectator_follow', director);
    }
  },
  args: params.has('debug') ? ['-log_level', params.get('debug') || '1'] : [],
  displaySize() {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.round(screen.width * dpr), h = Math.round(screen.height * dpr);
    const max = 3840 * 2400;
    if (w * h > max) { const s = Math.sqrt(max / (w * h)); w = Math.round(w * s); h = Math.round(h * s); }
    return [w, h];
  },
  onNetError(message) {
    setStatus(message, true);
    if (watching) game.leave();
  },
  onLeave() { leaveUi(); },
  onExit() { leaveUi(); },
});
window.soldat = game; // for debugging from the browser console

function watch(match) {
  watching = match;
  setStatus(`Opening ${match.name}...`);
  $('hud-server').textContent = match.name;
  $('hud-delay').hidden = true;
  director = 0;
  setAutoCamera(true);
  showHudStatus('Connecting...');
  $('app').hidden = true;
  $('game').hidden = false;
  game.command('cl_player_team 5');  // join as a spectator, no team menu
  if (!game.join('live', 1, '')) {
    leaveUi();
    setStatus('Could not start watching.', true);
    return;
  }
  canvas.focus();
}

function leaveUi() {
  watching = null;
  showHudStatus('');
  $('game').hidden = true;
  $('app').hidden = false;
  if (!$('status').classList.contains('error')) refresh();
}

$('back').addEventListener('click', () => game.leave());
$('auto-cam').addEventListener('click', () => setAutoCamera(!autoCamera));
canvas.addEventListener('mousedown', () => {
  game.al.resume();
  setAutoCamera(false);  // the game switches players on clicks
});
window.addEventListener('pagehide', () => { if (watching) game.leave(); });

// ---------- match list ----------

async function refresh() {
  let list = [];
  try {
    const res = await fetch(httpBase() + '/api/watch', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    list = (await res.json()).servers || [];
    setStatus(`${list.length} server${list.length === 1 ? '' : 's'}`);
  } catch (e) {
    setStatus('The match list is unavailable (' + e.message + ').', true);
  }
  const ul = $('match-list');
  ul.textContent = '';
  for (const m of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'match';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const state = document.createElement('span');
    state.className = 'state ' + m.state;
    state.textContent = { live: '● live', waiting: 'unavailable', joining: 'connecting' }[m.state] || 'standby';
    if (m.state === 'waiting' && m.error) state.title = m.error;
    meta.append(state);
    if (m.map) meta.append(Object.assign(document.createElement('span'), { textContent: m.map }));
    if (m.state === 'live') meta.append(Object.assign(document.createElement('span'), { textContent: `${m.players} playing` }));
    if (m.viewers) meta.append(Object.assign(document.createElement('span'), { textContent: `${m.viewers} watching` }));
    b.append(name, meta);
    b.addEventListener('click', () => watch(m));
    li.append(b);
    ul.append(li);
  }
  $('list-empty').hidden = list.length > 0;
}

$('refresh').addEventListener('click', refresh);

// ---------- boot ----------

async function boot() {
  const text = $('loading-text');
  const bar = $('loading-bar');
  try {
    if (!('WebAssembly' in window) || !document.createElement('canvas').getContext('webgl2')) {
      throw new Error('This browser does not support WebAssembly and WebGL 2.');
    }
    await game.load({
      base: '',
      wasm: 'soldat-spectate.wasm',
      onStatus: (s) => {
        text.textContent = s;
        const m = s.match(/(\d+) \/ (\d+) MB/);
        if (m) bar.style.width = `${Math.min(100, (100 * m[1]) / m[2])}%`;
      },
    });
    bar.style.width = '100%';
    text.textContent = 'Starting...';
    await new Promise(r => setTimeout(r, 30));
    await game.instantiate();
    game.startGame();
    $('loading').hidden = true;
    $('app').hidden = false;
    await refresh();
    setInterval(() => { if (!watching && !document.hidden) refresh(); }, 15000);
    const direct = params.get('watch');
    if (direct) {
      const res = await fetch(httpBase() + '/api/watch', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
      const m = res && res.servers.find(s => s.id === direct);
      if (m) watch(m);
    }
  } catch (e) {
    console.error(e);
    $('loading').classList.add('error');
    text.textContent = 'Failed to start: ' + (e && e.message ? e.message : e);
  }
}

boot();

// Page logic: loading screen, server browser, player settings, entering/leaving the game.
import { SoldatRuntime } from './runtime.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const SETTINGS_KEY = 'soldat.settings';
const DEFAULTS = {
  name: 'Major', shirt: '#8f8f8f', pants: '#8f8f8f', skin: '#e0b88c', hair: '#000000',
  jet: '#8f8f8f', hairstyle: 1, headstyle: 1, chainstyle: 2, sens: 0.8, volume: 50,
  fullscreen: true, hideEmpty: false, hideFull: false, sort: 'NumPlayers', asc: false,
  last: '',
};

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch (_) { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}
const settings = loadSettings();

function httpBase() {
  const relay = params.get('relay');
  if (relay) return relay.replace(/^ws/, 'http').replace(/\/relay\/?$/, '');
  return location.origin;
}
function relayUrl() {
  const relay = params.get('relay');
  if (relay) return relay;
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/relay';
}

function setStatus(text, error = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

// ---------- game runtime ----------

const canvas = $('canvas');
let inGame = false;

const game = new SoldatRuntime(canvas, {
  relayUrl,
  args: params.has('debug') ? ['-log_level', params.get('debug') || '1'] : [],
  displaySize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.round(screen.width * dpr), h = Math.round(screen.height * dpr);
    const max = 1920 * 1080;
    if (w * h > max) { const s = Math.sqrt(max / (w * h)); w = Math.round(w * s); h = Math.round(h * s); }
    return [w, h];
  },
  onPointerLock(locked) {
    $('lock-hint').hidden = locked || !inGame;
    // Esc releases the pointer before the game sees the key: open the in-game menu then
    if (!locked && wasLocked && inGame && !keyboardLocked) pendingEscape = performance.now();
    wasLocked = locked;
  },
  onNetError(message) {
    setStatus(message, true);
    // the relay refused or lost the connection: back to the server list with the reason
    if (inGame) {
      game.leave();
      setStatus(message, true);
    }
  },
  onLeave() {
    leaveGameUi();
  },
  onExit() {
    leaveGameUi();
  },
});

let keyboardLocked = false;
let pendingEscape = 0;
let wasLocked = false;
window.soldat = game; // for debugging from the browser console

function colorCvar(hex) {
  return '$00' + hex.replace('#', '').toUpperCase();
}

function applySettings() {
  const name = settings.name.replace(/["\s]+$/g, '').replace(/"/g, "'").slice(0, 23) || 'Major';
  game.command(`cl_player_name "${name}"`);
  game.command(`cl_player_shirt ${colorCvar(settings.shirt)}`);
  game.command(`cl_player_pants ${colorCvar(settings.pants)}`);
  game.command(`cl_player_skin ${colorCvar(settings.skin)}`);
  game.command(`cl_player_hair ${colorCvar(settings.hair)}`);
  game.command(`cl_player_jet ${colorCvar(settings.jet)}`);
  game.command(`cl_player_hairstyle ${settings.hairstyle | 0}`);
  game.command(`cl_player_headstyle ${settings.headstyle | 0}`);
  game.command(`cl_player_chainstyle ${settings.chainstyle | 0}`);
  game.command(`cl_sensitivity ${Number(settings.sens).toFixed(2)}`);
  game.command(`snd_volume ${settings.volume | 0}`);
}

async function enterGameUi() {
  inGame = true;
  $('app').hidden = true;
  $('game').hidden = false;
  if (settings.fullscreen && document.documentElement.requestFullscreen && !document.fullscreenElement) {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (navigator.keyboard && navigator.keyboard.lock) {
        await navigator.keyboard.lock(['Escape', 'KeyW', 'KeyQ', 'KeyT', 'KeyN', 'Tab']);
        keyboardLocked = true;
      }
    } catch (_) {}
  }
  game.sdl.requestLock();
  canvas.focus();
}

function leaveGameUi() {
  const wasInGame = inGame;
  inGame = false;
  keyboardLocked = false;
  if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  if (document.pointerLockElement) document.exitPointerLock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('game').hidden = true;
  $('app').hidden = false;
  if (wasInGame && !$('status').classList.contains('error')) refreshServers();
}

function join(host, port, password) {
  if (!host || !port) return;
  settings.last = `${host}:${port}`;
  saveSettings();
  setStatus(`Joining ${host}:${port}...`);
  applySettings();
  enterGameUi();
  if (!game.join(host, port, password || '')) {
    leaveGameUi();
    setStatus('Could not start the connection.', true);
  }
}

canvas.addEventListener('mousedown', () => {
  if (inGame && game.sdl.wantsPointerLock() && document.pointerLockElement !== canvas) game.sdl.requestLock();
  game.al.resume();
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) keyboardLocked = false;
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') pendingEscape = 0;
}, true);
// deliver the Escape press that the browser used to release the pointer
setInterval(() => {
  if (pendingEscape && performance.now() - pendingEscape > 150) {
    pendingEscape = 0;
    if (inGame) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape' }));
    }
  }
}, 50);

window.addEventListener('pagehide', () => {
  if (inGame) game.leave();
});

// ---------- server browser ----------

let servers = [];
let selected = null;

async function refreshServers() {
  try {
    setStatus('Loading server list...');
    const res = await fetch(httpBase() + '/api/servers', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    servers = (data.Servers || []).filter(s => s.Version === '1.7.1');
    setStatus(`${servers.length} servers · ${servers.reduce((n, s) => n + (s.NumPlayers || 0), 0)} players online`);
  } catch (e) {
    setStatus('Server list unavailable (' + e.message + '). You can still join by address.', true);
  }
  renderServers();
}

function renderServers() {
  const q = $('filter').value.trim().toLowerCase();
  let list = servers.filter(s => {
    if (settings.hideEmpty && !s.NumPlayers) return false;
    if (settings.hideFull && s.NumPlayers >= s.MaxPlayers) return false;
    if (!q) return true;
    return [s.Name, s.CurrentMap, s.Country, s.GameStyle, s.IP].some(v => String(v || '').toLowerCase().includes(q));
  });
  const key = settings.sort;
  list.sort((a, b) => {
    const x = a[key], y = b[key];
    const c = typeof x === 'number' ? x - y : String(x || '').localeCompare(String(y || ''));
    return settings.asc ? c : -c;
  });
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === key);
    th.classList.toggle('asc', th.dataset.sort === key && settings.asc);
  }
  const body = $('server-list');
  body.textContent = '';
  for (const s of list) {
    const tr = document.createElement('tr');
    const id = `${s.IP}:${s.Port}`;
    if (selected === id) tr.classList.add('sel');
    const name = document.createElement('td');
    name.className = 'name';
    name.textContent = s.Name;
    name.title = s.Name + (s.Info ? '\n' + s.Info : '');
    const tags = [];
    if (s.Private) tags.push('password');
    if (s.Realistic) tags.push('realistic');
    if (s.Survival) tags.push('survival');
    if (s.Advanced) tags.push('advance');
    if (s.NumBots) tags.push(`${s.NumBots} bots`);
    for (const t of tags) {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      name.appendChild(span);
    }
    const map = document.createElement('td'); map.textContent = s.CurrentMap;
    const mode = document.createElement('td'); mode.textContent = s.GameStyle;
    const pl = document.createElement('td'); pl.className = 'num'; pl.textContent = `${s.NumPlayers}/${s.MaxPlayers}`;
    const cc = document.createElement('td'); cc.textContent = s.Country || '';
    tr.append(name, map, mode, pl, cc);
    tr.addEventListener('click', () => {
      selected = id;
      $('address').value = id;
      for (const r of body.children) r.classList.remove('sel');
      tr.classList.add('sel');
    });
    tr.addEventListener('dblclick', () => {
      if (s.Private && !$('password').value) { $('password').focus(); return; }
      join(s.IP, s.Port, $('password').value);
    });
    body.appendChild(tr);
  }
  const empty = $('list-empty');
  empty.hidden = list.length > 0;
  empty.textContent = servers.length ? 'No servers match the filter.' : 'No servers listed.';
}

function parseAddress(text) {
  const m = text.trim().match(/^(?:soldat:\/\/)?\[?([^\]\s/]+?)\]?(?::(\d+))?\/?$/i);
  if (!m) return null;
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 23073 };
}

// ---------- settings UI ----------

function bindSettings() {
  const map = [
    ['p-name', 'name'], ['p-shirt', 'shirt'], ['p-pants', 'pants'], ['p-skin', 'skin'],
    ['p-hair', 'hair'], ['p-jet', 'jet'], ['p-hairstyle', 'hairstyle'], ['p-headstyle', 'headstyle'],
    ['p-chainstyle', 'chainstyle'], ['s-sens', 'sens'], ['s-vol', 'volume'],
  ];
  for (const [id, key] of map) {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener('input', () => {
      settings[key] = el.type === 'range' || el.tagName === 'SELECT' ? Number(el.value) : el.value;
      saveSettings();
      showRanges();
    });
  }
  $('s-fullscreen').checked = settings.fullscreen;
  $('s-fullscreen').addEventListener('change', () => { settings.fullscreen = $('s-fullscreen').checked; saveSettings(); });
  $('hide-empty').checked = settings.hideEmpty;
  $('hide-full').checked = settings.hideFull;
  $('hide-empty').addEventListener('change', () => { settings.hideEmpty = $('hide-empty').checked; saveSettings(); renderServers(); });
  $('hide-full').addEventListener('change', () => { settings.hideFull = $('hide-full').checked; saveSettings(); renderServers(); });
  $('filter').addEventListener('input', renderServers);
  $('refresh').addEventListener('click', refreshServers);
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', () => {
      if (settings.sort === th.dataset.sort) settings.asc = !settings.asc;
      else { settings.sort = th.dataset.sort; settings.asc = th.dataset.sort !== 'NumPlayers'; }
      saveSettings();
      renderServers();
    });
  }
  $('address').value = params.get('join') || settings.last || '';
  $('direct').addEventListener('submit', (e) => {
    e.preventDefault();
    const a = parseAddress($('address').value);
    if (!a) { setStatus('Enter a server address like 1.2.3.4:23073', true); return; }
    join(a.host, a.port, $('password').value);
  });
  $('clear-downloads').addEventListener('click', async () => {
    await game.vfs.clearPersistent('/user/downloads');
    game.vfs.mkdirp('/user/downloads');
    setStatus('Downloaded maps deleted.');
  });
  showRanges();
}

function showRanges() {
  $('s-sens-v').textContent = Number(settings.sens).toFixed(2);
  $('s-vol-v').textContent = `${settings.volume | 0}%`;
}

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
    bindSettings();
    refreshServers();
    setInterval(() => { if (!inGame && !document.hidden) refreshServers(); }, 30000);
    const direct = params.get('join');
    if (direct) setStatus('Press Join to connect to ' + direct);
  } catch (e) {
    console.error(e);
    $('loading').classList.add('error');
    text.textContent = 'Failed to start: ' + (e && e.message ? e.message : e);
  }
}

boot();

// Page logic: loading screen, server browser, player settings, entering/leaving the game.
import { SoldatRuntime } from './runtime.js';
import { GostekPreview, WEAPONS } from './gostek.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const SETTINGS_KEY = 'soldat.settings';
// player colors of the Soldat 1.7.1 default profile ("Major")
const DEFAULTS = {
  name: 'Major', shirt: '#304289', pants: '#1f8957', skin: '#e6b478', hair: '#000000',
  jet: '#ffff00', hairstyle: 1, headstyle: 1, chainstyle: 2, sens: 0.8, volume: 50,
  fullscreen: true, hideEmpty: false, hideFull: false, sort: 'NumPlayers', asc: false,
  last: '', previewWeapon: 2,
};
// names of the look options, by their cl_player_* value
const STYLES = {
  hairstyle: ['None', 'Dreadlocks', 'Punk', 'Mr. T', 'Normal'],
  headstyle: ['Nothing', 'Helmet', 'Hat'],
  chainstyle: ['None', 'Silver chain', 'Gold chain'],
};
// defaults of earlier versions of this page: all gray
const OLD_GRAY = '#8f8f8f';

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (_) {}
  const s = { ...DEFAULTS, ...saved };
  if (s.shirt === OLD_GRAY && s.pants === OLD_GRAY && s.jet === OLD_GRAY) {
    s.shirt = DEFAULTS.shirt;
    s.pants = DEFAULTS.pants;
    s.jet = DEFAULTS.jet;
    if (s.skin === '#e0b88c') s.skin = DEFAULTS.skin;
  }
  return s;
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
let preview = null;  // gostek preview of the menu, once the game data is loaded

const game = new SoldatRuntime(canvas, {
  relayUrl,
  args: params.has('debug') ? ['-log_level', params.get('debug') || '1'] : [],
  displaySize() {
    // the game renders at the screen's native resolution like the original client
    // (text and interface are drawn for that size); only very large screens are capped
    const dpr = window.devicePixelRatio || 1;
    let w = Math.round(screen.width * dpr), h = Math.round(screen.height * dpr);
    const max = 3840 * 2400;
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
  if (preview) preview.stop();
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
  if (preview) preview.start();
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
    const mode = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'mode ' + String(s.GameStyle || '').toLowerCase();
    badge.textContent = s.GameStyle || '?';
    mode.appendChild(badge);
    const pl = document.createElement('td'); pl.className = 'num';
    const count = document.createElement('span'); count.className = 'players';
    const meter = document.createElement('span'); meter.className = 'meter';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, (100 * (s.NumPlayers || 0)) / (s.MaxPlayers || 1))}%`;
    meter.appendChild(fill);
    count.append(`${s.NumPlayers}/${s.MaxPlayers}`, meter);
    pl.appendChild(count);
    const cc = document.createElement('td'); cc.textContent = s.Country || '';
    if (!s.NumPlayers) tr.classList.add('empty-server');
    tr.append(name, map, mode, pl, cc);
    tr.addEventListener('click', () => {
      selected = id;
      $('address').value = id;
      showMapOnStage(s.CurrentMap);
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

// the server with the most human players that has room and no password
function quickJoin() {
  const open = servers.filter(s => !s.Private && s.NumPlayers < s.MaxPlayers);
  if (!open.length) { setStatus('No open server to join right now.', true); return; }
  const humans = (s) => (s.NumPlayers || 0) - (s.NumBots || 0);
  open.sort((a, b) => humans(b) - humans(a) || b.NumPlayers - a.NumPlayers);
  const s = open[0];
  $('address').value = `${s.IP}:${s.Port}`;
  join(s.IP, s.Port, '');
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
    ['p-hair', 'hair'], ['p-jet', 'jet'], ['s-sens', 'sens'], ['s-vol', 'volume'],
  ];
  for (const [id, key] of map) {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener('input', () => {
      settings[key] = el.type === 'range' ? Number(el.value) : el.value;
      saveSettings();
      showRanges();
      if (preview) preview.setLook(settings);
    });
  }
  for (const el of document.querySelectorAll('.cycler[data-key]')) {
    const key = el.dataset.key;
    const names = STYLES[key];
    const out = el.querySelector('output');
    const show = () => { out.textContent = names[settings[key]] || names[0]; };
    const step = (d) => {
      settings[key] = ((settings[key] | 0) + d + names.length) % names.length;
      saveSettings();
      show();
      if (preview) preview.setLook(settings);
    };
    el.querySelector('.prev').addEventListener('click', () => step(-1));
    el.querySelector('.next').addEventListener('click', () => step(1));
    show();
  }
  $('quick').addEventListener('click', quickJoin);
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

// ---------- the gostek stands on the selected server's map ----------

const STAGE_MAP = 'ctf_Ash';

// sky and ground of a map, from its file header (MapFile.pas): version, name, texture,
// then the sky's top and bottom colors (BGRA). The game spreads the two colors over the
// whole map height, so on screen the sky is nearly one color: the stage takes it from
// the middle. Maps come from the game data or from earlier downloads.
function mapScenery(name) {
  const path = `maps/${name}.pms`;
  const pack = game.archives.get('soldat/soldat.smod');
  const entry = pack && pack.get(path.toLowerCase());
  const file = !entry && game.vfs.lookup('/user/downloads/' + path, { caseInsensitive: true });
  const b = entry ? entry.data : file && file.type === 'file' ? file.bytes() : null;
  if (!b || b.length < 80) return null;
  let o = 4 + 1 + 38;
  const texture = String.fromCharCode(...b.subarray(o + 1, o + 1 + Math.min(b[o], 24)));
  o += 1 + 24;
  const mix = (i) => Math.round(b[o + i] + (b[o + 4 + i] - b[o + i]) * 0.45);
  const sky = `rgb(${mix(2)}, ${mix(1)}, ${mix(0)})`;
  // how many world units the texture repeats over, from the polygons' texture coordinates
  // (vertices: x, y, z, rhw, color, u, v; then 3 normals and the polygon type)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = o + 8 + 4 + 4 + 4;
  const count = dv.getInt32(p, true);
  p += 4;
  const repeats = [];
  for (let i = 0; i < count && p + 3 * 28 + 37 <= b.length; i++, p += 37) {
    const v = [];
    for (let k = 0; k < 3; k++, p += 28) v.push([dv.getFloat32(p, true), dv.getFloat32(p + 20, true)]);
    for (const [a, c] of [[0, 1], [0, 2], [1, 2]]) {
      const dx = v[c][0] - v[a][0], du = v[c][1] - v[a][1];
      if (Math.abs(du) > 1e-4 && Math.abs(dx) > 5) repeats.push(Math.abs(dx / du));
    }
  }
  repeats.sort((x, y) => x - y);
  return { texture, sky, repeat: repeats.length ? repeats[repeats.length >> 1] : 128 };
}

function showMapOnStage(name) {
  const m = (name && mapScenery(name)) || mapScenery(STAGE_MAP);
  if (!m) return;
  const stage = document.querySelector('.stage');
  const tex = game.findAsset('textures/' + m.texture);
  stage.style.backgroundColor = m.sky;
  stage.style.setProperty('--ground', tex ? `url("${game.assetBase}${encodeURI(tex)}")` : 'none');
  // the preview draws 33 world units over the stage's height (gostek.js)
  stage.style.setProperty('--ground-size', `${Math.round((m.repeat * stage.clientHeight) / 33)}px`);
}

// ---------- logo and gostek preview ----------

function packImageUrl(path) {
  const pack = game.archives.get('soldat/soldat.smod');
  const e = pack && pack.get(path);
  return e && e.data ? URL.createObjectURL(new Blob([e.data], { type: 'image/png' })) : null;
}

// the title from the game's own interface graphics
function showLogo() {
  const l = packImageUrl('interface-gfx/title-l.png');
  const r = packImageUrl('interface-gfx/title-r.png');
  if (!l || !r) return;
  $('logo-l').src = l;
  $('logo-r').src = r;
  $('logo').hidden = false;
  $('wordmark').hidden = true;
}

async function setupPreview() {
  try {
    const p = new GostekPreview($('gostek'), game.archives.get('soldat/soldat.smod'));
    await p.load();
    preview = p;
  } catch (e) {
    console.warn('Gostek preview unavailable:', e);
    document.querySelector('.stage').hidden = true;
    return;
  }
  // number keys pick his weapon, like the game's weapon menu (1 Desert Eagles ... 0 Minigun)
  window.addEventListener('keydown', (e) => {
    const m = /^Digit(\d)$/.exec(e.code);
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (!m || inGame || typing || e.ctrlKey || e.metaKey || e.altKey) return;
    settings.previewWeapon = (Number(m[1]) + 9) % WEAPONS.length;
    preview.setWeapon(settings.previewWeapon);
    saveSettings();
  });
  // left button shoots, right button holds the jets (like in the game)
  const stage = $('gostek');
  stage.addEventListener('pointerdown', (e) => {
    if (e.button === 0) preview.fire();
    if (e.button === 2) { preview.setJets(true); stage.setPointerCapture(e.pointerId); }
  });
  stage.addEventListener('pointerup', (e) => { if (e.button === 2) preview.setJets(false); });
  stage.addEventListener('pointercancel', () => preview.setJets(false));
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  $('p-jet').addEventListener('input', () => preview.showJets());
  window.addEventListener('pointermove', (e) => { if (!inGame) preview.aimAt(e.clientX, e.clientY); });
  preview.setLook(settings);
  preview.setWeapon(settings.previewWeapon | 0);
  if (!inGame) preview.start();
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
    showLogo();
    showMapOnStage(null);
    setupPreview();
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

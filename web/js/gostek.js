// Soldier preview of the menu. Draws a gostek the way the game does (GostekGraphics.pas):
// the body part sprites of the game data on the skeleton of objects/gostek.po, posed by
// the stand animation like TSprite.Update poses it, head and arms aimed at the mouse,
// chain and dreadlocks swinging with the game's physics (60 ticks per second). With jets
// on, it lifts off with the game's jet flames (Control.pas, Sparks.pas) in the jet color.
import { TEXTURES, TEAM2_OFFSET, SPARKS, PARTS, PART } from './gostek-data.js';

const ANIM_SCALE = 3;               // Anims.pas
const GRAVITY = 1.06 * 0.06;        // GostekSkeleton.Gravity with the default sv_gravity
const VDAMPING = 0.9945;            // a sprite's skeleton (Sprites.pas)
const BODY_Y = 8;                   // standing
const STAND_SPEED = 3;              // ticks per animation frame
const RESTRICT = 16;                // GOS_RESTRICT_WIDTH / _HEIGHT
const COLOR_HEADBLOOD = 0xaca9a8;
const NADES = 2;
const SPARK_GRAVITY = 0.06 / 1.4;    // SparkParts
const SPARK_DAMPING = 0.998;
const GROUND = 2;                    // where the stage's ground is below the feet
const MAX_LIFT = 4.5;                // how high the jets lift the soldier off the stage

const LEGS = [1, 2, 3, 4, 5, 6, 17, 18];
const BODY = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20];

export const WEAPONS = [
  ['Desert Eagles', 'DEAGLES'], ['HK MP5', 'MP5'], ['Ak-74', 'AK74'], ['Steyr AUG', 'STEYR'],
  ['Spas-12', 'SPAS'], ['Ruger 77', 'RUGER'], ['M79', 'M79'], ['Barrett M82A1', 'BARRETT'],
  ['FN Minimi', 'MINIMI'], ['XM214 Minigun', 'MINIGUN'],
].map(([name, id]) => ({
  name,
  gun: PART['PRIMARY_' + id],
  clip: PART['PRIMARY_' + id + '_CLIP'],
  fire: PART['PRIMARY_' + id + '_FIRE'],
}));

function tokens(archive, path) {
  const e = archive.get(path);
  if (!e || !e.data) throw new Error('missing ' + path);
  return new TextDecoder().decode(e.data).split(/\s+/).filter(Boolean);
}

// objects/*.po: points (name, x, y, z) until CONSTRAINTS, then point pairs until ENDFILE
function loadSkeleton(archive) {
  const t = tokens(archive, 'objects/gostek.po');
  const pos = [null];
  let i = 0;
  while (t[i] !== 'CONSTRAINTS') {
    const x = parseFloat(t[i + 1]), z = parseFloat(t[i + 3]);
    pos.push({ x: -x * ANIM_SCALE / 1.2, y: -z * ANIM_SCALE });
    i += 4;
  }
  i++;
  const constraints = [null];
  while (t[i] && t[i] !== 'ENDFILE') {
    const a = parseInt(t[i].slice(1), 10), b = parseInt(t[i + 1].slice(1), 10);
    constraints.push({ a, b, rest: Math.hypot(pos[a].x - pos[b].x, pos[a].y - pos[b].y) });
    i += 2;
  }
  return { pos, constraints };
}

// anims/*.poa: (point, x, y, z) entries, NEXTFRAME between frames, ENDFILE
function loadAnimation(archive, path) {
  const t = tokens(archive, path);
  const frames = [[]];
  for (let i = 0; i < t.length && t[i] !== 'ENDFILE';) {
    if (t[i] === 'NEXTFRAME') { frames.push([]); i++; continue; }
    const p = parseInt(t[i], 10);
    frames[frames.length - 1][p] = { x: -ANIM_SCALE * parseFloat(t[i + 1]) / 1.1, y: -ANIM_SCALE * parseFloat(t[i + 3]) };
    i += 4;
  }
  return frames;
}

// mod.ini: [SCALE] image scales and [GOSTEK] part centers (TStringList values: case-insensitive)
function loadModIni(archive) {
  const ini = {};
  const e = archive.get('mod.ini');
  let section = '';
  for (const raw of e && e.data ? new TextDecoder().decode(e.data).split(/\r?\n/) : []) {
    const line = raw.trim();
    const s = line.match(/^\[(.+)\]$/);
    if (s) { section = s[1].toUpperCase(); ini[section] = ini[section] || {}; continue; }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && section) ini[section][kv[1].trim().toLowerCase()] = kv[2].trim();
  }
  return ini;
}

function imageScale(ini, path) {
  const scales = ini.SCALE || {};
  const dir = path.slice(0, path.lastIndexOf('/'));
  return parseFloat(scales[path] ?? scales[dir] ?? scales.defaultscale ?? '1') || 1;
}

function rgb(hex) {
  const n = typeof hex === 'number' ? hex : parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class GostekPreview {
  constructor(canvas, archive) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.archive = archive;
    this.look = {};
    this.weapon = 2;
    this.textures = new Map();
    this.tinted = new Map();
    this.aim = null;
    this.flash = 0;
    this.jets = false;
    this.jetsUntil = 0;
    this.hover = 0;
    this.lift = 0;
    this.sparks = [];
    this.frame = 1;
    this.count = 0;
    this.running = false;
    this.last = 0;
    this.lag = 0;
  }

  async load() {
    const { pos, constraints } = loadSkeleton(this.archive);
    this.pos = pos.map(p => (p ? { ...p } : null));
    this.old = pos.map(p => (p ? { ...p } : null));
    this.constraints = constraints;
    this.stand = loadAnimation(this.archive, 'anims/stoi.poa');
    this.fall = loadAnimation(this.archive, 'anims/spada.poa');  // legs in the air, played once
    this.fallFrame = 0;
    const ini = loadModIni(this.archive);

    this.parts = PARTS.map(([id, image, p1, p2, cx, cy, visible, flip, team, flex, color, alpha]) => {
      const g = ini.GOSTEK || {};
      const ox = parseFloat(g[(id + '_CenterX').toLowerCase()]);
      const oy = parseFloat(g[(id + '_CenterY').toLowerCase()]);
      return { image, p1, p2, cx: isNaN(ox) ? cx : ox, cy: isNaN(oy) ? cy : oy, visible, flip, team, flex, color, alpha };
    });

    await Promise.all(Object.entries(TEXTURES).map(async ([id, name]) => {
      const lower = name.toLowerCase();
      const png = lower.replace(/\.[^./]+$/, '.png');
      const path = this.archive.has(png) ? png : lower;
      const entry = this.archive.get(path);
      if (!entry || !entry.data) return;
      const bitmap = await createImageBitmap(new Blob([entry.data]));
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bitmap, 0, 0);
      const s = imageScale(ini, path);
      this.textures.set(+id, {
        canvas: c, pixels: x.getImageData(0, 0, c.width, c.height),
        w: c.width / s, h: c.height / s,
      });
    }));
    this.restrictCenters();
    // pose once, then let the chain (22) and the dreadlocks (24) hang from their anchors
    // instead of swinging in from the skeleton file's coordinates
    this.tick();
    const hang = (free, anchor, rest) => {
      this.pos[free] = { x: anchor.x, y: anchor.y + rest };
      this.old[free] = { ...this.pos[free] };
    };
    hang(22, this.pos[9], this.constraints[29].rest);
    hang(24, this.pos[23], this.constraints[30].rest);
    for (let i = 0; i < 30; i++) this.tick();
  }

  // ApplyGostekConstraints: keeps part centers near their sprite
  restrictCenters() {
    for (const p of this.parts) {
      if (!p.image) continue;
      let w = 0, h = 0;
      for (const t of [0, p.flip ? 1 : 0, p.team ? TEAM2_OFFSET : 0, (p.team ? TEAM2_OFFSET : 0) + (p.flip ? 1 : 0)]) {
        const tex = this.textures.get(p.image + t);
        if (tex) { w = Math.max(w, tex.w); h = Math.max(h, tex.h); }
      }
      if (!w || !h) continue;
      if (w * Math.abs(p.cx + 0.5) > w + RESTRICT) p.cx = 0.5 + Math.sign(p.cx + 0.5) * ((w + RESTRICT) / w);
      if (h * Math.abs(p.cy + 0.5) > h + RESTRICT) p.cy = 0.5 + Math.sign(p.cy + 0.5) * ((h + RESTRICT) / h);
    }
  }

  setLook(look) {
    this.look = { ...look };
    this.tinted.clear();
    this.draw();
  }

  setWeapon(index) {
    this.weapon = ((index % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
    this.draw();
    return WEAPONS[this.weapon].name;
  }

  // muzzle flash for the next two drawn frames (counted in frames, not ticks, so that a
  // slow frame rate cannot skip it)
  fire() {
    this.flash = 2;
  }

  setJets(on) {
    this.jets = on;
  }

  // jets for a moment, to show the jet color
  showJets(ms = 1200) {
    this.jetsUntil = performance.now() + ms;
  }

  jetting() {
    return this.jets || performance.now() < this.jetsUntil;
  }

  // page coordinates of the mouse; the soldier looks at it
  aimAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const v = this.view();
    this.aim = {
      x: ((clientX - r.left) * (this.canvas.width / r.width) - v.ox) / v.zoom,
      y: ((clientY - r.top) * (this.canvas.height / r.height) - v.oy) / v.zoom,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.lag = 0;
    // a loop from before a stop() may still have a frame pending: only the newest runs
    const generation = this.generation = (this.generation || 0) + 1;
    const loop = (now) => {
      if (!this.running || generation !== this.generation) return;
      this.lag = Math.min(this.lag + now - this.last, 250);
      this.last = now;
      let stepped = false;
      while (this.lag >= 1000 / 60) { this.tick(); this.lag -= 1000 / 60; stepped = true; }
      if (stepped) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  // one game tick of TSprite.Update for a standing soldier at (0, 0)
  tick() {
    const pos = this.pos, old = this.old;
    old[21] = { ...pos[21] };
    old[23] = { ...pos[23] };
    pos[21] = { ...pos[9] };
    pos[23] = { ...pos[12] };

    if (++this.count === STAND_SPEED) {
      this.count = 0;
      if (++this.frame > this.stand.length) this.frame = 1;
    }
    const f = this.stand[this.frame - 1];
    const aim = this.aim || { x: 60, y: -14 };
    const dir = aim.x >= 0 ? 1 : -1;
    this.dir = dir;
    // jets lift the soldier a little, gravity brings it back
    const jets = this.jetting();
    this.lift = (this.lift + (jets ? -0.16 : 0.12)) * 0.9;
    this.hover = Math.min(0, Math.max(-MAX_LIFT, this.hover + this.lift));
    if (this.hover === 0 && this.lift > 0) this.lift = 0;
    this.fallFrame = this.hover < -0.5 ? Math.min(this.fall.length, this.fallFrame + 1) : 0;
    const legs = this.fallFrame ? this.fall[this.fallFrame - 1] : f;
    for (const i of LEGS) {
      old[i] = { ...pos[i] };
      pos[i] = { x: dir * legs[i].x, y: this.hover + legs[i].y };
    }
    for (const i of BODY) {
      old[i] = { ...pos[i] };
      pos[i] = { x: dir * f[i].x, y: pos[6].y + BODY_Y + f[i].y };
    }

    // head
    let n = norm(pos[12].x - aim.x, pos[12].y - aim.y);
    pos[12] = { x: pos[9].x - dir * n.y * 0.1, y: pos[9].y + dir * n.x * 0.1 };
    pos[23] = { x: pos[9].x - dir * n.y * 5, y: pos[9].y + dir * n.x * 5 };
    // arms
    n = norm(pos[15].x - aim.x, pos[15].y - aim.y);
    pos[15] = { x: pos[16].x - 7 * n.x, y: pos[16].y - 7 * n.y };
    n = norm(pos[19].x - aim.x, pos[19].y - aim.y);
    pos[19] = { x: pos[16].x - 8 * n.x, y: pos[16].y - 4 - 8 * n.y };

    this.verlet(22);
    this.satisfy(29);
    this.verlet(24);
    this.satisfy(30);

    // jet flames from both feet, like Control.pas (its smoke puffs are left out: the
    // sprite only looks like smoke at the game's small scale)
    if (jets) {
      for (const [foot, a, b] of [[1, 5, 4], [2, 6, 3]]) {
        const n = norm(pos[a].x - pos[b].x, pos[a].y - pos[b].y);
        if (Math.random() < 1 / 7) {
          this.sparks.push({ x: pos[foot].x - 1, y: pos[foot].y + 3, vx: -0.5 * n.x, vy: -0.5 * n.y, life: 40 });
        }
      }
    }
    for (const sp of this.sparks) {
      sp.vy += SPARK_GRAVITY;
      sp.x += sp.vx;
      sp.y += sp.vy;
      sp.vx *= SPARK_DAMPING;
      sp.vy *= SPARK_DAMPING;
      if (sp.y > GROUND) { sp.y = GROUND; sp.vy = 0; sp.vx *= 0.8; }
      sp.life--;
    }
    this.sparks = this.sparks.filter(sp => sp.life > 0);
  }

  verlet(i) {
    const p = this.pos[i], o = this.old[i];
    this.old[i] = { ...p };
    this.pos[i] = {
      x: p.x * (1 + VDAMPING) - o.x * VDAMPING,
      y: p.y * (1 + VDAMPING) - o.y * VDAMPING + GRAVITY,
    };
  }

  satisfy(k) {
    const { a, b, rest } = this.constraints[k];
    const pa = this.pos[a], pb = this.pos[b];
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy);
    const diff = len ? (len - rest) / len : 0;
    this.pos[a] = { x: pa.x + dx * 0.5 * diff, y: pa.y + dy * 0.5 * diff };
    this.pos[b] = { x: pb.x - dx * 0.5 * diff, y: pb.y - dy * 0.5 * diff };
  }

  visibleParts() {
    const L = this.look;
    const v = new Set();
    this.parts.forEach((p, i) => { if (p.visible) v.add(i); });
    if (this.jetting()) {
      v.delete(PART.LEFT_FOOT);
      v.delete(PART.RIGHT_FOOT);
      v.add(PART.LEFT_JETFOOT);
      v.add(PART.RIGHT_JETFOOT);
    }
    for (let i = 0; i < NADES; i++) v.add(PART.FRAG_GRENADE1 + i);
    if (L.chainstyle === 1) [PART.SILVER_LCHAIN, PART.SILVER_RCHAIN, PART.SILVER_PENDANT].forEach(i => v.add(i));
    if (L.chainstyle === 2) [PART.GOLDEN_LCHAIN, PART.GOLDEN_RCHAIN, PART.GOLDEN_PENDANT].forEach(i => v.add(i));
    if (L.headstyle === 1) v.add(PART.HELMET);
    if (L.headstyle === 2) v.add(PART.HAT);
    if (!L.headstyle || L.hairstyle === 3) {
      if (L.hairstyle === 1) for (let i = 0; i <= 5; i++) v.add(PART.HAIR_DREADLOCKS + i);
      if (L.hairstyle === 2) v.add(PART.HAIR_PUNK);
      if (L.hairstyle === 3) v.add(PART.MR_T);
      if (L.hairstyle === 4) v.add(PART.HAIR_NORMAL);
    }
    const w = WEAPONS[this.weapon];
    v.add(w.gun);
    if (w.clip !== undefined) v.add(w.clip);
    if (this.flash > 0 && w.fire !== undefined) v.add(w.fire);
    return v;
  }

  // texture modulated by a color, like the game's vertex colors
  texture(id, color) {
    const tex = this.textures.get(id);
    if (!tex || color === 0xffffff) return tex && tex.canvas;
    const key = id + ':' + color;
    let c = this.tinted.get(key);
    if (!c) {
      const [r, g, b] = rgb(color);
      const src = tex.pixels;
      const out = new ImageData(src.width, src.height);
      for (let i = 0; i < src.data.length; i += 4) {
        out.data[i] = (src.data[i] * r) / 255;
        out.data[i + 1] = (src.data[i + 1] * g) / 255;
        out.data[i + 2] = (src.data[i + 2] * b) / 255;
        out.data[i + 3] = src.data[i + 3];
      }
      c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').putImageData(out, 0, 0);
      this.tinted.set(key, c);
    }
    return c;
  }

  // the soldier is about 22 units tall (feet at 0, the helmet's top near -22) and stands
  // on the stage's ground line at 84% of its height
  view() {
    const { width, height } = this.canvas;
    return { zoom: height / 33, ox: width / 2, oy: height * 0.84 };
  }

  draw() {
    if (!this.pos || !this.textures.size) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(this.canvas.clientWidth * dpr), ch = Math.round(this.canvas.clientHeight * dpr);
    if (cw && ch && (this.canvas.width !== cw || this.canvas.height !== ch)) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    const { zoom, ox, oy } = this.view();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // shadow on the ground, smaller while flying
    const k = 1 + this.hover / 25;
    ctx.fillStyle = `rgba(0, 0, 0, ${0.35 * k})`;
    ctx.beginPath();
    ctx.ellipse(ox, oy + GROUND * zoom, 9 * zoom * k, 1.6 * zoom * k, 0, 0, Math.PI * 2);
    ctx.fill();

    const L = this.look;
    // jet flames: drawn at the spark's position, turned by its life in degrees, fading out
    const fire = this.textures.get(SPARKS.JETFIRE);
    const fireImg = this.texture(SPARKS.JETFIRE, rgbInt(L.jet));
    for (const sp of fire && fireImg ? this.sparks : []) {
      ctx.globalAlpha = Math.min(255, sp.life * 5) / 255;
      ctx.setTransform(zoom, 0, 0, zoom, ox + sp.x * zoom, oy + sp.y * zoom);
      ctx.rotate((sp.life * Math.PI) / 180);
      ctx.drawImage(fireImg, 0, 0, fire.w, fire.h);
    }
    ctx.globalAlpha = 1;

    const colors = [0xffffff, rgbInt(L.shirt), rgbInt(L.pants), rgbInt(L.skin), rgbInt(L.hair), 0xffffff, COLOR_HEADBLOOD];
    const alphas = [1, 0, Math.trunc(0.75 * 255) / 255];
    const visible = this.visibleParts();
    const pos = this.pos, dir = this.dir || 1;

    let headM = null;
    if (visible.has(PART.HAIR_DREADLOCKS)) {
      const h = this.parts[PART.HEAD];
      const r = Math.atan2(pos[h.p2].y - pos[h.p1].y, pos[h.p2].x - pos[h.p1].x) - Math.PI / 2;
      headM = [Math.cos(r), Math.sin(r)];
    }

    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!visible.has(i) || !p.image) continue;
      let tex = p.image;
      let x1 = pos[p.p1].x, y1 = pos[p.p1].y;
      const x2 = pos[p.p2].x, y2 = pos[p.p2].y;
      const r = Math.atan2(y2 - y1, x2 - x1);
      let cx = p.cx, cy = p.cy, sx = 1, sy = 1;
      if (dir !== 1) {
        if (p.flip) { cy = 1 - p.cy; tex += 1; } else sy = -1;
      }
      const t = this.textures.get(tex);
      const img = this.texture(tex, colors[p.color]);
      if (!t || !img) continue;
      cx *= t.w;
      cy *= t.h;
      if (i >= PART.HAIR_DREADLOCK1 && i <= PART.HAIR_DREADLOCK5) {
        const vx = -cy * dir, vy = cx;
        x1 += headM[0] * vx - headM[1] * vy;
        y1 += headM[1] * vx + headM[0] * vy;
        cx = 0;
        cy = 0.5 * t.h;
        sx = 0.75 + (0.25 / 5) * (i - PART.HAIR_DREADLOCK1);
      } else if (p.flex > 0) {
        sx = Math.min(1.5, Math.hypot(x2 - x1, y2 - y1) / p.flex);
      }
      ctx.globalAlpha = alphas[p.alpha];
      if (!ctx.globalAlpha) continue;
      ctx.setTransform(zoom, 0, 0, zoom, ox, oy);
      ctx.translate(x1, y1 + 1);
      ctx.rotate(r);
      ctx.scale(sx, sy);
      ctx.translate(-cx, -cy);
      ctx.drawImage(img, 0, 0, t.w, t.h);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.flash > 0) this.flash--;
  }
}

function norm(x, y) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

function rgbInt(hex) {
  const [r, g, b] = rgb(hex || '#ffffff');
  return (r << 16) | (g << 8) | b;
}

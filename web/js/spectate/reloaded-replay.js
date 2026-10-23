// A Soldat Reloaded match recorded (relay/lib/reloaded/record.mjs) as the page's bar plays
// it: Replay's part (replay.js) for a game that plays the demo itself. The game in the frame
// (apps/client/match/tv.odin in reloaded/) has the demo; the page asks it where it is, sets
// its speed and has it jump (a jump back plays it again from its start, unseen). The bar,
// the highlights only, the clips and their camera are as for a 1.7.1 demo: the clips come
// from the hub (relay/lib/reloaded/plays.mjs), and whom the director followed is in the demo
// (its camera records), which the game tells as it plays; for a demo recorded before those,
// the hub works the picks out (meta.cams, as directDemo does for an old 1.7.1 demo).
//
// hooks: call(export, ...args) into the game, onFollow(slot), onTime(), onEnd(),
// onClip(clip), onPart(play), onShot(shot), onReady() (the game has the demo: its length and
// captures are known)
import { Replay } from './replay.js';

const TICKS = 60;

export class ReloadedReplay {
  // meta: the hub's listing; highlights: the clips of its plays (findHighlights's shape)
  constructor(meta, highlights, hooks) {
    this.meta = meta;
    this.hooks = hooks;
    this.speed = 1;
    this.playing = true;
    this.highlights = highlights || [];
    this.markers = [];
    // the director's picks, when the hub worked them out ([{ tick, slot }]); else the game tells them
    this.demo = { cams: Array.isArray(meta.cams) ? meta.cams : [] };
    this.end = Math.max(1, Math.round((meta.seconds || 0) * TICKS));
    this.pos = 0;
    this.ready = false;
    this.wanted = null;         // a jump asked before the game had the demo
    this.pick = -1;             // the director's pick, as last told
    this.reel = null;
    this.shooting = false;
    this.following = 0;
  }

  get length() { return this.end; }
  get time() { return this.wanted ?? this.pos; }
  get clip() { return this.reel ? this.highlights[this.reel.i] : null; }

  seek(tick) {
    tick = Math.max(0, Math.min(this.length, Math.round(tick)));
    if (tick >= this.length) this.playing = false;
    this.pos = tick;
    if (!this.ready) this.wanted = tick;
    else this.hooks.call('soldat_tv_demo_seek', tick);
    this.pick = -1;             // whom the director followed there, told again
    this.applySpeed();
    this.hooks.onTime();
  }

  playReel(i = 0) {
    if (!this.highlights.length) return;
    this.reel = { i: Math.max(0, Math.min(this.highlights.length - 1, i)), part: 0, done: false, shotOff: false };
    this.shooting = false;
    this.following = -1;
    this.playing = true;
    this.seek(this.clip.from);
    this.hooks.onClip(this.clip);
  }

  stopReel() {
    if (!this.reel) return;
    this.reel = null;
    this.shooting = false;
    this.pick = -1;
    this.hooks.onClip(null);
    this.hooks.onTime();
  }

  play() {
    if (this.reel && this.reel.done) { this.playReel(0); return; }
    if (this.time >= this.length) this.seek(0);
    this.playing = true;
    this.applySpeed();
    this.hooks.onTime();
  }

  pause() {
    this.playing = false;
    this.applySpeed();
    this.hooks.onTime();
  }

  setSpeed(x) {
    this.speed = x;
    this.applySpeed();
    this.hooks.onTime();
  }

  applySpeed() {
    if (this.ready) this.hooks.call('soldat_tv_demo_speed', this.playing ? this.speed : 0);
  }

  // each frame: where the game is, and what that brings (the reel's next clip, its camera)
  pump() {
    const at = this.hooks.call('soldat_tv_demo_at');
    if (!(at >= 0)) return;     // no demo yet
    if (!this.ready) {
      this.ready = true;
      this.end = Math.max(1, this.hooks.call('soldat_tv_demo_length') || this.end);
      this.markers = this.hooks.caps().map(([tick, team]) => ({ tick, team, name: '' }));
      const wanted = this.wanted;
      this.wanted = null;
      if (wanted) this.hooks.call('soldat_tv_demo_seek', wanted);
      this.applySpeed();
      this.hooks.onReady();
      return;
    }
    this.pos = at;
    const clip = this.clip;
    if (clip && at >= clip.to && !this.reel.done) {
      if (this.reel.i + 1 < this.highlights.length) {
        this.reel.i++;
        this.reel.part = 0;
        this.reel.shotOff = false;
        this.shooting = false;
        this.following = -1;
        this.seek(this.clip.from);
        this.hooks.onClip(this.clip);
        return;
      }
      // the last one: the reel stops on it
      this.reel.done = true;
      this.playing = false;
      this.applySpeed();
      this.hooks.onEnd();
    }
    if (at >= this.length && this.playing) {
      this.playing = false;
      this.applySpeed();
      this.hooks.onEnd();
    }
    if (this.reel) {
      const part = this.partAt(at);
      if (part !== this.reel.part) { this.reel.part = part; this.hooks.onPart(this.clip.parts[part]); }
      const slot = this.camAt(at);
      if (slot !== this.following) { this.following = slot; this.hooks.onFollow(slot); }
      const shot = this.shotAt(at);
      if (shot || this.shooting) { this.shooting = !!shot; this.hooks.onShot(shot); }
    } else {
      const pick = this.demo.cams.length ? this.camAt(at) : this.hooks.call('soldat_tv_demo_pick');
      if (pick && pick !== this.pick) { this.pick = pick; this.hooks.onFollow(pick); }
    }
  }
}

// the clips' camera, as a 1.7.1 replay's: the play of the clip at a tick, whom it follows,
// a shot from afar between two players, and that shot let go
for (const name of ['partAt', 'camAt', 'shotAt', 'dropShot']) {
  ReloadedReplay.prototype[name] = Replay.prototype[name];
}

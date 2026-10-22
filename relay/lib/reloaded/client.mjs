// The hub's spectator on a Soldat Reloaded server: joins it over ENet as a player, asks to
// watch (/team 5), and hands every message the server sends over as it came (onMessage),
// for the viewers' own Reloaded clients to read. It reads as little as it can itself.
//
// The server sends each snapshot as a delta against the newest one acknowledged, and its
// words (kills, captures, ...) again in every snapshot until they are acknowledged
// (stream.odin). So the hub reads only the snapshots it acknowledges, one in DECODE_EVERY
// ticks, keeps those as the bases the next ones are deltas of, and acknowledges the
// newest word it read in them: no word is missed, since each comes again until then. The
// rest only have their header read. For viewers who come in late the hub asks for a
// whole snapshot now and then (wantWhole): it holds its acknowledgement back until the
// server, its base grown too old, sends one.
//
// It fetches the round's map files when asked (maps.odin), a part at a time.
//
//   const c = new ReloadedClient({ host, port, name, password }, handlers); c.connect()
//
// handlers: onJoined({ slot }), onMessage(data, kind, info), onGone(reason). info is the
// message read (the body), or for a snapshot its header ({ round, tick, base }).
import dgram from 'node:dgram';
import { EnetPeer } from './enet.mjs';
import {
  VERSION, MSG, E, STREAM_RING, STREAM_WHOLE_AFTER, MAX_PLAYERS, SIZES, Bits, build, parse,
  snapshotHeader, snapshotBody, words as readWords, buildClientState, blankSoldier,
} from './wire.mjs';

const CHANNEL_UNRELIABLE = 0, CHANNEL_RELIABLE = 1;
const STATE_EVERY_MS = 1000 / 15;   // client states, 15 a second: enough for its acknowledgements (the server counts 120 as flooding)
const DECODE_EVERY = 6;             // ticks between the snapshots read and acknowledged
const WHOLE_GIVE_UP = STREAM_WHOLE_AFTER * 3; // ticks held back without a whole snapshot coming
const FETCH_AHEAD = 64, FETCH_STEP = 32;  // as the game fetches a map (fetch.odin)
const FETCH_TIMEOUT_MS = 60_000;
const SPECTATOR = 5;                // the server's /team for watching

// the look of a spectator nobody sees
const LOOK = {
  gostek: 0, shirt: [128, 128, 128, 255], pants: [128, 128, 128, 255], skin: [230, 180, 120, 255],
  hair: [0, 0, 0, 255], jet: [255, 255, 0, 255], hair_style: 0, hair_custom: 0, head_style: 0,
  chain_style: 0, eyewear: 0,
};

export class ReloadedClient {
  constructor(cfg, handlers) {
    this.cfg = cfg;               // { host (an IPv4 address), port, name, password }
    this.h = handlers;
    this.state = 'idle';          // connecting, joined, gone
    this.slot = -1;
    this.round = 0;
    this.ring = new Array(STREAM_RING).fill(null); // the snapshots read, by tick
    this.newest = 0;              // the newest snapshot heard (its tick)
    this.read = 0;                // the newest read (and acknowledged, unless held)
    this.held = 0;                // while a whole snapshot is wanted: the tick acknowledged meanwhile
    this.heldSince = 0;
    this.latest = null;           // the newest snapshot read
    this.names = new Array(MAX_PLAYERS).fill('');
    this.players = new Array(MAX_PLAYERS).fill(null); // { active, team } as last read
    this.wordsHeard = 0;          // the newest of the server's words read (its seq)
    this.seq = 0;                 // our client states
    this.fetches = [];            // files being fetched: { round, file, resolve, reject, ... }
    this.stats = { snapshots: 0, read: 0, wholes: 0, dropped: 0, bytes: 0 };
  }

  connect() {
    this.state = 'connecting';
    const sock = this.sock = dgram.createSocket('udp4');
    sock.on('message', (data, rinfo) => {
      if (rinfo.address !== this.cfg.host || rinfo.port !== this.cfg.port) return;
      this.stats.bytes += data.length;
      this.peer.receive(data);
      this.peer.flush();
    });
    sock.on('error', (e) => this.gone('udp: ' + e.message));
    // a connected socket: no address to look up for each datagram sent
    this.peer = new EnetPeer((buf) => { try { sock.send(buf); } catch (_) {} });
    this.peer.onConnect = () => this.hello();
    this.peer.onMessage = (channel, data) => this.message(data);
    this.peer.onDisconnect = (why) => this.gone(why);
    sock.connect(this.cfg.port, this.cfg.host, () => {
      if (this.state !== 'connecting') return;
      this.peer.connect();
      this.timer = setInterval(() => this.tick(), STATE_EVERY_MS);
    });
  }

  close() {
    if (this.state === 'gone') return;
    this.state = 'gone';
    clearInterval(this.timer);
    for (const f of this.fetches) f.reject(new Error('left the server'));
    this.fetches = [];
    if (this.peer) this.peer.disconnect();
    const sock = this.sock;
    // the goodbye goes out before the socket closes
    setTimeout(() => { try { sock.close(); } catch (_) {} }, 50);
  }

  gone(reason) {
    if (this.state === 'gone') return;
    this.close();
    this.h.onGone(reason);
  }

  send(kind, m, reliable = true) {
    const bytes = build(kind, m);
    if (bytes) this.peer.send(reliable ? CHANNEL_RELIABLE : CHANNEL_UNRELIABLE, bytes, reliable);
  }

  hello() {
    this.send('Hello', {
      version: VERSION, name: this.cfg.name, password: this.cfg.password || '', look: LOOK,
      primary: E.Weapon.AK74, secondary: E.Weapon.USSOCOM, hwid: '',
    });
    this.peer.flush();
  }

  // A whole snapshot wanted soon: the acknowledgement held where it is until one comes.
  wantWhole() {
    if (this.held || !this.read) return;
    this.held = this.read;
    this.heldSince = this.newest;
  }

  // ------------------------------------------------------------ from the server

  message(data) {
    const b = Bits.reader(data);
    const kind = MSG[b.kind()];
    if (!b.ok || !kind) return;
    if (kind === 'Snapshot') { this.snapshot(data, b); return; }
    const p = parse(data);
    if (!p) return;
    const m = p.body;
    switch (kind) {
      case 'Welcome':
        this.slot = m.slot;
        this.state = 'joined';
        this.say('/team ' + SPECTATOR);
        this.h.onJoined({ slot: m.slot });
        break;
      case 'Denied':
        this.gone('refused: ' + m.reason);
        return;
      case 'Map':
        // a round begins: its streams from now, its words numbered afresh
        this.round = m.round;
        this.ring.fill(null);
        this.newest = this.read = this.held = 0;
        this.latest = null;
        this.players.fill(null);
        this.wordsHeard = 0;
        for (const f of this.fetches) f.reject(new Error('the round changed'));
        this.fetches = [];
        break;
      case 'Map_Part':
        this.part(m);
        return;           // the hub's own fetch: no viewer's
    }
    this.h.onMessage(data, kind, m);
  }

  snapshot(data, b) {
    const h = snapshotHeader(b);
    if (!b.ok || h.round !== this.round || h.tick <= this.newest) { this.stats.dropped++; return; }
    this.newest = h.tick;
    this.stats.snapshots++;
    this.h.onMessage(data, 'Snapshot', h);
    if (h.base === 0) this.stats.wholes++;
    if (this.held && this.newest - this.heldSince > WHOLE_GIVE_UP) this.held = 0;
    // read when one is due, and every whole one (a base to come); none but whole ones while
    // one is wanted
    if (h.base !== 0 && (this.held || h.tick - this.read < DECODE_EVERY)) return;
    let base = null;
    if (h.base) {
      base = this.ring[h.base % STREAM_RING];
      if (!base || base.tick !== h.base) return;
    }
    const f = snapshotBody(b, base);
    if (!b.ok) return;
    const heard = readWords(b);
    if (!b.done) return;
    f.tick = h.tick;
    this.ring[h.tick % STREAM_RING] = f;
    this.read = h.tick;
    this.latest = f;
    this.stats.read++;
    if (h.base === 0) this.held = 0;
    const { State, Gone } = E.Snap_Word;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (f.names[i]) this.names[i] = f.names[i];
      if (f.word[i] === State) this.players[i] = { active: f.soldiers[i].active, team: f.soldiers[i].team };
      else if (f.word[i] === Gone) this.players[i] = null;
    }
    for (const w of heard) if (w.seq > this.wordsHeard) this.wordsHeard = w.seq;
  }

  // the players as the snapshots read have them, the hub's own spectator aside:
  // [{ slot, name, team }]
  roster() {
    const out = [];
    this.players.forEach((p, i) => {
      if (p && p.active && i !== this.slot) out.push({ slot: i, name: this.names[i], team: p.team });
    });
    return out;
  }

  // the teams' captures as the newest snapshot read has them: alpha, bravo, charlie, delta
  scores() {
    const r = this.latest && this.latest.round;
    return r ? [1, 2, 3, 4].map((t) => r[`captures[${t}]`] || 0) : null;
  }

  // ------------------------------------------------------------ to the server

  // our state, which acknowledges what we read: our own soldier as the server has it
  tick() {
    if (this.state !== 'joined' || !this.round) { this.peer.flush(); return; }
    const own = this.latest && this.latest.soldiers[this.slot];
    const soldier = own || blankSoldier();
    const bytes = buildClientState({
      round: this.round, seq: ++this.seq, ack: this.held || this.read, eventAck: this.wordsHeard,
      life: soldier['vitals.life'] || 0,
    }, soldier);
    if (bytes) this.peer.send(CHANNEL_UNRELIABLE, bytes, false);
    this.pumpFetches();
    this.peer.flush();
  }

  say(text) {
    this.send('Chat', { slot: this.slot, name: this.cfg.name, team: false, taunt: false, kind: 0, text });
  }

  // ------------------------------------------------------------ the map's files

  // The round's file `file` (0 the .pms, i + 1 its art's i-th), fetched from the server:
  // resolves with its bytes.
  fetch(file) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'joined') { reject(new Error('not on the server')); return; }
      this.fetches.push({ round: this.round, file, resolve, reject, data: null, total: 0, next: 0, asked: 0, got: new Set(),
        since: Date.now() });
    });
  }

  // one file at a time, FETCH_AHEAD parts in flight
  pumpFetches() {
    const f = this.fetches[0];
    if (!f) return;
    if (Date.now() - f.since > FETCH_TIMEOUT_MS) {
      this.fetches.shift();
      f.reject(new Error('the map did not come'));
      return;
    }
    const parts = f.total ? Math.ceil(f.total / SIZES.MAP_PART) : 1;
    if (f.asked === 0 || (f.asked < parts && f.asked - f.next <= FETCH_AHEAD - FETCH_STEP)) {
      const count = Math.min(FETCH_AHEAD - (f.asked - f.next), (f.total ? parts : FETCH_AHEAD) - f.asked);
      if (count > 0) {
        this.send('Map_Fetch', { round: f.round, file: f.file, part: f.asked, count });
        f.asked += count;
      }
    }
  }

  part(m) {
    const f = this.fetches[0];
    if (!f || m.round !== f.round || m.file !== f.file) return;
    if (!f.data) { f.total = m.total; f.data = Buffer.alloc(m.total); }
    if (m.total !== f.total) return;
    m.data.copy(f.data, m.part * SIZES.MAP_PART);
    f.got.add(m.part);
    while (f.got.has(f.next)) f.next++;
    const parts = Math.ceil(f.total / SIZES.MAP_PART);
    if (f.asked > parts) f.asked = parts;
    if (f.next >= parts) {
      this.fetches.shift();
      f.resolve(f.data);
    }
  }
}

export { MSG, E };

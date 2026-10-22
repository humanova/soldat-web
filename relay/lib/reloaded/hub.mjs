// The spectator hub for a Soldat Reloaded server (github.com/soldatreloaded/soldatreloaded):
// it joins the server as a spectator over ENet (client.mjs) and hands what the server
// sends, unchanged, to its viewers, whose own Reloaded game (the web build, in its own
// repo) plays it. Viewers, the password, the delay and the list are as the 1.7.1 hub
// (relay/lib/hub.mjs) has them.
//
// A viewer's game joins the hub as it would the server, and the hub answers it as the
// server answers a joining player (players.odin): Welcome, with the hub's own slot (the
// viewer plays the part of the hub's spectator), the weapons, the round's Map and its art,
// the scripts' texts, the round's end and the vote, all as the delayed stream has them;
// then the stream. Nothing a viewer sends goes to the server: its state is read for what
// it has heard, and its map downloads (Map_Fetch) come from the hub's own copies, fetched
// from the server once (files.mjs).
//
// The snapshots are deltas against the hub's acknowledged ones, which viewers have too, as
// they get every one. A viewer's game reads none while its map loads, so it then needs a
// whole one: the hub has the server send one (client.mjs, wantWhole) while a viewer has
// heard nothing of the stream, at most every KEY_AGAIN_MS; with a delay, every
// KEY_DELAYED_MS, since a whole one asked for now comes to viewers only a delay later.
//
// With `record`, each round the viewers see is written into a demo of Reloaded's own
// (record.mjs), with who played and the score: what the hub read of the snapshots, once a
// second, through the delay as the stream goes.
import dns from 'node:dns/promises';
import net from 'node:net';
import { Hub } from '../hub.mjs';
import { E, MSG, TICK_RATE, SIZES, Bits, build, parse } from './wire.mjs';
import { ReloadedClient } from './client.mjs';
import { ReloadedRecording } from './record.mjs';
import { queryServer } from './query.mjs';

const JOIN_TIMEOUT_MS = 20_000;
const SILENCE_MS = 15_000;       // nothing heard for this long: the connection is gone
const QUERY_EVERY_MS = 15_000;
const KEYS_MS = 250;             // how often the viewers' need of a whole snapshot is looked at
const KEY_AGAIN_MS = 1500;
const KEY_DELAYED_MS = 3000;
const KEY_WAIT_MS = 60_000;      // a viewer still without the stream after this has given up
const BEHIND_TICKS = 2 * TICK_RATE; // a viewer this far behind the stream has lost it
const FETCH_WAIT_MS = 60_000;    // a viewer's download of a file the hub is still fetching waits this long
const HELLO_AGAIN_MS = 1000;
const SAMPLE_MS = 1000;          // who plays and the score, for the recording, this often

const hex = (b) => Buffer.from(b).toString('hex');

export class ReloadedHub extends Hub {
  constructor(cfg, opts) {
    super(cfg, opts);
    this.files = opts.reloadedFiles;
    this.client = null;
    this.fetching = new Map();   // hash -> the hub's fetch of it from the server
    this.queried = { at: 0, info: null, pending: null };
  }

  // ------------------------------------------------------------ public

  info() {
    const live = this.state === 'live';
    const playing = live ? this.playing() : null;
    return {
      id: this.cfg.id, name: this.cfg.name, state: this.state, error: this.error,
      map: this.seen.map ? this.seen.map.m.map : '',
      players: live ? playing.length : null,
      names: live ? playing.map((p) => ({ name: p.name, team: p.team })) : null,
      viewers: this.viewers.size, delay: this.delayMs / 1000,
    };
  }

  // who plays, as the hub's newest snapshot read has them: [{ slot, name, team }]
  playing() {
    if (!this.client) return [];
    return this.client.roster().filter((p) => p.team !== E.Team.Spectator);
  }

  addViewer(v) {
    v.welcomed = false;
    v.helloAt = 0;
    v.round = 0;
    v.ack = 0;
    v.since = Date.now();
    super.addViewer(v);
  }

  greet(v) {
    v.greeted = true;
    v.sendText({ type: 'ready', name: this.playerName, server: this.cfg.name, delay: this.delayMs / 1000 });
  }

  // A message from a viewer's game: its join, what it has heard, its map downloads.
  // Nothing goes on to the server.
  fromViewer(v, buf) {
    if (!this.ready || !v.greeted || !buf.length) return;
    const b = Bits.reader(buf);
    const kind = MSG[b.kind()];
    if (!b.ok) return;
    if (kind === 'Hello') {
      const now = Date.now();
      if (v.welcomed || now - v.helloAt < HELLO_AGAIN_MS) return;
      v.helloAt = now;
      this.welcome(v);
      return;
    }
    if (!v.welcomed) return;
    if (kind === 'Client_State') {
      const round = b.u16(), _seq = b.u32(), _base = b.u32(), ack = b.u32();
      if (b.ok) { v.round = round; v.ack = ack; }
    } else if (kind === 'Map_Fetch') {
      const p = parse(buf);
      if (p) this.serveFetch(v, p.body);
    }
  }

  // ------------------------------------------------------------ connection

  async connect() {
    this.closeClient();
    this.clearTimers();
    this.state = 'joining';
    this.error = '';
    this.resetMatch();
    try {
      let ip = this.cfg.host;
      if (net.isIP(ip) === 0) ip = (await dns.lookup(ip, { family: 4 })).address;
      this.ip = ip;
    } catch (e) {
      if (this.state === 'joining') this.fail('cannot resolve ' + this.cfg.host + ': ' + e.message);
      return;
    }
    if (this.state !== 'joining') return;
    // what the client hears, for this connection only; a fault drops it (and joins again)
    // rather than the relay
    const on = (fn) => (...a) => {
      if (c !== this.client) return;
      try {
        fn(...a);
      } catch (e) {
        this.log(e.stack);
        this.fail('internal error: ' + e.message);
      }
    };
    const c = new ReloadedClient({ host: this.ip, port: this.cfg.port, name: this.playerName, password: this.password }, {
      onJoined: on(({ slot }) => { this.slot = slot; }),
      onMessage: on((data, kind, info) => this.heard(c, data, kind, info)),
      onGone: on((why) => this.onGone(why)),
    });
    this.client = c;
    this.lastHeard = Date.now();
    this.setTimer('join', JOIN_TIMEOUT_MS, () => { if (this.state === 'joining') this.fail('the server does not answer'); });
    c.connect();
    this.log(`joining ${this.ip}:${this.cfg.port} (Soldat Reloaded) as "${this.playerName}"`);
  }

  closeClient() {
    const c = this.client;
    this.client = null;
    if (c) c.close();
  }

  disconnect(reason, message) {
    this.closeClient();
    for (const f of this.fetching.values()) f.settle();
    this.fetching.clear();
    super.disconnect(reason, message);
  }

  onGone(why) {
    this.client = null;
    if (/wrong password/i.test(why)) {
      if (this.cfg.askPassword && this.state === 'joining') { this.wrongPassword(); return; }
      this.fail('server refused the spectator: wrong password');
      return;
    }
    this.fail(this.state === 'joining' && /^refused: /.test(why) ? 'server refused the spectator: ' + why.slice(9) : why);
  }

  // the 1.7.1 hub's own messages to its server: there are none
  sendRaw() {}
  sendRequestGame() {}
  sendPlayerInfo() {}
  sendCamera() {}

  goLive() {
    this.state = 'live';
    this.failures = 0;
    this.error = '';
    this.knownPassword = this.password;
    this.clearTimer('join');
    this.setTimer('flush', 20, () => this.flush(), true);
    this.setTimer('keys', KEYS_MS, () => this.keysTick(), true);
    this.log(`live in slot ${this.slot} on ${this.client.mapName}`);
    // with a delay, viewers start once the delayed stream has caught up with the state
    // they get at their join; until then they see the seconds left
    this.readyAt = Date.now() + this.delayMs;
    this.setTimer('ready', this.delayMs, () => {
      this.clearTimer('countdown');
      this.ready = true;
      for (const v of this.viewers) this.greet(v);
    });
    if (this.delayMs > 0) {
      const tell = () => { for (const v of this.viewers) v.sendText({ type: 'status', message: this.countdownText() }); };
      tell();
      this.setTimer('countdown', 1000, tell, true);
    }
  }

  // ------------------------------------------------------------ from the server

  heard(c, data, kind, info) {
    this.lastHeard = Date.now();
    if (kind === 'Welcome') return;           // the hub's own: viewers get theirs from it
    if (kind === 'Map') {
      c.mapName = info.map;
      this.want(c, 0, info.hash);
      if (this.state === 'joining') this.goLive();
    } else if (kind === 'Map_Art') {
      if (info.round === c.round) this.want(c, info.index + 1, info.hash);
    }
    if (this.state !== 'live') return;
    this.stats.in++;
    this.stats.inBytes += data.length;
    const item = { at: Date.now() + this.delayMs, data, kind, info };
    if (this.delayMs > 0) this.queue.push(item);
    else this.deliver(item, item.at);
  }

  // The round's file `file` (0 its .pms, i + 1 its art's i-th), named by `hash`, from the
  // server if the hub has not got it. Viewers who ask for it meanwhile wait for it.
  want(c, file, hashBytes) {
    const hash = hex(hashBytes);
    if (!this.files || this.fetching.has(hash) || this.files.has(hash)) return;
    let settle;
    const done = new Promise((r) => { settle = r; });
    this.fetching.set(hash, { done, settle });
    c.fetch(file).then((bytes) => {
      if (!this.files.put(hash, bytes)) throw new Error('not the file the server named');
    }).catch((e) => this.log(`could not fetch ${file ? 'an art file' : 'the map'} of ${c.mapName}: ${e.message}`))
      .finally(() => {
        settle();
        this.fetching.delete(hash);
      });
  }

  // ------------------------------------------------------------ to viewers

  flushDue(now) {
    while (this.queue.length && this.queue[0].at <= now) {
      const item = this.queue.shift();
      if (item.sample) this.sampled(item.sample);
      else this.deliver(item, item.at - this.delayMs);
    }
  }

  // A message of the stream, as it comes to viewers: what a viewer's join is told is kept
  // as it stands then. at: when the hub heard it.
  deliver(item, at) {
    const { data, kind, info } = item;
    const s = this.seen;
    switch (kind) {
      case 'Snapshot': s.tick = info.tick; break;
      case 'Map':
        s.round = info.round;
        s.map = { m: info, at };
        s.art = [];
        s.texts = new Map();
        s.mapChange = null;
        s.tick = 0;
        break;
      case 'Map_Art': if (info.round === s.round) s.art[info.index] = { m: info, data }; break;
      case 'Weapons': s.weapons = data; break;
      case 'Map_Change': s.mapChange = { m: info, at }; break;
      case 'Vote': s.vote = info.kind === E.Vote_Kind.None ? null : { m: info, at }; break;
      case 'Text': {
        const key = info.place + ':' + info.layer;
        if (info.text || info.clock) s.texts.set(key, { m: info, at }); else s.texts.delete(key);
        break;
      }
    }
    if (this.recordings) {
      if (kind === 'Map') this.recordRound(info, at);
      else if (this.recording) this.recording.add(data, kind, info, at);
      if (this.recording && this.recording.full(at)) {
        this.recording.finish(at);
        this.recording = null;
      }
    }
    for (const v of this.viewers) {
      if (!v.welcomed) continue;
      if (v.buffered >= 1 << 20) { this.stats.dropped++; continue; }  // too slow: dropped like UDP
      v.send(data);
      this.stats.out++;
      this.stats.outBytes += data.length;
    }
  }

  // ------------------------------------------------------------ recording

  // A round begins on the viewers' stream: its demo, from the server's weapons and the Map.
  recordRound(map, at) {
    if (this.recording) this.recording.finish(at);
    const s = this.seen;
    this.recording = this.recordings.start({
      server: this.cfg.id, serverName: this.cfg.name, group: this.cfg.group || null, map: map.map,
      mapHash: hex(map.hash), mode: (this.queried.info && this.queried.info.mode) || 'CTF',
      delay: this.delayMs / 1000, round: map.round, slot: this.slot, name: this.playerName,
    }, at, s.weapons ? [s.weapons] : [], ReloadedRecording);
    this.recording.add(build('Map', map), 'Map', map, at);
  }

  // who played and the score, as the hub read them a delay ago
  sampled(sample) {
    if (this.recording && this.recording.info.round === sample.round) this.recording.roster(sample.playing, sample.scores);
  }

  sample() {
    const c = this.client;
    if (!this.recordings || !c || !c.round) return;
    const sample = { round: c.round, playing: this.playing(), scores: c.scores() };
    if (this.delayMs > 0) this.queue.push({ at: Date.now() + this.delayMs, sample });
    else this.sampled(sample);
  }

  // what was still held back by the delay as the hub leaves: the recording's
  record(item, at) {
    if (!this.recording) return;
    if (item.sample) this.sampled(item.sample);
    else if (item.kind === 'Map') this.recording.finish(at);
    else this.recording.add(item.data, item.kind, item.info, at);
  }

  // A viewer's join answered, as the server answers a player's: the state of the round as
  // the stream stands where the viewer comes in, each clock wound on to now.
  welcome(v) {
    const s = this.seen;
    const now = Date.now() - this.delayMs;
    const ticksSince = (at) => Math.floor(((now - at) * TICK_RATE) / 1000);
    const secondsSince = (at) => Math.floor((now - at) / 1000);
    v.cork();
    try {
      v.send(build('Welcome', { slot: this.slot, tick: s.tick }));
      if (s.weapons) v.send(s.weapons);
      if (s.map) {
        v.send(build('Map', { ...s.map.m, timeLeft: Math.max(0, s.map.m.timeLeft - ticksSince(s.map.at)) }));
        for (const a of s.art) if (a) v.send(a.data);
        for (const { m, at } of s.texts.values()) {
          if (m.seconds > 0) {
            const left = m.seconds - secondsSince(at);
            if (left <= 0) continue;
            v.send(build('Text', { ...m, seconds: left }));
          } else {
            v.send(build('Text', m));
          }
        }
        if (s.mapChange) v.send(build('Map_Change', { ...s.mapChange.m, counter: Math.max(0, s.mapChange.m.counter - ticksSince(s.mapChange.at)) }));
      }
      if (s.vote) {
        const left = s.vote.m.seconds - secondsSince(s.vote.at);
        if (left > 0) v.send(build('Vote', { ...s.vote.m, seconds: left }));
      }
    } finally {
      v.uncork();
    }
    v.welcomed = true;
    v.since = Date.now();
  }

  // A viewer's download of one of its round's files, from the hub's copy: the parts it
  // asks for, once the hub has it.
  async serveFetch(v, m) {
    const s = this.seen;
    if (!this.files || !s.map || m.round !== s.round) return;
    const named = m.file === 0 ? s.map.m.hash : s.art[m.file - 1] && s.art[m.file - 1].m.hash;
    if (!named) return;
    const hash = hex(named);
    const fetching = this.fetching.get(hash);
    if (fetching) {
      let timer;
      await Promise.race([fetching.done, new Promise((r) => { timer = setTimeout(r, FETCH_WAIT_MS); })]);
      clearTimeout(timer);
    }
    const bytes = this.files.get(hash);
    if (!bytes || !this.viewers.has(v) || this.seen.round !== m.round) return;
    const parts = Math.ceil(bytes.length / SIZES.MAP_PART);
    v.cork();
    try {
      for (let part = m.part; part < Math.min(parts, m.part + m.count); part++) {
        const data = bytes.subarray(part * SIZES.MAP_PART, (part + 1) * SIZES.MAP_PART);
        v.send(build('Map_Part', { round: m.round, file: m.file, total: bytes.length, part, data }));
      }
    } finally {
      v.uncork();
    }
  }

  // A viewer's game that has heard nothing of the stream (its map loading, or the stream
  // lost) needs a whole snapshot; with a delay they are asked for all along.
  keysTick() {
    if (Date.now() - this.lastHeard > SILENCE_MS) { this.fail('the server stopped sending'); return; }
    if (Date.now() - this.sampledAt >= SAMPLE_MS) {
      this.sampledAt = Date.now();
      this.sample();
    }
    const c = this.client;
    if (!c || this.state !== 'live' || !this.viewers.size) return;
    const now = Date.now();
    // with a delay, from the start: what is asked for now comes to viewers a delay later
    if (this.delayMs > 0) {
      if (now - this.keyAt >= KEY_DELAYED_MS) { this.keyAt = now; c.wantWhole(); }
      return;
    }
    if (!this.ready || now - this.keyAt < KEY_AGAIN_MS) return;
    const s = this.seen;
    for (const v of this.viewers) {
      if (!v.welcomed || now - v.since > KEY_WAIT_MS) continue;
      const heard = v.round === s.round && v.ack !== 0 && s.tick - v.ack <= BEHIND_TICKS;
      if (heard) { v.since = now; continue; }
      this.keyAt = now;
      c.wantWhole();
      return;
    }
  }

  // the stream since the last call, a line for the log (null: nothing came)
  takeStats() {
    const line = super.takeStats();
    const c = this.client;
    if (!line || !c) return line;
    const s = c.stats;
    c.stats = { snapshots: 0, read: 0, wholes: 0, dropped: 0, bytes: 0 };
    return `${line}; snapshots ${s.snapshots}, read ${s.read}, whole ${s.wholes}`;
  }

  resetMatch() {
    // the round as viewers' joins are told it
    this.seen = { round: 0, tick: 0, weapons: null, map: null, art: [], texts: new Map(), mapChange: null, vote: null };
    this.slot = 0;
    this.keyAt = 0;
    this.sampledAt = 0;
  }

  // ------------------------------------------------------------ for the page

  // what the server says it plays, for the list (null: no answer); asked at most every 15 s
  async query() {
    const q = this.queried;
    if (Date.now() - q.at < QUERY_EVERY_MS) return q.info;
    if (!q.pending) {
      q.pending = (async () => {
        let ip = this.cfg.host;
        if (net.isIP(ip) === 0) ip = (await dns.lookup(ip, { family: 4 })).address;
        return queryServer(ip, this.cfg.port);
      })().catch(() => null).then((info) => {
        q.info = info;
        q.at = Date.now();
        q.pending = null;
        return info;
      });
    }
    return q.pending;
  }
}

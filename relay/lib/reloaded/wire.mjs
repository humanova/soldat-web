// Soldat Reloaded's wire for the relay (github.com/soldatreloaded/soldatreloaded,
// core/network): what web/js/spectate/reloaded-wire.js reads, the page's as well as the
// relay's, and the messages, read and written as message.odin has them, which only the relay
// needs (its bytes are Buffers).
import { MTU, MAX_PLAYERS, SIZES, TABLES, MSG, E, Bits, fields, words } from '../../../web/js/spectate/reloaded-wire.js';

export * from '../../../web/js/spectate/reloaded-wire.js';

// ---------------------------------------------------------------- the messages

const S = SIZES;
const slot = (b, v) => b.range(v, MAX_PLAYERS - 1);
const maybeSlot = (b, v) => {
  const x = b.range(v == null ? 0 : v + 1, MAX_PLAYERS);
  return x === 0 ? null : x - 1;
};

// Each routine reads its message's body into m, or writes m's: m = routine(b, m).
export const MESSAGES = {
  Hello(b, m) {
    m.version = b.u16(m.version);
    m.name = b.string(m.name, S.Name);
    m.password = b.string(m.password, S.Password);
    m.look = fields(b, TABLES.look, m.look || {});
    m.primary = b.enum(m.primary, E.Weapon);
    m.secondary = b.enum(m.secondary, E.Weapon);
    m.hwid = b.string(m.hwid, S.Hwid);
    return m;
  },
  Welcome(b, m) {
    m.slot = slot(b, m.slot);
    m.tick = b.u32(m.tick);
    return m;
  },
  Denied(b, m) {
    m.reason = b.string(m.reason, S.Text);
    return m;
  },
  Chat(b, m) {
    m.slot = maybeSlot(b, m.slot);
    if (m.slot != null) m.name = b.string(m.name, S.Name);
    m.team = b.bool(m.team);
    m.taunt = b.bool(m.taunt);
    m.kind = b.enum(m.kind ?? 0, E.Chat_Kind);
    if (m.kind === E.Chat_Kind.Script) m.color = b.rgba(m.color);
    m.text = b.string(m.text, S.Text);
    return m;
  },
  Map(b, m) {
    m.round = b.u16(m.round);
    m.map = b.string(m.map, S.Map_Name);
    m.hostname = b.string(m.hostname, S.Name);
    m.limit = b.u16(m.limit);
    m.grenades = b.u8(m.grenades);
    m.gunsOff = b.u32(m.gunsOff);
    m.hash = Buffer.from(b.hash(m.hash));
    m.art = b.u8(m.art);
    m.timeLeft = b.u32(m.timeLeft);
    return m;
  },
  Vote(b, m) {
    m.kind = b.enum(m.kind, E.Vote_Kind);
    m.target = b.string(m.target, S.Map_Name);
    m.starter = b.string(m.starter, S.Name);
    m.reason = b.string(m.reason, S.Reason);
    m.seconds = b.u16(m.seconds);
    return m;
  },
  Map_Change(b, m) {
    m.counter = b.u16(m.counter);
    m.map = b.string(m.map, S.Map_Name);
    return m;
  },
  Map_Query(b, m) {
    m.index = b.u16(m.index);
    return m;
  },
  Map_Reply(b, m) {
    m.index = b.u16(m.index);
    m.count = b.u16(m.count);
    m.map = b.string(m.map, S.Map_Name);
    return m;
  },
  Weapons(b, m) {
    m.weapons = fields(b, TABLES.weapons, m.weapons || {});
    return m;
  },
  Map_Fetch(b, m) {
    m.round = b.u16(m.round);
    m.file = b.u8(m.file);
    m.part = b.range(m.part, Math.floor(S.MAP_MAX / S.MAP_PART));
    m.count = b.range(m.count, S.MAP_FETCH_MAX);
    return m;
  },
  Map_Part(b, m) {
    m.round = b.u16(m.round);
    m.file = b.u8(m.file);
    m.total = b.range(m.total, S.MAP_MAX);
    m.part = b.range(m.part, Math.floor(S.MAP_MAX / S.MAP_PART));
    const size = b.range(m.data ? m.data.length : 0, S.MAP_PART);
    if (b.reading) {
      m.data = Buffer.alloc(size);
      for (let i = 0; i < size && b.ok; i++) m.data[i] = b.u8();
    } else {
      for (const c of m.data) b.u8(c);
    }
    return m;
  },
  Map_Art(b, m) {
    m.round = b.u16(m.round);
    m.index = b.u8(m.index);
    m.path = b.string(m.path, S.Map_Art_Path);
    m.size = b.range(m.size, S.MAP_MAX);
    m.hash = Buffer.from(b.hash(m.hash));
    return m;
  },
  Text(b, m) {
    m.place = b.enum(m.place, E.Text_Place);
    m.layer = b.u8(m.layer);
    m.text = b.string(m.text, S.Shown_Text);
    m.pos = b.vec2(m.pos);
    m.color = b.rgba(m.color);
    m.scale = b.f32(m.scale ?? 1);
    m.seconds = b.u16(m.seconds);
    m.clock = b.bool(m.clock);
    if (m.clock) m.clockFrom = b.u32(m.clockFrom);
    return m;
  },
};

// A message's bytes: its kind, then its body; null if it does not fit or a value does not
// fit its width.
export function build(kind, m, size = MTU) {
  const b = Bits.writer(size);
  b.kind(MSG[kind]);
  MESSAGES[kind](b, m);
  return b.ok ? Buffer.from(b.bytes()) : null;
}

// a message's kind and body: { kind: 'Chat', body }, or null for one that cannot be read
// (a stream's message is read by the stream, which needs its bases: { kind, bits })
export function parse(data) {
  const b = Bits.reader(data);
  const kind = MSG[b.kind()];
  if (!b.ok || !kind) return null;
  if (kind === 'Snapshot' || kind === 'Client_State') return { kind, bits: b };
  const routine = MESSAGES[kind];
  if (!routine) return null;
  const body = routine(b, {});
  return b.done ? { kind, body } : null;
}


// A client state: the header, then the owned half and the loadout of `soldier` (whole),
// typing, and no words.
export function buildClientState(h, soldier) {
  const b = Bits.writer();
  b.kind(MSG.Client_State);
  b.u16(h.round);
  b.u32(h.seq);
  b.u32(0);                  // base: whole
  b.u32(h.ack);
  b.u32(h.eventAck);
  b.u8(h.life);
  fields(b, TABLES.soldier_owned, soldier);
  fields(b, TABLES.soldier_loadout, soldier);
  b.bool(false);             // typing
  words(b, []);
  return b.ok ? Buffer.from(b.bytes()) : null;
}

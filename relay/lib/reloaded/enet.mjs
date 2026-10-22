// A client end of ENet 1.3 (enet.bespin.org), the transport Soldat Reloaded's messages ride:
// one peer, over a UDP socket of the caller's. What a spectator needs of it and no more:
// the handshake, acknowledgements both ways, reliable packets resent until acknowledged and
// delivered in order (fragments put together), unreliable ones as they come, and the goodbye.
// No checksum and no compression, as Reloaded's hosts use none. Multi-byte fields are big-endian.
import crypto from 'node:crypto';

const CMD = {
  ACKNOWLEDGE: 1, CONNECT: 2, VERIFY_CONNECT: 3, DISCONNECT: 4, PING: 5, SEND_RELIABLE: 6,
  SEND_UNRELIABLE: 7, SEND_FRAGMENT: 8, SEND_UNSEQUENCED: 9, BANDWIDTH_LIMIT: 10,
  THROTTLE_CONFIGURE: 11, SEND_UNRELIABLE_FRAGMENT: 12,
};
const FLAG_ACKNOWLEDGE = 0x80, FLAG_UNSEQUENCED = 0x40;
const HEADER_SENT_TIME = 0x8000, HEADER_COMPRESSED = 0x4000, SESSION_SHIFT = 12, PEER_ID_MASK = 0x0FFF;
const MAX_PEER_ID = 0xFFF;
// command sizes, header included
const SIZE = [0, 8, 48, 44, 8, 4, 6, 8, 24, 8, 12, 16, 24];
const MTU = 1392;
const WINDOW = 65536;
const THROTTLE = [5000, 2, 2];        // interval, acceleration, deceleration: ENet's defaults
const RESEND_MIN_MS = 200;
const GIVE_UP_MS = 30_000;            // a reliable packet unacknowledged this long: the line is gone
const CONNECT_TIMEOUT_MS = 10_000;

const seqAfter = (a, b) => ((a - b) & 0xFFFF) !== 0 && ((a - b) & 0xFFFF) < 0x8000;  // a later than b

export class EnetPeer {
  // send(buf): one datagram to the server; channels: how many to ask for
  constructor(send, { channels = 2 } = {}) {
    this.sendDatagram = send;
    this.channelCount = channels;
    this.state = 'idle';           // connecting, connected, gone
    this.connectId = crypto.randomBytes(4).readUInt32BE(0);
    this.outPeerId = MAX_PEER_ID;  // the server's number for us, once it says
    this.outSession = 0;
    this.inSession = 0;
    this.reliableSeq = 0;          // channel 0xFF's (connect, disconnect)
    this.channels = Array.from({ length: channels }, () => ({
      outReliable: 0, outUnreliable: 0, inNext: 1, pending: new Map(), fragments: new Map(),
    }));
    this.unacked = new Map();      // `${channel}:${seq}` -> { cmd, sentAt, firstAt }
    this.acks = [];                // [channel, seq, sentTime] to acknowledge in the next datagram
    this.rtt = 500;
    this.rttVar = 0;
    this.started = Date.now();
    this.lastHeard = Date.now();
    // set by the caller
    this.onConnect = () => {};
    this.onMessage = (_channel, _data) => {};
    this.onDisconnect = (_why) => {};
  }

  now16() { return (Date.now() - this.started) & 0xFFFF; }

  connect() {
    this.state = 'connecting';
    this.connectAt = Date.now();
    const c = Buffer.alloc(SIZE[CMD.CONNECT]);
    c[0] = CMD.CONNECT | FLAG_ACKNOWLEDGE;
    c[1] = 0xFF;
    c.writeUInt16BE(++this.reliableSeq, 2);
    c.writeUInt16BE(0, 4);         // our number for the server's peer: we have one
    c[6] = 0xFF;                   // session ids: the server picks
    c[7] = 0xFF;
    c.writeUInt32BE(MTU, 8);
    c.writeUInt32BE(WINDOW, 12);
    c.writeUInt32BE(this.channelCount, 16);
    c.writeUInt32BE(0, 20);        // bandwidth: unlimited both ways
    c.writeUInt32BE(0, 24);
    c.writeUInt32BE(THROTTLE[0], 28);
    c.writeUInt32BE(THROTTLE[1], 32);
    c.writeUInt32BE(THROTTLE[2], 36);
    c.writeUInt32BE(this.connectId, 40);
    c.writeUInt32BE(0, 44);
    this.queueReliable(0xFF, this.reliableSeq, c);
    this.flush();
  }

  // a message on a channel: reliable (resent until acknowledged, in order) or not
  send(channel, data, reliable) {
    if (this.state !== 'connected') return false;
    const ch = this.channels[channel];
    // after 65535 unreliable ones a channel's next goes reliably, as ENet's own does
    if (reliable || ch.outUnreliable >= 0xFFFF) {
      ch.outUnreliable = 0;
      const seq = ch.outReliable = (ch.outReliable + 1) & 0xFFFF;
      const c = Buffer.alloc(SIZE[CMD.SEND_RELIABLE] + data.length);
      c[0] = CMD.SEND_RELIABLE | FLAG_ACKNOWLEDGE;
      c[1] = channel;
      c.writeUInt16BE(seq, 2);
      c.writeUInt16BE(data.length, 4);
      data.copy(c, 6);
      this.queueReliable(channel, seq, c);
    } else {
      ch.outUnreliable++;
      const c = Buffer.alloc(SIZE[CMD.SEND_UNRELIABLE] + data.length);
      c[0] = CMD.SEND_UNRELIABLE;
      c[1] = channel;
      c.writeUInt16BE(ch.outReliable, 2);
      c.writeUInt16BE(ch.outUnreliable, 4);
      c.writeUInt16BE(data.length, 6);
      data.copy(c, 8);
      this.out = this.out || [];
      this.out.push(c);
    }
    return true;
  }

  // goodbye, at once: not waited on
  disconnect(data = 0) {
    if (this.state === 'connected' || this.state === 'connecting') {
      const c = Buffer.alloc(SIZE[CMD.DISCONNECT]);
      c[0] = CMD.DISCONNECT | FLAG_UNSEQUENCED;
      c[1] = 0xFF;
      c.writeUInt16BE(++this.reliableSeq, 2);
      c.writeUInt32BE(data, 4);
      this.out = [c];
      this.unacked.clear();
      this.flush();
    }
    this.state = 'gone';
  }

  queueReliable(channel, seq, cmd) {
    this.unacked.set(`${channel}:${seq}`, { cmd, sentAt: 0, firstAt: Date.now() });
  }

  // Sends what waits: acknowledgements, reliable packets due (again), unreliable ones.
  // Call it often (each tick); it is also how resends and the give-up are timed.
  flush() {
    if (this.state === 'gone' && !this.out) return;
    const now = Date.now();
    if (this.state === 'connecting' && now - this.connectAt > CONNECT_TIMEOUT_MS) { this.close('the server does not answer'); return; }
    const cmds = [];
    for (const [channel, seq, sentTime] of this.acks) {
      const a = Buffer.alloc(SIZE[CMD.ACKNOWLEDGE]);
      a[0] = CMD.ACKNOWLEDGE;
      a[1] = channel;
      a.writeUInt16BE(seq, 2);
      a.writeUInt16BE(seq, 4);
      a.writeUInt16BE(sentTime, 6);
      cmds.push(a);
    }
    this.acks = [];
    const resend = Math.max(RESEND_MIN_MS, this.rtt + 4 * this.rttVar);
    for (const r of this.unacked.values()) {
      if (now - r.firstAt > GIVE_UP_MS) { this.close('the server stopped acknowledging'); return; }
      if (r.sentAt && now - r.sentAt < resend) continue;
      r.sentAt = now;
      cmds.push(r.cmd);
    }
    if (this.out) { cmds.push(...this.out); this.out = null; }
    if (!cmds.length) return;
    // as many commands to a datagram as fit the MTU
    let batch = [], size = 4;
    const send = () => {
      if (!batch.length) return;
      const h = Buffer.alloc(4);
      const session = this.outPeerId < MAX_PEER_ID ? this.outSession << SESSION_SHIFT : 0;
      h.writeUInt16BE(this.outPeerId | session | HEADER_SENT_TIME, 0);
      h.writeUInt16BE(this.now16(), 2);
      this.sendDatagram(Buffer.concat([h, ...batch]));
      batch = [];
      size = 4;
    };
    for (const c of cmds) {
      if (size + c.length > MTU) send();
      batch.push(c);
      size += c.length;
    }
    send();
  }

  close(why) {
    if (this.state === 'gone') return;
    this.state = 'gone';
    this.unacked.clear();
    this.onDisconnect(why);
  }

  // one datagram from the server
  receive(buf) {
    if (this.state === 'gone' || buf.length < 2) return;
    const word = buf.readUInt16BE(0);
    if (word & HEADER_COMPRESSED) return;   // never asked for
    const peerId = word & PEER_ID_MASK;
    const session = (word >> SESSION_SHIFT) & 3;
    const timed = (word & HEADER_SENT_TIME) !== 0;
    if (timed && buf.length < 4) return;
    const sentTime = timed ? buf.readUInt16BE(2) : 0;
    if (peerId !== 0 && peerId !== MAX_PEER_ID) return;  // we are the server's peer 0... of ours
    if (this.state === 'connected' && session !== this.inSession) return;
    this.lastHeard = Date.now();
    let p = timed ? 4 : 2;
    while (p + 4 <= buf.length && this.state !== 'gone') {
      const command = buf[p] & 0x0F;
      const flags = buf[p];
      const channel = buf[p + 1];
      const seq = buf.readUInt16BE(p + 2);
      const size = SIZE[command] || 0;
      if (!size || p + size > buf.length) return;
      const cmd = buf.subarray(p, p + size);
      p += size;
      let data = null;
      if (command === CMD.SEND_RELIABLE || command === CMD.SEND_UNRELIABLE || command === CMD.SEND_UNSEQUENCED ||
          command === CMD.SEND_FRAGMENT || command === CMD.SEND_UNRELIABLE_FRAGMENT) {
        const len = cmd.readUInt16BE(command === CMD.SEND_RELIABLE ? 4 : 6);
        if (p + len > buf.length) return;
        data = buf.subarray(p, p + len);
        p += len;
      }
      if ((flags & FLAG_ACKNOWLEDGE) && timed) this.acks.push([channel, seq, sentTime]);
      this.command(command, channel, seq, cmd, data);
    }
  }

  command(command, channel, seq, cmd, data) {
    switch (command) {
      case CMD.ACKNOWLEDGE: {
        const acked = cmd.readUInt16BE(4);
        const sent = cmd.readUInt16BE(6);
        if (this.unacked.delete(`${channel}:${acked}`)) {
          const sample = (this.now16() - sent) & 0xFFFF;
          if (sample < 10_000) {
            this.rttVar = this.rttVar * 0.75 + Math.abs(sample - this.rtt) * 0.25;
            this.rtt = this.rtt * 0.875 + sample * 0.125;
          }
        }
        break;
      }
      case CMD.VERIFY_CONNECT: {
        if (this.state !== 'connecting' || cmd.readUInt32BE(40) !== this.connectId) break;
        this.unacked.delete(`255:1`);
        this.outPeerId = cmd.readUInt16BE(4);
        this.inSession = cmd[6];
        this.outSession = cmd[7];
        this.channelCount = Math.min(this.channelCount, cmd.readUInt32BE(16));
        this.state = 'connected';
        this.onConnect();
        break;
      }
      case CMD.DISCONNECT:
        this.flush();   // its acknowledgement
        this.close('the server closed the connection');
        break;
      case CMD.PING: case CMD.BANDWIDTH_LIMIT: case CMD.THROTTLE_CONFIGURE:
        break;
      case CMD.SEND_UNRELIABLE: case CMD.SEND_UNSEQUENCED:
        if (this.state === 'connected' && channel < this.channels.length) this.onMessage(channel, Buffer.from(data));
        break;
      case CMD.SEND_RELIABLE:
        if (this.state === 'connected' && channel < this.channels.length) this.reliable(channel, seq, { data: Buffer.from(data) });
        break;
      case CMD.SEND_FRAGMENT: {
        if (this.state !== 'connected' || channel >= this.channels.length) break;
        const start = cmd.readUInt16BE(4);
        const count = cmd.readUInt32BE(8), number = cmd.readUInt32BE(12);
        const total = cmd.readUInt32BE(16), offset = cmd.readUInt32BE(20);
        if (!count || number >= count || offset + data.length > total || total > 1 << 24) break;
        const ch = this.channels[channel];
        let f = ch.fragments.get(start);
        if (!f) { f = { buf: Buffer.alloc(total), count, got: new Set() }; ch.fragments.set(start, f); }
        if (f.buf.length !== total || f.count !== count) break;
        data.copy(f.buf, offset);
        f.got.add(number);
        // the fragments take seq start .. start + count - 1; the packet goes in at start
        this.reliable(channel, seq, number === 0 ? { fragment: start } : { part: true });
        break;
      }
      case CMD.SEND_UNRELIABLE_FRAGMENT:
        break;   // never sent to us: no unreliable message passes the MTU
    }
  }

  // a reliable command of `channel`: delivered once and in order
  reliable(channel, seq, item) {
    const ch = this.channels[channel];
    if (seq !== ch.inNext && !seqAfter(seq, ch.inNext)) return;   // had it
    ch.pending.set(seq, item);
    for (;;) {
      const next = ch.pending.get(ch.inNext);
      if (!next) break;
      if (next.part) { ch.pending.delete(ch.inNext); ch.inNext = (ch.inNext + 1) & 0xFFFF; continue; }
      if (next.fragment !== undefined) {
        const f = ch.fragments.get(next.fragment);
        if (!f || f.got.size < f.count) break;
        ch.fragments.delete(next.fragment);
        ch.pending.delete(ch.inNext);
        ch.inNext = (ch.inNext + 1) & 0xFFFF;
        this.onMessage(channel, f.buf);
        continue;
      }
      ch.pending.delete(ch.inNext);
      ch.inNext = (ch.inNext + 1) & 0xFFFF;
      this.onMessage(channel, next.data);
    }
  }
}

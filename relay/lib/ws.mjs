// Minimal WebSocket server side (RFC 6455): no extensions, binary and text frames.
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// the largest message, also when it comes in pieces (continuation frames)
const MAX_MESSAGE = 1 << 20;

export class WsConn {
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.frag = null;
    this.fragOp = 0;
    this.fragLen = 0;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    // a client gone without a close frame: the HTTP server keeps half-open sockets
    socket.on('end', () => this.finish());
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (this.buf.length) setImmediate(() => this.parse());
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    if (this.onclose) this.onclose();
  }

  parse() {
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2);
        if (hi !== 0) { this.close(1009); return; }
        len = b.readUInt32BE(6); off = 10;
      }
      if (!masked) { this.close(1002); return; }
      if (len > MAX_MESSAGE) { this.close(1009); return; }
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x0) {
        if (!this.frag) { this.close(1002); return; }
        this.frag.push(payload);
        this.fragLen += payload.length;
        if (this.fragLen > MAX_MESSAGE) { this.close(1009); return; }
        if (fin) {
          const data = Buffer.concat(this.frag);
          const fop = this.fragOp;
          this.frag = null;
          this.deliver(fop, data);
        }
        continue;
      }
      if (op !== 0x1 && op !== 0x2) { this.close(1003); return; }
      if (!fin) { this.frag = [payload]; this.fragOp = op; this.fragLen = payload.length; continue; }
      this.deliver(op, payload);
    }
  }

  deliver(op, data) {
    if (!this.onmessage) return;
    // a message the handler chokes on ends this connection, never the whole server
    try {
      this.onmessage(op === 0x1 ? data.toString('utf8') : data, op === 0x2);
    } catch (e) {
      console.error(new Date().toISOString(), 'websocket message failed:', e && e.stack || e);
      this.close(1011);
    }
  }

  sendFrame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    this.socket.write(Buffer.concat([header, payload]));
  }

  sendText(obj) { this.sendFrame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  sendBinary(buf) { this.sendFrame(0x2, buf); }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    try { this.sendFrame(0x8, p); } catch (_) {}
    this.socket.end();
    setTimeout(() => this.finish(), 1000);
  }

  get buffered() { return this.socket.writableLength; }
}

export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsConn(socket, head);
}

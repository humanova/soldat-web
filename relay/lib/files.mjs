// Map downloads: the game server's TCP file server (game port + 10) streamed to a WebSocket.
import net from 'node:net';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FILE_RE = /^(maps\/[^/\\]+\.pms|textures\/[^\\]+\.(png|jpg|jpeg|bmp|gif)|scenery-gfx\/[^/\\]+\.(png|jpg|jpeg|bmp|gif))$/i;

// Sends the file server's answer for `files` to ws, then {type: 'end'} (or an error) and
// closes it. Returns a cleanup function. Throws on a bad file list.
export function proxyFiles(ws, ip, filePort, files) {
  files = Array.isArray(files) ? files.filter(f => typeof f === 'string' && FILE_RE.test(f) && !f.includes('..')) : [];
  if (!files.length || files.length > 256) throw new Error('bad file list');
  const tcp = net.connect({ host: ip, port: filePort });
  let total = 0;
  const timer = setTimeout(() => tcp.destroy(new Error('timeout')), 90_000);
  tcp.on('connect', () => {
    tcp.write('STARTFILES\r\n' + files.join('\r\n') + '\r\nENDFILES\r\n');
  });
  tcp.on('data', (d) => {
    total += d.length;
    if (total > MAX_FILE_BYTES) { tcp.destroy(); return; }
    ws.sendBinary(d);
    if (ws.buffered > 8 << 20) tcp.pause();
  });
  const resume = setInterval(() => { if (tcp.isPaused() && ws.buffered < 1 << 20) tcp.resume(); }, 50);
  const end = (err) => {
    clearTimeout(timer);
    clearInterval(resume);
    if (err) ws.sendText({ type: 'error', message: 'file server: ' + err.message });
    else ws.sendText({ type: 'end' });
    ws.close(1000);
  };
  tcp.on('end', () => end());
  tcp.on('error', (e) => end(e));
  return () => { clearTimeout(timer); clearInterval(resume); tcp.destroy(); };
}

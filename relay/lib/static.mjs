// Static files of the web client (web/), gzip compressed on the fly and cached in memory.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.smod': 'application/zip', '.zip': 'application/zip', '.ttf': 'font/ttf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pms': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.ico': 'image/x-icon',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.wasm', '.smod', '.ttf', '.bmp', '.pms', '.txt', '.svg', '.xml', '.ico']);
const gzCache = new Map();

// opts.index: file served for "/" (default index.html); opts.hidden: paths that are not served
export function serveStatic(ROOT, req, res, opts = {}) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { res.writeHead(400).end(); return; }
  if (urlPath === '/') urlPath += opts.index || 'index.html';
  else if (urlPath.endsWith('/')) urlPath += 'index.html';
  if (opts.hidden && opts.hidden.has(urlPath)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
  const file = path.resolve(ROOT, '.' + urlPath);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // revalidate code and data (ETag); on-demand map graphics never change
      'Cache-Control': urlPath.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    };
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
    const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && COMPRESSIBLE.has(ext) && st.size > 1024;
    if (gzipOk) {
      const key = file + etag;
      const send = (buf) => {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = buf.length;
        headers.Vary = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : buf);
      };
      if (gzCache.has(key)) { send(gzCache.get(key)); return; }
      fs.readFile(file, (e2, data) => {
        if (e2) { res.writeHead(500).end(); return; }
        zlib.gzip(data, { level: 6 }, (e3, gz) => {
          if (e3) { res.writeHead(500).end(); return; }
          if (gz.length < 256 * 1024 * 1024) gzCache.set(key, gz);
          send(gz);
        });
      });
      return;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

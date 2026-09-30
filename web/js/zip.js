// Minimal zip reader. Stored entries are sliced directly; deflated entries are
// inflated asynchronously up front (PhysFS reads must be synchronous).

export async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  const pending = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip central directory');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const rawName = bytes.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800) ? dec.decode(rawName) : latin1(rawName);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const lnlen = dv.getUint16(lho + 26, true);
    const lxlen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lxlen;
    const raw = bytes.subarray(start, start + csize);
    const entry = { name, data: null };
    entries.set(name.toLowerCase(), entry);
    if (method === 0) entry.data = raw;
    else if (method === 8) pending.push(inflateRaw(raw, usize).then(d => { entry.data = d; }));
    else console.warn('zip: unsupported compression for', name);
  }
  await Promise.all(pending);
  return entries;
}

function latin1(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

async function inflateRaw(data, size) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return size && buf.length !== size ? buf.subarray(0, size) : buf;
}

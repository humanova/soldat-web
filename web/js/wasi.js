// WASI preview1 subset used by the Free Pascal RTL, backed by the in-memory VFS.
// A single preopened directory "/" makes every absolute path resolvable.
import { VDir, VFile, splitPath } from './vfs.js';

const E = {
  SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44,
  NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, SPIPE: 70, NOTCAPABLE: 76,
};
const FT = { UNKNOWN: 0, CHAR: 2, DIR: 3, FILE: 4 };
const O_CREAT = 1, O_DIRECTORY = 2, O_EXCL = 4, O_TRUNC = 8;
const FD_APPEND = 1;

export class WasiExit extends Error {
  constructor(code) { super('exit ' + code); this.code = code; }
}

export function createWasi(rt, vfs, { args = ['soldat'], onStdout = null } = {}) {
  const fds = new Map();
  fds.set(0, { kind: 'stdin' });
  fds.set(1, { kind: 'stdout', buf: '' });
  fds.set(2, { kind: 'stdout', buf: '', err: true });
  fds.set(3, { kind: 'dir', node: vfs.root, path: '', preopen: '/' });
  let nextFd = 4;
  const utf8 = new TextDecoder();
  const enc = new TextEncoder();

  function str(ptr, len) {
    return utf8.decode(rt.u8().subarray(ptr, ptr + len));
  }

  function resolve(dirfd, path) {
    const d = fds.get(dirfd);
    if (!d || d.kind !== 'dir') return null;
    const base = d.path;
    const joined = splitPath((base ? base + '/' : '') + path).join('/');
    return joined;
  }

  function writeFilestat(ptr, node) {
    const dv = rt.dv();
    dv.setBigUint64(ptr, 0n, true);
    dv.setBigUint64(ptr + 8, 0n, true);
    dv.setUint8(ptr + 16, node.type === 'dir' ? FT.DIR : FT.FILE);
    dv.setBigUint64(ptr + 24, 1n, true);
    dv.setBigUint64(ptr + 32, BigInt(node.type === 'dir' ? 0 : node.size), true);
    const t = BigInt(Math.floor(node.mtime || Date.now())) * 1000000n;
    dv.setBigUint64(ptr + 40, t, true);
    dv.setBigUint64(ptr + 48, t, true);
    dv.setBigUint64(ptr + 56, t, true);
  }

  function flushOut(f, final) {
    let idx;
    while ((idx = f.buf.indexOf('\n')) >= 0) {
      const line = f.buf.slice(0, idx);
      f.buf = f.buf.slice(idx + 1);
      if (onStdout) onStdout(line, !!f.err); else (f.err ? console.error : console.log)(line);
    }
    if (final && f.buf) {
      if (onStdout) onStdout(f.buf, !!f.err); else console.log(f.buf);
      f.buf = '';
    }
  }

  const wasi = {
    args_sizes_get(argcPtr, sizePtr) {
      const dv = rt.dv();
      dv.setUint32(argcPtr, args.length, true);
      dv.setUint32(sizePtr, args.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
      return E.SUCCESS;
    },
    args_get(argvPtr, bufPtr) {
      const dv = rt.dv();
      let p = bufPtr;
      args.forEach((a, i) => {
        dv.setUint32(argvPtr + i * 4, p, true);
        const b = enc.encode(a);
        rt.u8().set(b, p);
        rt.u8()[p + b.length] = 0;
        p += b.length + 1;
      });
      return E.SUCCESS;
    },
    environ_sizes_get(countPtr, sizePtr) {
      rt.dv().setUint32(countPtr, 0, true);
      rt.dv().setUint32(sizePtr, 0, true);
      return E.SUCCESS;
    },
    environ_get() { return E.SUCCESS; },
    clock_time_get(id, precision, timePtr) {
      const ns = id === 0
        ? BigInt(Date.now()) * 1000000n
        : BigInt(Math.round(performance.now() * 1000)) * 1000n;
      rt.dv().setBigUint64(timePtr, ns, true);
      return E.SUCCESS;
    },
    random_get(ptr, len) {
      const u8 = rt.u8();
      for (let off = 0; off < len; off += 65536) {
        crypto.getRandomValues(u8.subarray(ptr + off, ptr + Math.min(len, off + 65536)));
      }
      return E.SUCCESS;
    },
    poll_oneoff(inPtr, outPtr, nsubs, neventsPtr) {
      // Only clock subscriptions (Sleep) are expected; report them as elapsed.
      const dv = rt.dv();
      for (let i = 0; i < nsubs; i++) {
        const s = inPtr + i * 48;
        const o = outPtr + i * 32;
        dv.setBigUint64(o, dv.getBigUint64(s, true), true);
        dv.setUint16(o + 8, 0, true);
        dv.setUint8(o + 10, dv.getUint8(s + 8));
        dv.setBigUint64(o + 16, 0n, true);
        dv.setUint16(o + 24, 0, true);
      }
      dv.setUint32(neventsPtr, nsubs, true);
      return E.SUCCESS;
    },
    proc_exit(code) {
      const err = new WasiExit(code);
      console.error('[soldat] exit code', code, err.stack);
      throw err;
    },
    fd_prestat_get(fd, ptr) {
      const f = fds.get(fd);
      if (!f || !f.preopen) return E.BADF;
      const dv = rt.dv();
      dv.setUint8(ptr, 0);
      dv.setUint32(ptr + 4, enc.encode(f.preopen).length, true);
      return E.SUCCESS;
    },
    fd_prestat_dir_name(fd, ptr, len) {
      const f = fds.get(fd);
      if (!f || !f.preopen) return E.BADF;
      rt.u8().set(enc.encode(f.preopen).subarray(0, len), ptr);
      return E.SUCCESS;
    },
    fd_fdstat_get(fd, ptr) {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      const dv = rt.dv();
      const type = f.kind === 'dir' ? FT.DIR : f.kind === 'file' ? FT.FILE : FT.CHAR;
      dv.setUint8(ptr, type);
      dv.setUint16(ptr + 2, f.append ? FD_APPEND : 0, true);
      dv.setBigUint64(ptr + 8, 0xFFFFFFFFFFFFFFFFn, true);
      dv.setBigUint64(ptr + 16, 0xFFFFFFFFFFFFFFFFn, true);
      return E.SUCCESS;
    },
    fd_filestat_get(fd, ptr) {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind === 'file' || f.kind === 'dir') writeFilestat(ptr, f.node);
      else {
        rt.u8().fill(0, ptr, ptr + 64);
        rt.dv().setUint8(ptr + 16, FT.CHAR);
      }
      return E.SUCCESS;
    },
    fd_filestat_set_size(fd, size) {
      const f = fds.get(fd);
      if (!f || f.kind !== 'file') return E.BADF;
      f.node.truncate(Number(size));
      f.dirty = true;
      return E.SUCCESS;
    },
    fd_filestat_set_times() { return E.SUCCESS; },
    path_filestat_set_times() { return E.SUCCESS; },
    fd_close(fd) {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind === 'stdout') { flushOut(f, true); return E.SUCCESS; }
      if (fd <= 3) return E.SUCCESS;
      if (f.kind === 'file' && f.dirty) vfs.markDirty(f.path);
      fds.delete(fd);
      return E.SUCCESS;
    },
    fd_read(fd, iovs, iovsLen, nreadPtr) {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      const dv = rt.dv();
      let total = 0;
      if (f.kind === 'file') {
        const data = f.node.data;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          const n = Math.max(0, Math.min(len, f.node.size - f.pos));
          rt.u8().set(data.subarray(f.pos, f.pos + n), ptr);
          f.pos += n;
          total += n;
          if (n < len) break;
        }
      } else if (f.kind === 'dir') {
        return E.ISDIR;
      }
      dv.setUint32(nreadPtr, total, true);
      return E.SUCCESS;
    },
    fd_write(fd, iovs, iovsLen, nwrittenPtr) {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      const dv = rt.dv();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = dv.getUint32(iovs + i * 8, true);
        const len = dv.getUint32(iovs + i * 8 + 4, true);
        const chunk = rt.u8().subarray(ptr, ptr + len);
        if (f.kind === 'stdout') {
          const text = utf8.decode(chunk, { stream: true });
          if (text.includes('no string conversion')) console.error('[soldat] conversion failure at', new Error().stack);
          f.buf += text;
        } else if (f.kind === 'file') {
          if (f.append) f.pos = f.node.size;
          f.node.write(f.pos, chunk);
          f.pos += len;
          f.dirty = true;
        } else return E.BADF;
        total += len;
      }
      if (f.kind === 'stdout') flushOut(f, false);
      rt.dv().setUint32(nwrittenPtr, total, true);
      return E.SUCCESS;
    },
    fd_seek(fd, offset, whence, newOffsetPtr) {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== 'file') return E.SPIPE;
      let pos = Number(offset);
      if (whence === 1) pos += f.pos;
      else if (whence === 2) pos += f.node.size;
      if (pos < 0) return E.INVAL;
      f.pos = pos;
      rt.dv().setBigUint64(newOffsetPtr, BigInt(pos), true);
      return E.SUCCESS;
    },
    fd_tell(fd, ptr) {
      const f = fds.get(fd);
      if (!f || f.kind !== 'file') return E.BADF;
      rt.dv().setBigUint64(ptr, BigInt(f.pos), true);
      return E.SUCCESS;
    },
    fd_readdir(fd, buf, bufLen, cookie, bufUsedPtr) {
      const f = fds.get(fd);
      if (!f || f.kind !== 'dir') return E.BADF;
      const names = [...f.node.children.keys()];
      const dv = rt.dv();
      const u8 = rt.u8();
      let used = 0;
      for (let i = Number(cookie); i < names.length; i++) {
        const nameBytes = enc.encode(names[i]);
        const child = f.node.children.get(names[i]);
        const ent = new Uint8Array(24 + nameBytes.length);
        const edv = new DataView(ent.buffer);
        edv.setBigUint64(0, BigInt(i + 1), true);
        edv.setBigUint64(8, BigInt(i + 1), true);
        edv.setUint32(16, nameBytes.length, true);
        edv.setUint8(20, child.type === 'dir' ? FT.DIR : FT.FILE);
        ent.set(nameBytes, 24);
        const n = Math.min(ent.length, bufLen - used);
        u8.set(ent.subarray(0, n), buf + used);
        used += n;
        if (used >= bufLen) break;
      }
      dv.setUint32(bufUsedPtr, used, true);
      return E.SUCCESS;
    },
    path_open(dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInh, fdflags, fdPtr) {
      const path = resolve(dirfd, str(pathPtr, pathLen));
      if (path === null) return E.BADF;
      let node = vfs.lookup(path);
      if (node && (oflags & O_EXCL) && (oflags & O_CREAT)) return E.EXIST;
      if (!node) {
        if (!(oflags & O_CREAT)) return E.NOENT;
        const [dir, name] = vfs.parentOf(path);
        if (!dir) return E.NOENT;
        node = new VFile();
        dir.children.set(name, node);
        vfs.markDirty(path);
      }
      if ((oflags & O_DIRECTORY) && node.type !== 'dir') return E.NOTDIR;
      const fd = nextFd++;
      if (node.type === 'dir') {
        fds.set(fd, { kind: 'dir', node, path });
      } else {
        const entry = { kind: 'file', node, path, pos: 0, append: !!(fdflags & FD_APPEND), dirty: false };
        if (oflags & O_TRUNC) { node.truncate(0); entry.dirty = true; }
        fds.set(fd, entry);
      }
      rt.dv().setUint32(fdPtr, fd, true);
      return E.SUCCESS;
    },
    path_filestat_get(dirfd, flags, pathPtr, pathLen, bufPtr) {
      const path = resolve(dirfd, str(pathPtr, pathLen));
      if (path === null) return E.BADF;
      const node = vfs.lookup(path);
      if (!node) return E.NOENT;
      writeFilestat(bufPtr, node);
      return E.SUCCESS;
    },
    path_create_directory(dirfd, pathPtr, pathLen) {
      const path = resolve(dirfd, str(pathPtr, pathLen));
      if (path === null) return E.BADF;
      if (vfs.lookup(path)) return E.EXIST;
      const [dir, name] = vfs.parentOf(path);
      if (!dir) return E.NOENT;
      dir.children.set(name, new VDir());
      vfs.markDirty(path);
      return E.SUCCESS;
    },
    path_remove_directory(dirfd, pathPtr, pathLen) {
      const path = resolve(dirfd, str(pathPtr, pathLen));
      const node = path === null ? null : vfs.lookup(path);
      if (!node) return E.NOENT;
      if (node.type !== 'dir') return E.NOTDIR;
      if (node.children.size) return E.NOTEMPTY;
      const [dir, name] = vfs.parentOf(path);
      dir.children.delete(name);
      vfs.forget(path, node);
      return E.SUCCESS;
    },
    path_unlink_file(dirfd, pathPtr, pathLen) {
      const path = resolve(dirfd, str(pathPtr, pathLen));
      const node = path === null ? null : vfs.lookup(path);
      if (!node) return E.NOENT;
      if (node.type === 'dir') return E.ISDIR;
      const [dir, name] = vfs.parentOf(path);
      dir.children.delete(name);
      vfs.forget(path, node);
      return E.SUCCESS;
    },
    path_rename(fd1, p1, l1, fd2, p2, l2) {
      const from = resolve(fd1, str(p1, l1));
      const to = resolve(fd2, str(p2, l2));
      const node = from === null ? null : vfs.lookup(from);
      if (!node) return E.NOENT;
      const [d1, n1] = vfs.parentOf(from);
      const [d2, n2] = vfs.parentOf(to);
      if (!d2) return E.NOENT;
      d1.children.delete(n1);
      d2.children.set(n2, node);
      vfs.forget(from, node);
      vfs.markDirtyTree(to, node);
      return E.SUCCESS;
    },
    path_readlink() { return E.INVAL; },
  };
  return wasi;
}

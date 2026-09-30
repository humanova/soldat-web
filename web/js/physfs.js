// PhysFS API (subset) over zip archives and VFS directories, case-insensitive like
// the Windows file system the game data was made for.
import { splitPath } from './vfs.js';

export function createPhysFS(rt, vfs, archives) {
  let mounts = [];            // search path, highest priority first
  const handles = new Map();
  let nextHandle = 1;
  const lists = new Map();    // enumerateFiles result -> allocated pointers
  let lastErrorPtr = 0;

  function norm(path) {
    return splitPath(path).join('/');
  }

  function stripMount(m, path) {
    if (!m.point) return path;
    const lp = path.toLowerCase();
    if (lp === m.point) return '';
    if (lp.startsWith(m.point + '/')) return path.slice(m.point.length + 1);
    return null;
  }

  function findFile(path) {
    path = norm(path);
    for (const m of mounts) {
      const rel = stripMount(m, path);
      if (rel === null || rel === '') continue;
      if (m.zip) {
        const e = m.zip.get(rel.toLowerCase());
        if (e && e.data) return e.data;
      } else {
        const n = vfs.lookup(rel, { caseInsensitive: true, from: m.dir });
        if (n && n.type === 'file') return n.bytes();
      }
    }
    return null;
  }

  function isDir(path) {
    path = norm(path);
    const lp = path.toLowerCase();
    for (const m of mounts) {
      if (m.point && (m.point === lp || m.point.startsWith(lp + '/'))) return true;
      const rel = stripMount(m, path);
      if (rel === null) continue;
      if (m.zip) {
        const prefix = rel ? rel.toLowerCase() + '/' : '';
        for (const k of m.zip.keys()) if (k.startsWith(prefix)) return true;
      } else {
        const n = vfs.lookup(rel, { caseInsensitive: true, from: m.dir });
        if (n && n.type === 'dir') return true;
      }
    }
    return false;
  }

  function listDir(path) {
    path = norm(path);
    const seen = new Map();
    const add = (name) => { const k = name.toLowerCase(); if (!seen.has(k)) seen.set(k, name); };
    for (const m of mounts) {
      const rel = stripMount(m, path);
      if (rel === null) {
        // a mount point below this directory shows up as a subdirectory
        const lp = path.toLowerCase();
        if (m.point && (lp === '' || m.point.startsWith(lp + '/'))) {
          const rest = m.point.slice(lp ? lp.length + 1 : 0);
          add(rest.split('/')[0]);
        }
        continue;
      }
      if (m.zip) {
        const prefix = rel ? rel.toLowerCase() + '/' : '';
        for (const [k, e] of m.zip) {
          if (!k.startsWith(prefix)) continue;
          const restOrig = e.name.slice(prefix.length);
          add(restOrig.split('/')[0]);
        }
      } else {
        const n = vfs.lookup(rel, { caseInsensitive: true, from: m.dir });
        if (n && n.type === 'dir') for (const name of n.children.keys()) add(name);
      }
    }
    return [...seen.values()];
  }

  const api = {
    PHYSFS_init() { return 1; },
    PHYSFS_deinit() { mounts = []; return 1; },
    PHYSFS_mount(newDirPtr, mountPointPtr, append) {
      const source = rt.cstr(newDirPtr);
      const point = mountPointPtr ? norm(rt.cstr(mountPointPtr)).toLowerCase() : '';
      const key = norm(source);
      let m = null;
      if (archives.has(key)) m = { source: key, point, zip: archives.get(key) };
      else {
        const node = vfs.lookup(key);
        if (!node || node.type !== 'dir') {
          console.warn('[physfs] cannot mount', source);
          return 0;
        }
        m = { source: key, point, dir: node };
      }
      mounts = mounts.filter(x => x.source !== key);
      if (append) mounts.push(m); else mounts.unshift(m);
      return 1;
    },
    PHYSFS_removeFromSearchPath(dirPtr) {
      const key = norm(rt.cstr(dirPtr));
      const before = mounts.length;
      mounts = mounts.filter(x => x.source !== key);
      return mounts.length !== before ? 1 : 0;
    },
    PHYSFS_exists(namePtr) {
      const name = rt.cstr(namePtr);
      return findFile(name) || isDir(name) ? 1 : 0;
    },
    PHYSFS_openRead(namePtr) {
      const data = findFile(rt.cstr(namePtr));
      if (!data) return 0;
      const h = nextHandle++;
      handles.set(h, { data, pos: 0 });
      return h;
    },
    PHYSFS_read(h, buf, objSize, objCount) {
      const f = handles.get(h);
      if (!f) return -1n;
      if (objSize <= 0) return 0n;
      const want = objSize * objCount;
      const n = Math.max(0, Math.min(want, f.data.length - f.pos));
      const whole = Math.floor(n / objSize) * objSize;
      rt.u8().set(f.data.subarray(f.pos, f.pos + whole), buf);
      f.pos += whole;
      return BigInt(whole / objSize);
    },
    PHYSFS_eof(h) {
      const f = handles.get(h);
      return !f || f.pos >= f.data.length ? 1 : 0;
    },
    PHYSFS_fileLength(h) {
      const f = handles.get(h);
      return f ? BigInt(f.data.length) : -1n;
    },
    PHYSFS_close(h) {
      return handles.delete(h) ? 1n : 0n;
    },
    PHYSFS_getLastError() {
      if (!lastErrorPtr) lastErrorPtr = rt.allocCString('');
      return lastErrorPtr;
    },
    PHYSFS_enumerateFiles(dirPtr) {
      const names = listDir(rt.cstr(dirPtr));
      const arr = rt.alloc((names.length + 1) * 4);
      const ptrs = [arr];
      names.forEach((n, i) => {
        const p = rt.allocCString(n);
        ptrs.push(p);
        rt.dv().setUint32(arr + i * 4, p, true);
      });
      rt.dv().setUint32(arr + names.length * 4, 0, true);
      lists.set(arr, ptrs);
      return arr;
    },
    PHYSFS_freeList(ptr) {
      const ptrs = lists.get(ptr);
      if (!ptrs) return;
      lists.delete(ptr);
      for (const p of ptrs) rt.free(p);
    },
  };

  // JavaScript-side helpers (used by the launcher and the download code)
  api.fileExists = (path) => !!findFile(path);
  api.readFile = (path) => findFile(path);
  return api;
}

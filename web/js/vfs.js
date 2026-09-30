// In-memory file system shared by the WASI layer (Pascal file I/O) and PhysFS.
// Everything below /user is persisted in IndexedDB (settings, downloaded maps).

export class VDir {
  constructor() {
    this.type = 'dir';
    this.children = new Map();
    this.mtime = Date.now();
  }
}

export class VFile {
  constructor(data) {
    this.type = 'file';
    this.data = data || new Uint8Array(0);
    this.size = this.data.length;
    this.mtime = Date.now();
  }
  bytes() {
    return this.data.subarray(0, this.size);
  }
  ensure(capacity) {
    if (capacity <= this.data.length) return;
    let n = Math.max(capacity, this.data.length * 2, 256);
    const d = new Uint8Array(n);
    d.set(this.data.subarray(0, this.size));
    this.data = d;
  }
  truncate(size) {
    if (size > this.size) {
      this.ensure(size);
      this.data.fill(0, this.size, size);
    }
    this.size = size;
    this.mtime = Date.now();
  }
  write(pos, src) {
    this.ensure(pos + src.length);
    if (pos > this.size) this.data.fill(0, this.size, pos);
    this.data.set(src, pos);
    if (pos + src.length > this.size) this.size = pos + src.length;
    this.mtime = Date.now();
  }
}

export function splitPath(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out;
}

const PERSIST_ROOT = 'user';
const NO_PERSIST = ['user/logs'];
const DB_NAME = 'soldat-web';
const STORE = 'files';

export class VFS {
  constructor() {
    this.root = new VDir();
    this.dirty = new Set();
    this.db = null;
    this.syncTimer = 0;
  }

  lookup(path, { caseInsensitive = false, from = null } = {}) {
    let node = from || this.root;
    for (const part of splitPath(path)) {
      if (node.type !== 'dir') return null;
      let next = node.children.get(part);
      if (!next && caseInsensitive) {
        const lower = part.toLowerCase();
        for (const [name, child] of node.children) {
          if (name.toLowerCase() === lower) { next = child; break; }
        }
      }
      if (!next) return null;
      node = next;
    }
    return node;
  }

  // returns [parentDir, name] (parent created when mkdirs is set)
  parentOf(path, mkdirs = false) {
    const parts = splitPath(path);
    if (parts.length === 0) return [null, ''];
    const name = parts.pop();
    let node = this.root;
    for (const part of parts) {
      let next = node.children.get(part);
      if (!next) {
        if (!mkdirs) return [null, name];
        next = new VDir();
        node.children.set(part, next);
      }
      if (next.type !== 'dir') return [null, name];
      node = next;
    }
    return [node, name];
  }

  mkdirp(path) {
    let node = this.root;
    const parts = splitPath(path);
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      let next = node.children.get(part);
      if (!next) {
        next = new VDir();
        node.children.set(part, next);
        this.markDirty(cur);
      }
      node = next;
    }
    return node;
  }

  writeFile(path, data) {
    const [dir, name] = this.parentOf(path, true);
    const f = new VFile(data instanceof Uint8Array ? data : new Uint8Array(data));
    dir.children.set(name, f);
    this.markDirty(splitPath(path).join('/'));
    return f;
  }

  readFile(path) {
    const n = this.lookup(path);
    return n && n.type === 'file' ? n.bytes() : null;
  }

  // ---- persistence ----

  persistent(path) {
    const p = splitPath(path).join('/');
    if (!(p === PERSIST_ROOT || p.startsWith(PERSIST_ROOT + '/'))) return false;
    return !NO_PERSIST.some(x => p === x || p.startsWith(x + '/'));
  }

  markDirty(path) {
    const p = splitPath(path).join('/');
    if (!this.persistent(p)) return;
    this.dirty.add(p);
    if (this.db && !this.syncTimer) this.syncTimer = setTimeout(() => this.sync(), 500);
  }

  async openDB() {
    if (!('indexedDB' in globalThis)) return;
    this.db = await new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }

  async load() {
    await this.openDB();
    if (!this.db) return;
    const entries = await new Promise((resolve) => {
      const out = [];
      const tx = this.db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out);
      };
      req.onerror = () => resolve(out);
    });
    entries.sort((a, b) => a[0].length - b[0].length);
    for (const [path, value] of entries) {
      if (value.dir) this.mkdirp(path);
      else {
        const [dir, name] = this.parentOf(path, true);
        const f = new VFile(new Uint8Array(value.data));
        f.mtime = value.mtime || Date.now();
        dir.children.set(name, f);
      }
    }
    this.dirty.clear();
  }

  async sync() {
    this.syncTimer = 0;
    if (!this.db || this.dirty.size === 0) return;
    const paths = [...this.dirty];
    this.dirty.clear();
    await new Promise((resolve) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const p of paths) {
        const node = this.lookup(p);
        if (!node) store.delete(p);
        else if (node.type === 'dir') store.put({ dir: true }, p);
        else store.put({ data: node.bytes().slice(), mtime: node.mtime }, p);
      }
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  }

  markDirtyTree(path, node) {
    const p = splitPath(path).join('/');
    this.markDirty(p);
    if (node && node.type === 'dir') {
      for (const [name, child] of node.children) this.markDirtyTree(p + '/' + name, child);
    }
  }

  // removes a node from the store together with everything below it
  forget(path, node) {
    const p = splitPath(path).join('/');
    if (!this.persistent(p)) return;
    this.dirty.add(p);
    if (node && node.type === 'dir') {
      for (const [name, child] of node.children) this.forget(p + '/' + name, child);
    }
    if (this.db && !this.syncTimer) this.syncTimer = setTimeout(() => this.sync(), 500);
  }

  // empties a directory and removes its contents from the store; the directory node
  // itself stays, because PhysFS mounts refer to it
  async clearPersistent(prefix) {
    const base = splitPath(prefix).join('/');
    const node = this.lookup(base);
    if (!node || node.type !== 'dir') return;
    for (const [name, child] of [...node.children]) {
      node.children.delete(name);
      this.forget(base + '/' + name, child);
    }
    await this.sync();
  }
}

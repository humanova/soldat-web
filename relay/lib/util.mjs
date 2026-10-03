// Helpers shared by the relays.

export function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

export function makeArg(args) {
  return function arg(name, def) {
    const i = args.indexOf('--' + name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
  };
}

// Browsers send an Origin header with WebSocket requests. By default only pages served by
// the relay itself may use it (other sites cannot borrow it); `allowed` adds origins.
export function originChecker(allowed) {
  return function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser
    if (allowed.has('*') || allowed.has(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch (_) {
      return false;
    }
  };
}

export function clientIpOf(trustProxy) {
  return function clientIp(req) {
    if (trustProxy && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
    return req.socket.remoteAddress || '?';
  };
}

// null for a request target that is no valid path (such as "//"): new URL throws on it,
// which would stop the whole server
export function requestUrl(req) {
  try { return new URL(req.url, 'http://x'); } catch (_) { return null; }
}

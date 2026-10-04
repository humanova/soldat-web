// Discord sign-in for the play relay. A player signs in once; every game they join through
// the relay then carries the same hardware id, made from their Discord account, so servers
// can ban that id instead of the relay's address, which all players share.
// Nothing is stored: the signed cookie is the session, and Discord's token is dropped
// right after reading the account id.
import crypto from 'node:crypto';
import { makeHwid } from './soldat171.mjs';

const COOKIE = 'soldat_session';
const STATE_COOKIE = 'soldat_login';
const SESSION_DAYS = 30;
const DISCORD_EPOCH = 1420070400000;  // Discord ids hold their creation time since this

export function makeAuth({ clientId, clientSecret, secret, publicUrl, minAgeDays, discordUrl, log }) {
  const redirectUri = publicUrl.replace(/\/$/, '') + '/auth/callback';
  const secure = publicUrl.startsWith('https:') ? '; Secure' : '';
  const api = discordUrl + '/api/v10';

  const mac = (text) => crypto.createHmac('sha256', secret).update(text).digest();

  function setCookie(res, name, value, maxAge, path = '/') {
    const list = [].concat(res.getHeader('Set-Cookie') || []);
    list.push(`${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
    res.setHeader('Set-Cookie', list);
  }

  function cookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }

  function sign(data) {
    const body = Buffer.from(JSON.stringify(data)).toString('base64url');
    return body + '.' + mac('session:' + body).toString('base64url');
  }

  function user(req) {
    const [body, sig] = cookie(req, COOKIE).split('.');
    if (!body || !sig) return null;
    const want = mac('session:' + body);
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    try {
      const u = JSON.parse(Buffer.from(body, 'base64url').toString());
      return u.exp > Date.now() ? u : null;
    } catch (_) { return null; }
  }

  // the same id for an account on every server; without the secret it cannot be worked
  // out from the (public) Discord id. Changing AUTH_SECRET changes everyone's id.
  const hwid = (id) => makeHwid(mac('hwid:' + id).toString('hex'));

  // only paths of this site, so the login cannot send anyone elsewhere
  const localPath = (p) => (typeof p === 'string' && p.length < 300 && /^\/(?![/\\])[^\s\\]*$/.test(p) ? p : '/');

  function back(res, path, result) {
    const u = new URL(path, 'http://x');
    if (result) u.searchParams.set('login', result);
    res.writeHead(302, { Location: u.pathname + u.search, 'Cache-Control': 'no-store' }).end();
  }

  async function discord(path, init) {
    const r = await fetch(api + path, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`discord ${path}: ${r.status}`);
    return r.json();
  }

  async function callback(req, res, url) {
    const [state, ret] = cookie(req, STATE_COOKIE).split('.');
    setCookie(res, STATE_COOKIE, '', 0, '/auth');
    const to = localPath(ret ? Buffer.from(ret, 'base64url').toString() : '/');
    const got = url.searchParams.get('state') || '';
    if (!state || got.length !== state.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(state))) {
      back(res, to, 'failed');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) { back(res, to, url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed'); return; }
    try {
      const token = await discord('/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        }),
      });
      const me = await discord('/users/@me', { headers: { Authorization: 'Bearer ' + token.access_token } });
      if (!/^\d{1,20}$/.test(me.id)) throw new Error('discord: no account id');
      const created = Number(BigInt(me.id) >> 22n) + DISCORD_EPOCH;
      if (Date.now() - created < minAgeDays * 86_400_000) {
        log(`login refused, account too new: discord=${me.id}`);
        back(res, to, 'new');
        return;
      }
      const name = String(me.global_name || me.username || '').slice(0, 32);
      setCookie(res, COOKIE, sign({ id: me.id, name, exp: Date.now() + SESSION_DAYS * 86_400_000 }), SESSION_DAYS * 86_400);
      log(`login discord=${me.id} (${name}) hwid=${hwid(me.id)}`);
      back(res, to);
    } catch (e) {
      log('login failed:', e.message);
      back(res, to, 'failed');
    }
  }

  // GET /auth/login?return=/path, GET /auth/callback (from Discord), GET /auth/me, POST /auth/logout
  function handle(req, res, url) {
    if (url.pathname === '/auth/login') {
      const state = crypto.randomBytes(16).toString('base64url');
      const ret = Buffer.from(localPath(url.searchParams.get('return'))).toString('base64url');
      setCookie(res, STATE_COOKIE, state + '.' + ret, 600, '/auth');
      const q = new URLSearchParams({
        client_id: clientId, response_type: 'code', scope: 'identify', redirect_uri: redirectUri, state, prompt: 'none',
      });
      res.writeHead(302, { Location: `${discordUrl}/oauth2/authorize?${q}`, 'Cache-Control': 'no-store' }).end();
    } else if (url.pathname === '/auth/callback') {
      callback(req, res, url);
    } else if (url.pathname === '/auth/me') {
      const u = user(req);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ required: true, name: u ? u.name : null, hwid: u ? hwid(u.id) : null }));
    } else if (url.pathname === '/auth/logout' && req.method === 'POST') {
      setCookie(res, COOKIE, '', 0);
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  }

  return { handle, user, hwid };
}

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.js';
import { loadRoom, createRoom, roomsFor, refreshAccount, validRoomId, saveAll } from './rooms.js';
import { PROVIDERS, KEYED, modelsFor, keyFormatProblem, checkKey } from './providers.js';
import { saveKey, removeKey, keySummary, keysFor } from './keys.js';
import {
  COOKIE, createAccount, checkPassword, startSession, endSession,
  userFromCookie, readCookie, publicUser, readAvatar,
  updateProfile, changePassword, contactLists, requestContact, acceptContact, disconnect,
} from './accounts.js';

loadDotEnv();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  setSecurityHeaders(req, res, p);
  // Cross-site request forgery: only this site's own pages may change things.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return json(res, { error: 'Request blocked: it came from another website.' }, 403);
  }
  const me = userFromCookie(req.headers.cookie);
  try {
    // ---- accounts ----
    if (p === '/signup' || p === '/signin') {
      if (me) return redirect(res, safeNext(url.searchParams.get('next')));
      return sendFile(res, path.join(ROOT, `${p.slice(1)}.html`));
    }
    if (p === '/api/signup' && req.method === 'POST') {
      if (!allow(signups, req.socket.remoteAddress, 10, 60 * 60e3)) {
        return json(res, { error: 'Too many new accounts from this network. Try again in an hour.' }, 429);
      }
      const body = await readBody(req);
      const result = await createAccount(body);
      if (result.error) return json(res, { field: result.field, error: result.error }, 400);
      signIn(req, res, result.user);
      return json(res, { user: publicUser(result.user) });
    }
    if (p === '/api/signin' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      if (tooManyFailures(ip)) return json(res, { error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
      const body = await readBody(req);
      const user = await checkPassword(body.username, body.password);
      if (!user) { recordFailure(ip); return json(res, { error: 'Wrong username or password.' }, 401); }
      failures.delete(ip);
      signIn(req, res, user);
      return json(res, { user: publicUser(user) });
    }
    if (p === '/api/signout' && req.method === 'POST') {
      endSession(readCookie(req.headers.cookie, COOKIE));
      res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return json(res, { ok: true });
    }
    if (p === '/api/me') return json(res, { user: me && { ...publicUser(me), requests: me.incoming?.length || 0 } });

    // Everything below needs a signed-in person.
    const pages = ['/account', '/new', '/keys'];
    if (!me && (pages.includes(p) || p.startsWith('/r/'))) return redirect(res, `/signin?next=${encodeURIComponent(p)}`);
    if (!me && p.startsWith('/api/') && !['/api/config', '/api/rooms/'].some((x) => p.startsWith(x))) {
      return json(res, { error: 'Sign in first.' }, 401);
    }

    // ---- account page ----
    if (p === '/account') return sendFile(res, path.join(ROOT, 'account.html'));
    if (p === '/api/account') return json(res, { user: publicUser(me), ...contactLists(me) });
    if (p === '/api/account/profile' && req.method === 'POST') {
      const result = updateProfile(me, await readBody(req));
      if (result.error) return json(res, result, 400);
      refreshAccount(publicUser(me));
      return json(res, { user: publicUser(me) });
    }
    if (p === '/api/account/password' && req.method === 'POST') {
      const body = await readBody(req, 4096);
      const result = await changePassword(me, body, readCookie(req.headers.cookie, COOKIE));
      return json(res, result, result.error ? 400 : 200);
    }

    // ---- contacts ----
    if (p.startsWith('/api/contacts/') && req.method === 'POST') {
      const body = await readBody(req, 4096);
      const action = p.slice('/api/contacts/'.length);
      const result =
        action === 'request' ? requestContact(me, body.username) :
        action === 'accept' ? acceptContact(me, String(body.userId)) :
        action === 'remove' ? disconnect(me, String(body.userId)) : { error: 'Unknown action.' };
      return json(res, { ...result, ...contactLists(me) }, result.error ? 400 : 200);
    }
    if (p.startsWith('/api/avatar/')) {
      const img = readAvatar(p.slice('/api/avatar/'.length));
      if (!img) return notFound(res);
      res.writeHead(200, { 'content-type': img.type, 'cache-control': 'private, max-age=31536000', 'x-content-type-options': 'nosniff' });
      return res.end(img.bytes);
    }

    // ---- rooms ----
    if (p === '/new') return redirect(res, `/r/${createRoom(me.id).id}`);
    if (p.startsWith('/r/')) {
      if (!validRoomId(p.slice(3))) return redirect(res, '/');
      return sendFile(res, path.join(ROOT, 'room.html'));
    }
    if (p === '/api/my-rooms') return json(res, { rooms: roomsFor(me.id) });
    // The models this person's own keys unlock (plus the free demo).
    if (p === '/api/models') return json(res, { models: await modelsFor(keysFor(me.id)) });

    // ---- API keys ----
    if (p === '/keys') return sendFile(res, path.join(ROOT, 'keys.html'));
    if (p === '/api/keys') return json(res, keyPageData(req, me));
    const keyApi = /^\/api\/keys\/([a-z]+)(\/remove)?$/.exec(p);
    if (keyApi && req.method === 'POST') {
      const provider = keyApi[1];
      if (!KEYED.includes(provider)) return json(res, { error: 'Unknown provider.' }, 404);
      if (keyApi[2]) {
        removeKey(me.id, provider);
        return json(res, keyPageData(req, me));
      }
      if (!secureEnoughForKeys(req)) {
        return json(res, { error: 'For your safety, keys can only be added over https:// or on the computer running PromptCollab. On a plain http:// network address anyone on the same Wi-Fi could read the key as it travels.' }, 403);
      }
      if (!allow(keyChecks, me.id, 10, 10 * 60e3)) {
        return json(res, { error: 'Too many key checks. Wait a few minutes and try again.' }, 429);
      }
      const { key } = await readBody(req, 4096);
      const clean = String(key || '').trim();
      const problem = keyFormatProblem(provider, clean);
      if (problem) return json(res, { error: problem }, 400);
      try {
        await checkKey(provider, clean);
      } catch (e) {
        return json(res, { error: e.message }, 400);
      }
      saveKey(me.id, provider, clean);
      return json(res, { ...keyPageData(req, me), message: `${PROVIDERS[provider].label} key saved. It works.` });
    }
    // /api/rooms/<code>: can I enter? /api/rooms/<code>/request: ask the host.
    const roomApi = /^\/api\/rooms\/([^/]+)(\/request)?$/.exec(p);
    if (roomApi) {
      const room = loadRoom(roomApi[1]);
      if (!me) return json(res, { exists: !!room, access: 'signin' });
      if (!room) return json(res, { exists: false });
      if (roomApi[2] && req.method === 'POST') room.requestAccess(me.id);
      return json(res, {
        exists: true,
        access: room.canEnter(me.id),
        hostName: room.roomInfo().hostName,
        requested: room.requests.includes(me.id),
      });
    }
    if (p === '/api/config') return json(res, { accessCodeRequired: !!ACCESS_CODE, lanUrls: lanUrls() });
    if (p === '/healthz') return json(res, { ok: true });

    const file = path.normalize(path.join(ROOT, p === '/' ? 'index.html' : p));
    if (!file.startsWith(ROOT + path.sep)) return notFound(res);
    return sendFile(res, file);
  } catch (e) {
    if (e.message === 'Request too large') return json(res, { error: 'That upload is too large.' }, 413);
    console.error(e);
    res.writeHead(500).end('Server error');
  }
});

attachWebSocket(server, '/ws', (socket, req, url) => {
  const roomId = url.searchParams.get('room') || '';
  if (!validRoomId(roomId)) return socket.destroy();
  // Only pages from this site may connect, and only for a signed-in person.
  if (!sameOrigin(req)) return socket.destroy();
  const account = userFromCookie(req.headers.cookie);
  if (!account) {
    socket.send({ type: 'signin' });
    return setTimeout(() => socket.destroy(), 1000); // give the message time to arrive
  }
  let room = null;
  socket.on('message', (msg) => {
    if (!room) {
      if (msg.type !== 'hello') return;
      if (ACCESS_CODE && msg.code !== ACCESS_CODE) {
        socket.send({ type: 'auth', ok: false });
        return;
      }
      const target = loadRoom(roomId);
      const verdict = target ? target.canEnter(account.id) : 'missing';
      if (verdict !== 'ok') {
        socket.send({ type: 'denied', reason: verdict, hostName: target?.roomInfo().hostName });
        return setTimeout(() => socket.destroy(), 1000);
      }
      room = target;
      room.join(socket, publicUser(account));
      return;
    }
    room.handle(socket, msg).catch((e) => console.error('[room]', e));
  });
  socket.on('close', () => room && room.leave(socket));
});

server.listen(PORT, () => {
  console.log(`PromptCollab running at http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`  On your network:   ${url}`);
  console.log('Everyone adds their own API keys on the API keys page (/keys).');
  const oldKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'].filter((k) => process.env[k]);
  if (oldKeys.length) console.warn(`Note: ${oldKeys.join(', ')} in .env are no longer used. You can delete them from .env.`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveAll(); process.exit(0); });
}

// ---- helpers ----

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}
// Addresses other devices on the same Wi-Fi/network can use to reach this server,
// best guess first. Virtual adapters (WSL, Docker, VMs, VPNs) usually can't be
// reached by other devices, so they go last.
const VIRTUAL = /vethernet|wsl|hyper-v|docker|veth|br-|virbr|vbox|virtualbox|vmware|vmnet|utun|tun|tap|tailscale|zerotier|bridge/i;
function lanUrls() {
  const score = ({ name, address }) =>
    (VIRTUAL.test(name) ? 10 : 0) +
    (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3);
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) => addrs.map((a) => ({ ...a, name })))
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .sort((a, b) => score(a) - score(b))
    .map((a) => `http://${a.address}:${PORT}`);
}
function json(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
}

// Read a JSON request body (up to `limit` bytes; profile pictures make sign-up the largest).
function readBody(req, limit = 400 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// Give the browser a session cookie. HttpOnly keeps page scripts from reading it.
function signIn(req, res, user) {
  const { token, maxAge } = startSession(user);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

// ---- security ----

// Headers that make the browser stricter about what this site's pages can do.
function setSecurityHeaders(req, res, p) {
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // inline style="" sets avatar colors
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'", // no one can show this site inside their page (clickjacking)
  ].join('; '));
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  if (isHttps(req)) res.setHeader('strict-transport-security', 'max-age=31536000');
  // Never let a browser or proxy store private data.
  if (p.startsWith('/api/') && !p.startsWith('/api/avatar/')) res.setHeader('cache-control', 'no-store');
}

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;

// True if the request came from one of this site's own pages (or has no Origin,
// like a direct visit). Never throws: Origin can be junk such as "null".
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// Keys may only be typed in over https, or on the computer running the server
// (localhost never touches the network). ALLOW_INSECURE_KEYS=1 opts out on a trusted home network.
function secureEnoughForKeys(req) {
  if (isHttps(req) || process.env.ALLOW_INSECURE_KEYS === '1') return true;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

// Everything the API keys page shows. Never includes a full key.
function keyPageData(req, me) {
  const saved = keySummary(me.id);
  return {
    secure: secureEnoughForKeys(req),
    // OpenRouter first: one key covers the most models, so it's the easiest start.
    providers: [...KEYED].sort((a, b) => (b === 'openrouter') - (a === 'openrouter')).map((name) => {
      const p = PROVIDERS[name];
      return { name, label: p.label, keyHint: p.keyHint, keyUrl: p.keyUrl, limitsUrl: p.limitsUrl, saved: saved[name] || null };
    }),
  };
}

// Simple fixed-window rate limits, keyed by IP or account.
const signups = new Map();
const keyChecks = new Map();
function allow(map, id, max, windowMs) {
  const now = Date.now();
  const entry = map.get(id);
  if (!entry || now - entry.since > windowMs) { map.set(id, { count: 1, since: now }); return true; }
  return ++entry.count <= max;
}

// Only follow `next` to a page on this site (so a link can't bounce people elsewhere).
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

// Slow down password guessing: 10 wrong tries from one address locks it out for 15 minutes.
const failures = new Map(); // ip -> { count, since }
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.since > 15 * 60e3) failures.delete(ip);
  return (failures.get(ip)?.count || 0) >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, since: Date.now() };
  f.count++;
  failures.set(ip, f);
}
function redirect(res, to) { res.writeHead(302, { location: to }).end(); }
function notFound(res) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); }

// Tiny .env loader so keys can live in a file without any dependency.
function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env file */ }
}

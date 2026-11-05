import './env.js'; // must stay first: loads .env before the files below read their settings
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.js';
import { loadRoom, createRoom, roomsFor, refreshAccount, validRoomId, saveAll, exportRooms, removeAccountFromRooms } from './rooms.js';
import { PROVIDERS, KEYED, modelsFor, keyFormatProblem, checkKey } from './providers.js';
import { saveKey, removeKey, removeAllKeys, keySummary, keysFor } from './keys.js';
import { houseEnabled, houseStatus, checkHouseKey } from './house.js';
import {
  COOKIE, createAccount, checkPassword, startSession, endSession,
  userFromCookie, readCookie, publicUser, readAvatar,
  updateProfile, changePassword, contactLists, requestContact, acceptContact, disconnect,
  verifyPassword, newRecoveryCodes, recoveryCodesLeft, resetWithCode, exportAccount, deleteAccountRecord,
} from './accounts.js';


const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  setSecurityHeaders(req, res, p);
  // Cross-site request forgery: only this site's own pages may change things.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return json(res, { error: 'Request blocked: it came from another website.' }, 403);
  }
  try {
    // ---- access code (optional): the whole site is private until it's entered ----
    if (p === '/api/access' && req.method === 'POST') return enterAccessCode(req, res);
    if (ACCESS_CODE && !hasAccess(req) && !openWithoutCode(p)) {
      if (p.startsWith('/api/')) return json(res, { error: 'Access code required.' }, 401);
      return sendFile(res, path.join(ROOT, 'access.html'), 401); // the code page, at the same address
    }
  } catch (e) {
    return json(res, { error: e.message === 'Request too large' ? 'That upload is too large.' : 'Something went wrong on the server.' }, 400);
  }
  const me = userFromCookie(req.headers.cookie);
  try {
    // ---- accounts ----
    // Pages about PromptCollab: public, even while the access code is on.
    if (INFO_PAGES.includes(p) && p !== '/') return sendFile(res, path.join(ROOT, `${p.slice(1)}.html`));
    if (p === '/signup' || p === '/signin' || p === '/reset') {
      if (me) return redirect(res, safeNext(url.searchParams.get('next')));
      return sendFile(res, path.join(ROOT, `${p.slice(1)}.html`));
    }
    if (p === '/api/signup' && req.method === 'POST') {
      if (!allow(signups, clientIp(req), 10, 60 * 60e3)) {
        return json(res, { error: 'Too many new accounts from this network. Try again in an hour.' }, 429);
      }
      const body = await readBody(req);
      const result = await createAccount(body);
      if (result.error) return json(res, { field: result.field, error: result.error }, 400);
      signIn(req, res, result.user);
      // Shown once on the sign-up page, so a forgotten password can be reset without email.
      return json(res, { user: publicUser(result.user), recoveryCodes: await newRecoveryCodes(result.user) });
    }
    if (p === '/api/reset' && req.method === 'POST') {
      const ip = clientIp(req);
      if (tooManyFailures(ip)) return json(res, { error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
      const result = await resetWithCode(await readBody(req, 4096));
      if (result.error) { if (result.field === 'code') recordFailure(ip); return json(res, result, 400); }
      signIn(req, res, result.user);
      return json(res, { user: publicUser(result.user), recoveryCodesLeft: recoveryCodesLeft(result.user) });
    }
    if (p === '/api/signin' && req.method === 'POST') {
      const ip = clientIp(req);
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
    if (p === '/api/account') return json(res, { user: publicUser(me), recoveryCodesLeft: recoveryCodesLeft(me), ...contactLists(me) });
    if (p === '/api/account/recovery' && req.method === 'POST') {
      const { password } = await readBody(req, 4096);
      if (!(await verifyPassword(me, password))) return json(res, { field: 'recoveryPassword', error: "That isn't your password." }, 400);
      return json(res, { codes: await newRecoveryCodes(me) });
    }
    if (p === '/api/account/export') {
      const data = {
        exportedAt: new Date().toISOString(),
        note: 'Everything PromptCollab stores about you. Passwords and API keys are never included; keys show only their last 4 characters.',
        account: exportAccount(me),
        apiKeys: Object.fromEntries(Object.entries(keySummary(me.id)).map(([k, v]) => [k, { endsWith: v.last4, addedAt: new Date(v.addedAt).toISOString() }])),
        ...exportRooms(me.id),
      };
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="promptcollab-${me.username}.json"`,
      });
      return res.end(JSON.stringify(data, null, 2));
    }
    if (p === '/api/account/delete' && req.method === 'POST') {
      const { password } = await readBody(req, 4096);
      if (!(await verifyPassword(me, password))) return json(res, { field: 'deletePassword', error: "That isn't your password." }, 400);
      removeAccountFromRooms(me.id);
      removeAllKeys(me.id);
      deleteAccountRecord(me);
      res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return json(res, { ok: true });
    }
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
    if (p === '/api/models') {
      const keys = keysFor(me.id);
      // usingHouse: free models would run on the site's key (they have no OpenRouter key of their own).
      return json(res, { models: await modelsFor(keys, { house: houseEnabled() }), house: { ...houseStatus(me.id), usingHouse: houseEnabled() && !keys.openrouter } });
    }

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
    if (p === '/api/config') return json(res, { accessCodeRequired: !!ACCESS_CODE, unlocked: !ACCESS_CODE || hasAccess(req), lanUrls: lanUrls() });
    if (p === '/healthz') return json(res, { ok: true });

    const file = path.normalize(path.join(ROOT, p === '/' ? 'index.html' : p));
    if (!file.startsWith(ROOT + path.sep)) return notFound(res);
    return sendFile(res, file);
  } catch (e) {
    if (e.message === 'Request too large') return json(res, { error: 'That upload is too large.' }, 413);
    console.error(e);
    errorPage(res, 500);
  }
});

attachWebSocket(server, '/ws', (socket, req, url) => {
  const roomId = url.searchParams.get('room') || '';
  if (!validRoomId(roomId)) return socket.destroy();
  // Only pages from this site may connect, only with the access code (if one is set),
  // and only for a signed-in person.
  if (!sameOrigin(req)) return socket.destroy();
  if (ACCESS_CODE && !hasAccess(req)) return socket.destroy();
  const account = userFromCookie(req.headers.cookie);
  if (!account) {
    socket.send({ type: 'signin' });
    return setTimeout(() => socket.destroy(), 1000); // give the message time to arrive
  }
  let room = null;
  socket.on('message', (msg) => {
    if (!room) {
      if (msg.type !== 'hello') return;
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
  if (houseEnabled()) checkHouseKey();
  else console.log('Free messages without a key: off (set OPENROUTER_HOUSE_KEY in .env to turn them on).');
  const oldKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'].filter((k) => process.env[k]);
  if (oldKeys.length) console.warn(`Note: ${oldKeys.join(', ')} in .env are no longer used. You can delete them from .env.`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveAll(); process.exit(0); });
}

// ---- helpers ----

function sendFile(res, file, status = 200) {
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(file);
    if (ext === '.html') data = Buffer.from(data.toString('utf8').replace('<!--meta-->', pageMeta(res.req)));
    res.writeHead(status, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      // Font files and versioned libraries (/vendor/name-1.2.3/) never change, so browsers
      // keep them; everything else is re-checked.
      'cache-control': ext === '.woff2' || file.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
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

// ---- link previews ----

const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tags that make shared links show a preview card (Discord, iMessage, X, Slack...).
// Room links stay generic so a restricted room's name never leaks.
function pageMeta(req) {
  const p = new URL(req.url, 'http://x').pathname;
  // Previews need full URLs. The Host header comes from the visitor, so only accept a plain host[:port].
  const host = /^[a-z0-9.-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/i.test(req.headers.host || '') ? req.headers.host : `localhost:${PORT}`;
  const origin = `${isHttps(req) ? 'https' : 'http'}://${host}`;
  const room = p.startsWith('/r/');
  const title = room ? "You're invited to a room on PromptCollab" : 'PromptCollab: write the prompt together';
  const description = room
    ? 'Join your team to write an AI prompt together, live, then send it to any model.'
    : 'Your whole team edits one AI prompt live, like a shared doc, then sends it to GPT, Claude, Gemini or hundreds of open models.';
  const publicPage = INFO_PAGES.includes(p);
  return [
    `<meta name="description" content="${escAttr(description)}">`,
    publicPage ? '' : '<meta name="robots" content="noindex">',
    '<meta name="theme-color" content="#121722">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="PromptCollab">',
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(description)}">`,
    `<meta property="og:url" content="${escAttr(origin + p)}">`,
    `<meta property="og:image" content="${escAttr(origin)}/og.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="PromptCollab: two people editing one AI prompt together">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escAttr(title)}">`,
    `<meta name="twitter:description" content="${escAttr(description)}">`,
    `<meta name="twitter:image" content="${escAttr(origin)}/og.png">`,
  ].filter(Boolean).join('\n  ');
}

// ---- security ----

// Headers that make the browser stricter about what this site's pages can do.
function setSecurityHeaders(req, res, p) {
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // inline style="" sets avatar colors
    "font-src 'self'", // fonts ship with the app, so no third-party font server sees visitors
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

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

// The visitor's address, for rate limits. Behind a Cloudflare Tunnel every request
// arrives from this computer (where cloudflared runs), so use the address Cloudflare
// reports instead. That header is only trusted from this computer: anyone else
// connecting directly could fake it.
function clientIp(req) {
  const direct = req.socket.remoteAddress;
  const cf = req.headers['cf-connecting-ip'];
  if (LOOPBACK.includes(direct) && typeof cf === 'string' && /^[0-9a-f.:]{2,45}$/i.test(cf.trim())) return cf.trim();
  return direct;
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
  return LOOPBACK.includes(req.socket.remoteAddress) && !req.headers['cf-connecting-ip']; // not tunnel traffic
}

// Everything the API keys page shows. Never includes a full key.
function keyPageData(req, me) {
  const saved = keySummary(me.id);
  return {
    secure: secureEnoughForKeys(req),
    house: houseStatus(me.id), // free messages without a key, if the site offers them
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

// ---- access code ----

// What the access cookie holds: a fingerprint of the code, never the code itself.
// Changing ACCESS_CODE changes it, so everyone is asked for the new code.
const ACCESS_COOKIE = 'pc_access';
const INFO_PAGES = ['/', '/about', '/faq', '/privacy'];
const accessToken = () => crypto.createHmac('sha256', 'promptcollab-access-v1').update(ACCESS_CODE).digest('base64url');
const sameSecret = (a, b) => {
  const [x, y] = [a, b].map((s) => crypto.createHash('sha256').update(String(s)).digest());
  return crypto.timingSafeEqual(x, y); // compares without leaking hints through timing
};

function hasAccess(req) {
  const got = readCookie(req.headers.cookie, ACCESS_COOKIE);
  return !!got && sameSecret(got, accessToken());
}

// Without the code, people can still read about PromptCollab (home, about, FAQ,
// privacy) and load what those pages and the code page need. Accounts, rooms,
// keys and every other API stay locked.
function openWithoutCode(p) {
  return [...INFO_PAGES, '/healthz', '/api/config', '/favicon.svg', '/og.png', '/apple-touch-icon.png'].includes(p) ||
    ['/css/', '/js/', '/fonts/', '/vendor/', '/shared/'].some((dir) => p.startsWith(dir));
}

// 10 wrong codes from one address locks it out for 15 minutes.
const codeFailures = new Map(); // ip -> { count, since }

async function enterAccessCode(req, res) {
  if (!ACCESS_CODE) return json(res, { ok: true }); // no code needed
  const ip = clientIp(req);
  const f = codeFailures.get(ip);
  if (f && Date.now() - f.since > 15 * 60e3) codeFailures.delete(ip);
  if ((codeFailures.get(ip)?.count || 0) >= 10) {
    return json(res, { error: 'Too many wrong tries. Wait 15 minutes, then try again.' }, 429);
  }
  const { code } = await readBody(req, 4096);
  if (!sameSecret(String(code || '').trim(), ACCESS_CODE)) {
    const entry = codeFailures.get(ip) || { count: 0, since: Date.now() };
    entry.count++;
    codeFailures.set(ip, entry);
    return json(res, { error: "That code isn't right. Check it with whoever gave it to you." }, 400);
  }
  codeFailures.delete(ip);
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('set-cookie', `${ACCESS_COOKIE}=${accessToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}${secure}`);
  return json(res, { ok: true });
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
// A styled page for people, JSON for code calling the API.
function notFound(res) { errorPage(res, 404); }
function errorPage(res, status) {
  if (res.headersSent) return res.end();
  if (new URL(res.req.url, 'http://x').pathname.startsWith('/api/')) {
    return json(res, { error: status === 404 ? 'Not found.' : 'Something went wrong on the server.' }, status);
  }
  let html;
  try { html = fs.readFileSync(path.join(ROOT, `${status}.html`), 'utf8').replace('<!--meta-->', pageMeta(res.req)); } catch { /* page missing */ }
  res.writeHead(status, { 'content-type': html ? TYPES['.html'] : 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html || (status === 404 ? 'Not found' : 'Server error'));
}

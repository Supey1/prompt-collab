// End-to-end checks of the HTTP server: starts a real server on a free port
// with an empty, temporary data folder, then talks to it like a browser would.
// Run: node test/server.test.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcollab-test-'));
const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const base = `http://localhost:${port}`;
let server = startServer();

try {
  await waitForServer();
  await run();
  console.log('Server tests passed');
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function run() {
  // Pages, security headers and link previews.
  let r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const home = await r.text();
  assert.match(home, new RegExp(`<meta property="og:image" content="${base}/og.png">`));
  assert.doesNotMatch(home, /<!--meta-->/);

  r = await fetch(base + '/r/abcdefgh', { redirect: 'manual' });
  assert.equal(r.status, 302, 'rooms need sign-in');

  // Styled 404 for people, JSON for the API.
  r = await fetch(base + '/no-such-page');
  assert.equal(r.status, 404);
  assert.match(await r.text(), /This page doesn't exist/);
  r = await fetch(base + '/../package.json');
  assert.equal(r.status, 404);

  // Sign up: recovery codes come back once.
  const ana = await signUp('ana');
  assert.equal(ana.codes.length, 8);
  assert.match(ana.codes[0], /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  r = await api('/api/nope', ana);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'Not found.');

  // Requests from other websites are refused (CSRF).
  r = await fetch(base + '/api/account/profile', {
    method: 'POST', headers: { cookie: ana.cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'hacked', color: '#000000', avatarMode: 'letter' }),
  });
  assert.equal(r.status, 403);

  // "__proto__" must never resolve to a real object.
  r = await api('/api/contacts/remove', ana, { userId: '__proto__' });
  assert.equal(r.status, 200);
  r = await api('/api/contacts/request', ana, { username: '__proto__' });
  assert.equal((await r.json()).error, 'No account with that username.');
  // ...and, checked directly: removing a "__proto__" contact must not add
  // properties to every object in the program (prototype pollution).
  process.env.DATA_DIR = path.join(dataDir, 'unit');
  const accounts = await import('../server/accounts.js');
  assert.equal(accounts.getUser('__proto__'), null);
  accounts.disconnect({ id: 'someone', contacts: [], incoming: [] }, '__proto__');
  assert.equal({}.incoming, undefined);
  assert.equal({}.contacts, undefined);

  // Ana hosts a room and adds Ben, so it has someone to pass to.
  r = await fetch(base + '/new', { headers: { cookie: ana.cookie }, redirect: 'manual' });
  const roomCode = r.headers.get('location').split('/r/')[1];
  const ben = await signUp('ben');
  await restartServer(() => addMember(roomCode, ben.username));

  // Reset a forgotten password with a recovery code, which then stops working.
  r = await api('/api/reset', null, { username: 'ana', code: ana.codes[0].toLowerCase(), password: 'brand-new-pass' });
  assert.equal(r.status, 200, 'codes are not case-sensitive');
  assert.equal((await r.json()).recoveryCodesLeft, 7);
  r = await api('/api/me', ana);
  assert.equal((await r.json()).user, null, 'a reset signs out every browser');
  r = await api('/api/reset', null, { username: 'ana', code: ana.codes[0], password: 'another-pass-1' });
  assert.equal(r.status, 400, 'a used code is rejected');
  const ana2 = await signIn('ana', 'brand-new-pass');

  // Download my data: everything except secrets.
  r = await api('/api/account/export', ana2);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const exported = await r.text();
  assert.match(exported, /"username": "ana"/);
  assert.match(exported, new RegExp(roomCode));
  assert.doesNotMatch(exported, /passwordHash|salt|recoveryHashes/);

  // Delete: wrong password refused; right password removes the account and hands the room to Ben.
  r = await api('/api/account/delete', ana2, { password: 'wrong-password' });
  assert.equal(r.status, 400);
  r = await api('/api/account/delete', ana2, { password: 'brand-new-pass' });
  assert.equal(r.status, 200);
  r = await api('/api/me', ana2);
  assert.equal((await r.json()).user, null);
  r = await api('/api/my-rooms', ben);
  const rooms = (await r.json()).rooms;
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].role, 'host', 'the room passed to Ben');
  const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  assert.ok(!Object.values(users).some((u) => u.username === 'ana'));
}

// ---- helpers ----

function startServer() {
  return spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, KEY_ENCRYPTION_SECRET: 'test-secret-that-is-long-enough-123' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

// Stop the server (it saves everything on the way out), change files, start it again.
async function restartServer(change) {
  server.kill();
  await once(server, 'exit');
  change();
  server = startServer();
  await waitForServer();
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

function api(p, who, body) {
  const headers = { ...(who ? { cookie: who.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  return fetch(base + p, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
}

function cookieOf(r) { return (r.headers.get('set-cookie') || '').split(';')[0]; }

async function signUp(username) {
  const r = await api('/api/signup', null, { username, displayName: username, password: 'password123', color: '#2f5be8' });
  assert.equal(r.status, 200, `sign up ${username}`);
  return { username, cookie: cookieOf(r), codes: (await r.json()).recoveryCodes };
}

async function signIn(username, password) {
  const r = await api('/api/signin', null, { username, password });
  assert.equal(r.status, 200);
  return { username, cookie: cookieOf(r) };
}

// Adding people happens over the live connection, so edit the saved room directly
// (while the server is stopped).
function addMember(code, username) {
  const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  const id = Object.values(users).find((u) => u.username === username).id;
  const file = path.join(dataDir, 'rooms', `${code}.json`);
  const room = JSON.parse(fs.readFileSync(file, 'utf8'));
  room.members.push(id);
  fs.writeFileSync(file, JSON.stringify(room));
}

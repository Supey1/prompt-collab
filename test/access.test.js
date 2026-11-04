// With ACCESS_CODE set, the whole site is private until the code is entered.
// Starts real servers with temporary data folders.
// Run: node test/access.test.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcollab-access-'));
const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const base = `http://localhost:${port}`;
let server;

try {
  await start('purple-tiger-river-42');

  // Locked: pages show the code page (at the same address), APIs refuse.
  for (const p of ['/', '/signup', '/signin', '/account', '/keys', '/r/abcdefgh', '/new', '/no-such-page']) {
    const r = await fetch(base + p, { redirect: 'manual' });
    assert.equal(r.status, 401, `${p} is locked`);
    assert.match(await r.text(), /This site is private/, `${p} shows the code page`);
  }
  let r = await post('/api/signup', { username: 'sneaky', displayName: 'S', password: 'password123', color: '#2f5be8' });
  assert.equal(r.status, 401, "can't create an account without the code");
  assert.equal((await r.json()).error, 'Access code required.');

  // What the code page needs, and the privacy page, stay reachable.
  for (const p of ['/css/app.css', '/js/access.js', '/js/theme.js', '/favicon.svg', '/privacy', '/healthz']) {
    assert.equal((await fetch(base + p)).status, 200, `${p} stays open`);
  }

  // Wrong code: a clear message, no cookie.
  r = await post('/api/access', { code: 'wrong-guess' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /That code isn't right/);
  assert.equal(r.headers.get('set-cookie'), null);

  // Right code (spaces around it are fine): a cookie that unlocks everything.
  r = await post('/api/access', { code: '  purple-tiger-river-42 ' });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.ok(!cookie.includes('purple-tiger'), 'the cookie never contains the code itself');
  r = await fetch(base + '/', { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.doesNotMatch(await r.text(), /This site is private/);
  r = await post('/api/signup', { username: 'friend', displayName: 'F', password: 'password123', color: '#2f5be8' }, cookie);
  assert.equal(r.status, 200, 'with the code, sign-up works');

  // A made-up cookie doesn't work.
  assert.equal((await fetch(base + '/', { headers: { cookie: 'pc_access=made-up' } })).status, 401);

  // Changing the code asks everyone again.
  await start('a-brand-new-code-77');
  assert.equal((await fetch(base + '/', { headers: { cookie } })).status, 401, 'old code no longer works');

  // Too many wrong guesses: locked out, even for the right code.
  for (let i = 0; i < 10; i++) assert.equal((await post('/api/access', { code: `guess-${i}` })).status, 400);
  r = await post('/api/access', { code: 'a-brand-new-code-77' });
  assert.equal(r.status, 429, 'the 11th try is refused, even if right');
  assert.match((await r.json()).error, /Too many wrong tries/);

  // Behind a Cloudflare Tunnel every request comes from this computer; Cloudflare's
  // CF-Connecting-IP says who the visitor really is, so one visitor's wrong guesses
  // don't lock out everyone else.
  const visitor = (ip) => ({ 'cf-connecting-ip': ip });
  r = await post('/api/access', { code: 'a-brand-new-code-77' }, null, visitor('203.0.113.5'));
  assert.equal(r.status, 200, 'a different visitor through the tunnel is not locked out');
  for (let i = 0; i < 10; i++) await post('/api/access', { code: `nope-${i}` }, null, visitor('203.0.113.6'));
  assert.equal((await post('/api/access', { code: 'a-brand-new-code-77' }, null, visitor('203.0.113.6'))).status, 429, 'that visitor is locked out');
  assert.equal((await post('/api/access', { code: 'a-brand-new-code-77' }, null, visitor('203.0.113.7'))).status, 200, 'others still get in');

  // No code set: the site is open, like before.
  await start('');
  assert.equal((await fetch(base + '/')).status, 200);
  assert.doesNotMatch(await (await fetch(base + '/')).text(), /This site is private/);

  console.log('Access code tests passed');
} finally {
  if (server) { server.kill(); await once(server, 'exit').catch(() => {}); }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function start(code) {
  if (server) { server.kill(); await once(server, 'exit'); }
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ACCESS_CODE: code, KEY_ENCRYPTION_SECRET: 'test-secret-that-is-long-enough-123', OPENROUTER_HOUSE_KEY: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('server did not start');
}

function post(p, body, cookie, extra = {}) {
  return fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify(body) });
}

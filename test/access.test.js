// With ACCESS_CODE set, the app is private until the code is entered. Pages
// about PromptCollab (home, about, FAQ, privacy) stay public.
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
  for (const p of ['/signup', '/signin', '/account', '/keys', '/r/abcdefgh', '/new', '/no-such-page']) {
    const r = await fetch(base + p, { redirect: 'manual' });
    assert.equal(r.status, 401, `${p} is locked`);
    assert.match(await r.text(), /This site is private/, `${p} shows the code page`);
  }
  let r = await post('/api/signup', { username: 'sneaky', displayName: 'S', password: 'password123', color: '#2f5be8' });
  assert.equal(r.status, 401, "can't create an account without the code");
  assert.equal((await r.json()).error, 'Access code required.');

  for (const p of ['/api/me', '/api/my-rooms', '/api/keys', '/api/rooms/abcdefgh']) {
    assert.equal((await fetch(base + p)).status, 401, `${p} is locked`);
  }

  // What the code page needs, and the pages about PromptCollab, stay reachable.
  for (const p of ['/css/app.css', '/js/access.js', '/js/theme.js', '/js/site.js', '/favicon.svg', '/healthz']) {
    assert.equal((await fetch(base + p)).status, 200, `${p} stays open`);
  }
  for (const [p, text] of [['/', /Write the prompt together/], ['/about', /Why PromptCollab exists/], ['/faq', /Questions and answers/], ['/privacy', /What's stored/]]) {
    r = await fetch(base + p);
    assert.equal(r.status, 200, `${p} is public`);
    const html = await r.text();
    assert.match(html, text, `${p} shows its own content`);
    assert.doesNotMatch(html, /This site is private/);
    assert.doesNotMatch(html, /noindex/, `${p} can be found by search engines`);
  }
  let config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.accessCodeRequired, true);
  assert.equal(config.unlocked, false, 'the home page knows to show the private-preview note');

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
  r = await fetch(base + '/new', { headers: { cookie }, redirect: 'manual' });
  assert.equal(r.status, 302, 'past the code, signed-out people are sent to sign in');
  config = await (await fetch(base + '/api/config', { headers: { cookie } })).json();
  assert.equal(config.unlocked, true);
  r = await post('/api/signup', { username: 'friend', displayName: 'F', password: 'password123', color: '#2f5be8' }, cookie);
  assert.equal(r.status, 200, 'with the code, sign-up works');

  // A made-up cookie doesn't work.
  assert.equal((await fetch(base + '/signup', { headers: { cookie: 'pc_access=made-up' } })).status, 401);

  // Changing the code asks everyone again.
  await start('a-brand-new-code-77');
  assert.equal((await fetch(base + '/signup', { headers: { cookie } })).status, 401, 'old code no longer works');

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

  // X-Real-IP is ignored unless the site runs behind a proxy that sets it:
  // otherwise anyone could fake an address to dodge the limits.
  assert.equal((await post('/api/access', { code: 'a-brand-new-code-77' }, null, { 'x-real-ip': '198.51.100.9' })).status, 429, 'a faked address does not escape the lockout');

  // On Railway every request comes through Railway's edge, which reports the
  // visitor in X-Real-IP. Lockouts are per visitor there too.
  await start('a-brand-new-code-77', { RAILWAY_ENVIRONMENT_NAME: 'production' });
  const railway = (ip) => ({ 'x-real-ip': ip });
  for (let i = 0; i < 10; i++) await post('/api/access', { code: `nope-${i}` }, null, railway('198.51.100.1'));
  assert.equal((await post('/api/access', { code: 'a-brand-new-code-77' }, null, railway('198.51.100.1'))).status, 429, 'on Railway, that visitor is locked out');
  assert.equal((await post('/api/access', { code: 'a-brand-new-code-77' }, null, railway('198.51.100.2'))).status, 200, 'on Railway, others still get in');
  assert.equal((await post('/api/access', { code: 'a-brand-new-code-77' }, null, railway('not an address'))).status, 200, 'a junk header falls back to the connection address');

  // No code set: the site is open, like before.
  await start('');
  assert.equal((await fetch(base + '/signup')).status, 200);
  assert.doesNotMatch(await (await fetch(base + '/signup')).text(), /This site is private/);
  assert.equal((await (await fetch(base + '/api/config')).json()).unlocked, true);

  // Every link on the public pages goes somewhere real (a page, or the sign-in redirect).
  for (const page of ['/', '/about', '/faq', '/privacy']) {
    const html = await (await fetch(base + page)).text();
    const links = new Set([...html.matchAll(/(?:href|src)="(\/[^"#]*)/g)].map((m) => m[1] || '/'));
    for (const link of links) {
      const res = await fetch(base + link, { redirect: 'manual' });
      assert.ok([200, 302].includes(res.status), `${link} (linked from ${page}) works: got ${res.status}`);
    }
    for (const id of [...html.matchAll(/href="\/#([\w-]+)"/g)].map((m) => m[1])) {
      assert.match(await (await fetch(base + '/')).text(), new RegExp(`id="${id}"`), `/#${id} exists on the home page`);
    }
  }

  console.log('Access code tests passed');
} finally {
  if (server) { server.kill(); await once(server, 'exit').catch(() => {}); }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function start(code, extraEnv = {}) {
  if (server) { server.kill(); await once(server, 'exit'); }
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ACCESS_CODE: code, KEY_ENCRYPTION_SECRET: 'test-secret-that-is-long-enough-123', OPENROUTER_HOUSE_KEY: '', RAILWAY_ENVIRONMENT_NAME: '', RAILWAY_PROJECT_ID: '', TRUST_REAL_IP: '', ...extraEnv },
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

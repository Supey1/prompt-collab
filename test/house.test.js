// The house key must only ever pay for OpenRouter's free models, within the
// daily limits. Runs against a fake OpenRouter model list: no network, no key.
// Run: node test/house.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcollab-house-'));
const HOUSE = 'sk-or-v1-house-key-for-tests-000000000000000';
Object.assign(process.env, {
  DATA_DIR: dataDir,
  OPENROUTER_HOUSE_KEY: HOUSE,
  HOUSE_DAILY_PER_PERSON: '2',
  HOUSE_DAILY_TOTAL: '3',
  KEY_ENCRYPTION_SECRET: 'test-secret-that-is-long-enough-123',
});

// Fake OpenRouter: one truly free model, one that says ":free" but has a price,
// a free model that can't chat (a safety classifier), and a paid one.
// `freeLeft` is what OpenRouter reports as this key's free requests left today.
let freeLeft = 50;
globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://openrouter.ai/api/v1/models')) {
    return new Response(JSON.stringify({ data: [
      { id: 'meta/llama-free:free', pricing: { prompt: '0', completion: '0' } },
      { id: 'tricky/priced:free', pricing: { prompt: '0.000001', completion: '0' } },
      { id: 'acme/content-safety:free', pricing: { prompt: '0', completion: '0' } },
      { id: 'openai/gpt-5', pricing: { prompt: '0.00001', completion: '0.00003' } },
    ] }), { status: 200 });
  }
  if (String(url) === 'https://openrouter.ai/api/v1/key') {
    return new Response(JSON.stringify({ data: { limit: 0, free_model_daily_requests: { used: 50 - freeLeft, limit: 50, remaining: freeLeft } } }), { status: 200 });
  }
  throw new Error(`unexpected request to ${url}`);
};

try {
  const { createRoom } = await import('../server/rooms.js');
  const { saveKey } = await import('../server/keys.js');
  const { modelsFor } = await import('../server/providers.js');
  const { houseStatus, giveBackHouseMessage, syncHousePool } = await import('../server/house.js');

  // Ask a room for the key it would use when `who` presses Send with `model`.
  const notices = [];
  const socket = { send: (m) => { if (m.type === 'notice') notices.push(m.message); } };
  const room = createRoom('owner');
  async function keyFor(who, model) {
    room.model = model;
    const r = await room.modelFor(socket, { accountId: who });
    return r && (r.house ? 'HOUSE' : r.key);
  }

  // Only a :free model that is also priced $0 may use the house key.
  assert.equal(await keyFor('ana', 'openrouter:meta/llama-free:free'), 'HOUSE');
  assert.equal(await keyFor('ana', 'openrouter:tricky/priced:free'), null, 'priced ":free" model must not use the house key');
  assert.equal(await keyFor('ana', 'openrouter:openai/gpt-5'), null, 'paid model must not use the house key');

  // Per-person limit (2 here): Ana used 1 above, so one more, then a clear notice.
  assert.equal(await keyFor('ana', 'openrouter:meta/llama-free:free'), 'HOUSE');
  assert.equal(await keyFor('ana', 'openrouter:meta/llama-free:free'), null);
  assert.match(notices.at(-1), /used your 2 free messages/);
  assert.deepEqual(houseStatus('ana'), { enabled: true, perPerson: 2, left: 0, poolEmpty: false });

  // A failed message is given back.
  giveBackHouseMessage('ana');
  assert.equal(houseStatus('ana').left, 1);
  assert.equal(await keyFor('ana', 'openrouter:meta/llama-free:free'), 'HOUSE');

  // Shared daily total (3 here): Ana has 2, Ben gets the last one, then nobody.
  assert.equal(await keyFor('ben', 'openrouter:meta/llama-free:free'), 'HOUSE');
  assert.equal(await keyFor('cara', 'openrouter:meta/llama-free:free'), null);
  assert.match(notices.at(-1), /free messages are used up for today/);

  // Someone with their own OpenRouter key always uses theirs, for free and paid models.
  const own = 'sk-or-v1-dana-own-key-000000000000000000000';
  saveKey('dana', 'openrouter', own);
  assert.equal(await keyFor('dana', 'openrouter:meta/llama-free:free'), own);
  assert.equal(await keyFor('dana', 'openrouter:openai/gpt-5'), own);

  // The model menu: free models first, labelled without ":free"; never the key itself.
  const menu = await modelsFor({}, { house: true });
  assert.deepEqual(menu.filter((m) => m.free).map((m) => m.label), ['meta/llama-free']);
  assert.equal(menu[0].free, true, 'free models come first');
  assert.ok(!JSON.stringify(menu).includes(HOUSE) && !JSON.stringify(houseStatus('ana')).includes(HOUSE));
  assert.equal((await modelsFor({}, { house: false })).filter((m) => m.free).length, 0, 'no free models without a key or house key');

  // A 429 can mean "busy", not "used up": only OpenRouter's own count may empty the pool.
  // (The bug: one busy model set everyone to 0 of 5 for the rest of the day.)
  freeLeft = 49;
  assert.equal(await syncHousePool(), 49);
  assert.equal(houseStatus('erin').left, 2, 'a busy model must not use up everyone\'s messages');
  freeLeft = 0;
  assert.equal(await syncHousePool(), 0);
  assert.equal(houseStatus('erin').left, 0, 'OpenRouter says none left today');
  freeLeft = 49; // (this test's daily total is 3, so 1 used leaves 2)
  await syncHousePool();
  assert.equal(houseStatus('erin').left, 2, 'a wrong count heals from OpenRouter');

  // Backup models for a busy free model: only other free models that can chat, at most 2.
  room.model = 'openrouter:meta/llama-free:free';
  const sent = await room.modelFor(socket, { accountId: 'dana' });
  assert.deepEqual(sent.fallbacks, [], 'no other chat-capable free models in this list');
  const { freeModels } = await import('../server/providers.js');
  assert.ok(!(await freeModels()).some((m) => /content-safety/.test(m)), 'non-chat models are hidden');

  // With no house key set, it's off and never used.
  const off = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const h = await import('./server/house.js'); console.log(JSON.stringify([h.houseEnabled(), h.takeHouseMessage('x')]));"],
  { env: { ...process.env, OPENROUTER_HOUSE_KEY: '', DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.equal(off.stdout.trim(), '[false,{"error":"off"}]');

  console.log('House key tests passed');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

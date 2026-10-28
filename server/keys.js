import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Everyone's own API keys, encrypted at rest in data/keys.json.
//
// - Encryption: AES-256-GCM. The 32-byte encryption key comes from the
//   KEY_ENCRYPTION_SECRET environment variable, or from data/secret.key,
//   which is created with random bytes on first run (readable only by the
//   server's user).
// - Each ciphertext is bound to its owner and provider (GCM "additional data"),
//   so copying one person's entry onto another account makes it undecryptable.
// - Nothing here returns a full key except getKey(), which is only called
//   right before a request goes to that provider.

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

const store = readJson(KEYS_FILE, {}); // userId -> provider -> { box, last4, addedAt }
const master = loadMasterKey();

function loadMasterKey() {
  const fromEnv = (process.env.KEY_ENCRYPTION_SECRET || '').trim();
  if (fromEnv) {
    if (fromEnv.length < 32) console.warn('[keys] KEY_ENCRYPTION_SECRET is short; use at least 32 random characters.');
    return crypto.createHash('sha256').update(fromEnv).digest();
  }
  try {
    const saved = fs.readFileSync(SECRET_FILE);
    if (saved.length === 32) return saved;
  } catch { /* first run */ }
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRET_FILE, fresh, { mode: 0o600 });
  console.warn(`[keys] Created ${SECRET_FILE} to encrypt saved API keys. Keep it private, and back it up with data/; without it saved keys can't be read. When you deploy, set KEY_ENCRYPTION_SECRET instead.`);
  return fresh;
}

const aad = (userId, provider) => Buffer.from(`${userId}:${provider}`);

function seal(plain, userId, provider) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
  cipher.setAAD(aad(userId, provider));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function open(box, userId, provider) {
  const raw = Buffer.from(box, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', master, raw.subarray(0, 12));
  decipher.setAAD(aad(userId, provider));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function saveKey(userId, provider, key) {
  (store[userId] ||= {})[provider] = { box: seal(key, userId, provider), last4: key.slice(-4), addedAt: Date.now() };
  writeJson(KEYS_FILE, store);
}

export function removeKey(userId, provider) {
  if (!store[userId]?.[provider]) return;
  delete store[userId][provider];
  if (!Object.keys(store[userId]).length) delete store[userId];
  writeJson(KEYS_FILE, store);
}

// The full key, for sending a request to that provider. Null if missing or
// unreadable (for example after the encryption secret changed).
export function getKey(userId, provider) {
  const entry = store[userId]?.[provider];
  if (!entry) return null;
  try { return open(entry.box, userId, provider); } catch { return null; }
}

// What the browser may know: which providers have a key, and its last 4 characters.
export function keySummary(userId) {
  const out = {};
  for (const [provider, entry] of Object.entries(store[userId] || {})) {
    out[provider] = { last4: entry.last4, addedAt: entry.addedAt, readable: getKey(userId, provider) !== null };
  }
  return out;
}

// { provider: fullKey } for every readable key someone has.
export function keysFor(userId) {
  const out = {};
  for (const provider of Object.keys(store[userId] || {})) {
    const key = getKey(userId, provider);
    if (key) out[provider] = key;
  }
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

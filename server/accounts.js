import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Accounts and sign-in sessions, saved as JSON next to the rooms:
//   data/users.json      accounts (passwords stored only as scrypt hashes)
//   data/sessions.json   signed-in browsers (only a hash of each cookie token)
//   data/avatars/<id>    uploaded profile pictures

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const SESSION_DAYS = 30;
const MAX_AVATAR_BYTES = 200 * 1024;
const AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const users = readJson(USERS_FILE, {});       // id -> user
const sessions = readJson(SESSIONS_FILE, {}); // sha256(token) -> { userId, expires }

export const COOKIE = 'pc_session';
export const validColor = (c) => /^#[0-9a-f]{6}$/i.test(c || '');

// ---- sign up / sign in ----

// Returns { user } or { field, error } describing the first problem found.
export async function createAccount({ username, password, displayName, color, avatar }) {
  username = String(username || '').trim();
  displayName = String(displayName || '').trim();
  password = String(password || '');
  if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(username)) {
    return { field: 'username', error: 'Use 3–20 letters, numbers, dots, dashes or underscores.' };
  }
  if (findByUsername(username)) return { field: 'username', error: 'That username is taken.' };
  if (password.length < 8) return { field: 'password', error: 'Use at least 8 characters.' };
  if (password.length > 200) return { field: 'password', error: 'That password is too long.' };
  if (!displayName || displayName.length > 40) return { field: 'displayName', error: 'Enter a display name (up to 40 characters).' };
  if (!validColor(color)) return { field: 'color', error: 'Pick a color.' };

  let image = null;
  if (avatar) {
    image = decodeAvatar(avatar);
    if (!image) return { field: 'avatar', error: 'Use a PNG, JPG or WebP picture under 200 KB.' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(),
    username,
    displayName,
    color: color.toLowerCase(),
    avatar: null,
    passwordHash: await hashPassword(password, salt),
    salt,
    createdAt: Date.now(),
  };
  if (image) user.avatar = saveAvatar(user.id, image);
  users[user.id] = user;
  writeJson(USERS_FILE, users);
  return { user };
}

// Returns the user if the username and password match, otherwise null.
export async function checkPassword(username, password) {
  const user = findByUsername(String(username || '').trim());
  // Hash even when the user doesn't exist, so a wrong username takes as long as a wrong password.
  const salt = user?.salt || 'no-such-user';
  const hash = await hashPassword(String(password || ''), salt);
  if (!user) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
  return ok ? user : null;
}

function findByUsername(username) {
  const lower = username.toLowerCase();
  return Object.values(users).find((u) => u.username.toLowerCase() === lower) || null;
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

// ---- sessions ----

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function startSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions[tokenHash(token)] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 864e5 };
  pruneSessions();
  writeJson(SESSIONS_FILE, sessions);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function endSession(token) {
  if (!token || !sessions[tokenHash(token)]) return;
  delete sessions[tokenHash(token)];
  writeJson(SESSIONS_FILE, sessions);
}

// The signed-in user for a request's cookie header, or null.
export function userFromCookie(cookieHeader) {
  const token = readCookie(cookieHeader, COOKIE);
  if (!token) return null;
  const s = sessions[tokenHash(token)];
  if (!s || s.expires < Date.now()) return null;
  return users[s.userId] || null;
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function pruneSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(sessions)) if (s.expires < now) delete sessions[k];
}

// ---- profile pictures ----

// What the browser is allowed to know about a user.
export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    color: user.color,
    avatar: user.avatar ? `/api/avatar/${user.id}?v=${user.avatar.version}` : null,
  };
}

// Accepts a data: URL from the sign-up form. Returns { type, bytes } or null.
function decodeAvatar(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES || !looksLike(m[1], bytes)) return null;
  return { type: m[1], bytes };
}

// Check the file really starts like the image type it claims to be.
function looksLike(type, b) {
  if (type === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
}

function saveAvatar(userId, { type, bytes }) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const file = `${userId}.${AVATAR_TYPES[type]}`;
  fs.writeFileSync(path.join(AVATAR_DIR, file), bytes);
  return { file, type, version: Date.now() };
}

// { type, bytes } for a user's profile picture, or null.
export function readAvatar(userId) {
  const a = users[userId]?.avatar;
  if (!a) return null;
  try { return { type: a.type, bytes: fs.readFileSync(path.join(AVATAR_DIR, a.file)) }; } catch { return null; }
}

// ---- files ----

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Write to a temp file and rename, so a crash mid-write can't leave a half-written file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

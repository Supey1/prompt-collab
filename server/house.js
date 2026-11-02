import fs from 'node:fs';
import path from 'node:path';

// The optional "house key": the site owner's free OpenRouter key, which lets
// people without their own key use OpenRouter's free (:free, $0) models.
//
// - Off unless OPENROUTER_HOUSE_KEY is set.
// - Only ever used for free models (rooms.js checks with isFreeModel first).
// - Each person gets HOUSE_DAILY_PER_PERSON messages (default 5) per UTC day,
//   out of a shared HOUSE_DAILY_TOTAL (default 50, OpenRouter's free-tier limit).
// - Counts live in data/house-usage.json so a restart doesn't reset them.

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const USAGE_FILE = path.join(DATA_DIR, 'house-usage.json');
const int = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);

const KEY = (process.env.OPENROUTER_HOUSE_KEY || '').trim();
const PER_PERSON = int(process.env.HOUSE_DAILY_PER_PERSON, 5);
const TOTAL = int(process.env.HOUSE_DAILY_TOTAL, 50);

export const houseEnabled = () => /^sk-or-[A-Za-z0-9_-]{20,}$/.test(KEY);

if (KEY && !houseEnabled()) console.warn('[house] OPENROUTER_HOUSE_KEY doesn\'t look like an OpenRouter key (it starts with sk-or-). Free messages are off.');

const today = () => new Date().toISOString().slice(0, 10); // UTC, the same day OpenRouter uses
let usage = readUsage();

function readUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (u.day === today()) return u;
  } catch { /* first run */ }
  return { day: today(), total: 0, perUser: {} };
}

function current() {
  if (usage.day !== today()) usage = { day: today(), total: 0, perUser: {} };
  return usage;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch (e) { console.warn('[house]', e.message); }
}

// What someone has left today (shown on the keys page and in rooms).
export function houseStatus(accountId) {
  if (!houseEnabled()) return { enabled: false };
  const u = current();
  const used = Object.hasOwn(u.perUser, accountId) ? u.perUser[accountId] : 0;
  return {
    enabled: true,
    perPerson: PER_PERSON,
    left: Math.max(0, Math.min(PER_PERSON - used, TOTAL - u.total)),
    poolEmpty: u.total >= TOTAL,
  };
}

// Take one free message for this person. Returns { key } or { error }.
// Call giveBack() if the request fails, so a failed message doesn't count.
export function takeHouseMessage(accountId) {
  if (!houseEnabled()) return { error: 'off' };
  const u = current();
  const used = Object.hasOwn(u.perUser, accountId) ? u.perUser[accountId] : 0;
  if (u.total >= TOTAL) return { error: 'pool' };
  if (used >= PER_PERSON) return { error: 'person' };
  u.perUser[accountId] = used + 1;
  u.total++;
  save();
  return { key: KEY };
}

export function giveBackHouseMessage(accountId) {
  const u = current();
  if (!Object.hasOwn(u.perUser, accountId) || u.perUser[accountId] <= 0) return;
  u.perUser[accountId]--;
  u.total = Math.max(0, u.total - 1);
  save();
}

// OpenRouter says its free messages are used up for today (429): stop until tomorrow.
export function markHousePoolEmpty() {
  current().total = TOTAL;
  save();
}

// At startup: check the key works, and warn if it could ever spend money.
export async function checkHouseKey() {
  if (!houseEnabled()) return;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.warn(`[house] OpenRouter rejected OPENROUTER_HOUSE_KEY (${res.status}). Free messages won't work until it's fixed.`); return; }
    const { data } = await res.json();
    const free = data.free_model_daily_requests;
    console.log(`Free messages: on (${PER_PERSON} per person per day${free ? `; OpenRouter allows this key ${free.limit} today, ${free.remaining} left` : ''}).`);
    if (data.limit !== 0) {
      console.warn('[house] Safety tip: set this key\'s credit limit to 0 on openrouter.ai (Settings > Keys), so it can never spend money even by mistake.');
    }
  } catch (e) {
    console.warn(`[house] Couldn't check OPENROUTER_HOUSE_KEY with OpenRouter (${e.message}).`);
  }
}

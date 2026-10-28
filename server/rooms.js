import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DocState } from './doc.js';
import { parseModel, modelsFor, redact } from './providers.js';
import { keysFor } from './keys.js';
import { getUser, findUser, publicUser, contactLists } from './accounts.js';

// Rooms live in their own folder so a room code can never collide with
// users.json or sessions.json. Room files from before hosts existed sit in
// data/ itself and are ignored.
const ROOM_DIR = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'rooms');
const FIELDS = ['prompt', 'system'];
const MAX_FIELD_CHARS = 200_000;
const rooms = new Map();

export const newRoomId = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8).toLowerCase() || newRoomId();
export const validRoomId = (id) => /^[a-z0-9-]{3,40}$/.test(id);

class Room {
  constructor(id, saved = {}) {
    this.id = id;
    this.name = saved.name || 'Untitled prompt';
    this.createdAt = saved.createdAt || Date.now();
    this.model = saved.model || null;
    this.docs = {};
    for (const f of FIELDS) this.docs[f] = new DocState(saved.docs?.[f] || '');
    this.thread = saved.thread || [];
    this.usage = saved.usage || { input: 0, output: 0, requests: 0 };
    this.contributors = new Set(saved.contributors || []);
    // Who may enter (account ids). The owner is the host who created the room.
    this.owner = saved.owner;
    this.access = saved.access === 'open' ? 'open' : 'restricted';
    this.members = saved.members || [];   // added by the host
    this.visitors = saved.visitors || []; // came in through the link while it was open
    this.requests = saved.requests || []; // asked the host for access
    this.removed = saved.removed || [];   // removed by the host; kept out even if the room is open
    this.clients = new Map(); // socket -> user
    this.generating = null;   // { controller, messageId, by }
    this.clearedThread = null; // last cleared conversation, kept so it can be undone
    this.saveTimer = null;
  }

  // ---- connection lifecycle ----

  // ---- who may enter ----

  // 'ok', or why not: 'removed' (the host removed them) or 'restricted' (not added yet).
  canEnter(accountId) {
    if (accountId === this.owner) return 'ok';
    if (this.removed.includes(accountId)) return 'removed';
    if (this.access === 'open' || this.members.includes(accountId)) return 'ok';
    return 'restricted';
  }

  roleOf(accountId) {
    if (accountId === this.owner) return 'host';
    if (this.members.includes(accountId)) return 'member';
    if (this.visitors.includes(accountId)) return 'visitor';
    return null;
  }

  // Ask the host to be let in. Returns false if there's nothing to ask for.
  requestAccess(accountId) {
    if (this.canEnter(accountId) === 'ok' || this.requests.includes(accountId)) return false;
    this.requests.push(accountId);
    this.sendShareState();
    this.notifyHost(accountId);
    this.saveNow();
    return true;
  }

  roomInfo() {
    const host = getUser(this.owner);
    return { id: this.id, name: this.name, model: this.model, access: this.access, owner: this.owner, hostName: host?.displayName || 'the host' };
  }

  // `account` is the signed-in person's public profile (see accounts.js).
  join(socket, account) {
    const user = {
      id: crypto.randomUUID().slice(0, 8),
      accountId: account.id,
      name: account.displayName,
      color: account.color,
      avatar: account.avatar,
      cursor: null,
    };
    // Someone who came in through an open link keeps seeing the room on their home page.
    if (!this.roleOf(account.id)) { this.visitors.push(account.id); this.scheduleSave(); }
    this.clients.set(socket, user);
    socket.send({
      type: 'init',
      you: user.id,
      account,
      room: this.roomInfo(),
      docs: Object.fromEntries(FIELDS.map((f) => [f, { text: this.docs[f].text, rev: this.docs[f].rev }])),
      thread: this.thread,
      usage: this.usage,
      users: this.userList(),
      generating: this.generating ? { messageId: this.generating.messageId, by: this.generating.by } : null,
    });
    this.broadcast({ type: 'users', users: this.userList() }, socket);
    this.sendShareState(); // the host's people list shows who is here now
    return user;
  }

  leave(socket) {
    if (!this.clients.delete(socket)) return;
    this.broadcast({ type: 'users', users: this.userList() });
    this.sendShareState();
    if (!this.clients.size) this.saveNow();
  }

  userList() {
    return [...this.clients.values()].map(({ id, name, color, avatar, cursor }) => ({ id, name, color, avatar, cursor }));
  }

  broadcast(msg, except) {
    for (const s of this.clients.keys()) if (s !== except) s.send(msg);
  }

  // ---- messages from a client ----

  async handle(socket, msg) {
    const user = this.clients.get(socket);
    if (!user) return;
    switch (msg.type) {
      case 'op': {
        const doc = this.docs[msg.field];
        if (!doc || !Array.isArray(msg.op) || !validOp(msg.op)) return;
        const res = doc.receive(msg.rev, msg.op);
        if (!res || doc.text.length > MAX_FIELD_CHARS) {
          if (res) doc.set(doc.text.slice(0, MAX_FIELD_CHARS));
          return socket.send({ type: 'resync', field: msg.field, text: doc.text, rev: doc.rev });
        }
        if (msg.field === 'prompt') this.contributors.add(user.name);
        socket.send({ type: 'ack', field: msg.field });
        this.broadcast({ type: 'op', field: msg.field, op: res.op, rev: res.rev, by: user.id }, socket);
        this.scheduleSave();
        break;
      }
      case 'cursor': {
        user.cursor = FIELDS.includes(msg.field) ? { field: msg.field, anchor: msg.anchor | 0, head: msg.head | 0 } : null;
        this.broadcast({ type: 'cursor', id: user.id, cursor: user.cursor }, socket);
        break;
      }
      case 'rename': {
        this.name = String(msg.name || '').slice(0, 80) || 'Untitled prompt';
        this.broadcast({ type: 'room', room: this.roomInfo() });
        this.scheduleSave();
        break;
      }
      case 'model': {
        if (!parseModel(String(msg.model || ''))) return;
        this.model = msg.model;
        this.broadcast({ type: 'room', room: this.roomInfo(), by: user.name });
        this.scheduleSave();
        break;
      }
      case 'send': return this.send(socket, user);
      case 'regenerate': return this.regenerate(socket, user);
      case 'stop': {
        if (this.generating) this.generating.controller.abort();
        break;
      }
      case 'share': return this.shareAction(user, msg);
      case 'clear': {
        if (this.generating || !this.thread.length) return;
        this.clearedThread = this.thread;
        this.thread = [];
        this.broadcast({ type: 'thread', thread: [], clearedBy: user.name });
        this.scheduleSave();
        break;
      }
      case 'undo-clear': {
        // Only restore if nobody has started a new conversation since.
        if (this.generating || this.thread.length || !this.clearedThread) return;
        this.thread = this.clearedThread;
        this.clearedThread = null;
        this.broadcast({ type: 'thread', thread: this.thread, restoredBy: user.name });
        this.scheduleSave();
        break;
      }
    }
  }

  // ---- sharing (host only) ----

  shareAction(user, msg) {
    if (user.accountId !== this.owner) return;
    const reply = (message) => { for (const [s, u] of this.clients) if (u.accountId === this.owner) s.send({ type: 'notice', message }); };
    switch (msg.action) {
      case 'add': {
        const other = msg.userId ? getUser(String(msg.userId)) : findUser(msg.username);
        if (!other) return reply('No account with that username.');
        if (other.id === this.owner) return reply("You're the host, so you already have access.");
        if (this.members.includes(other.id)) return reply(`${other.displayName} already has access.`);
        this.members.push(other.id);
        this.requests = this.requests.filter((id) => id !== other.id);
        this.removed = this.removed.filter((id) => id !== other.id);
        this.visitors = this.visitors.filter((id) => id !== other.id);
        reply(`Added ${other.displayName}.`);
        break;
      }
      case 'remove': {
        const id = String(msg.userId);
        if (id === this.owner) return;
        const name = getUser(id)?.displayName || 'them';
        this.members = this.members.filter((x) => x !== id);
        this.visitors = this.visitors.filter((x) => x !== id);
        if (!this.removed.includes(id)) this.removed.push(id);
        this.kick(id, 'The host removed you from this room.');
        reply(`Removed ${name}.`);
        break;
      }
      case 'allow-back': this.removed = this.removed.filter((x) => x !== String(msg.userId)); break;
      case 'dismiss': this.requests = this.requests.filter((x) => x !== String(msg.userId)); break;
      case 'access': {
        if (!['open', 'restricted'].includes(msg.access) || msg.access === this.access) return;
        this.access = msg.access;
        if (this.access === 'restricted') {
          // Everyone already working here keeps access: make link visitors members.
          const here = [...this.clients.values()].map((u) => u.accountId);
          for (const id of new Set([...this.visitors, ...here])) {
            if (id !== this.owner && !this.members.includes(id)) this.members.push(id);
          }
          this.visitors = [];
        }
        this.broadcast({ type: 'room', room: this.roomInfo() });
        break;
      }
      default: return;
    }
    this.sendShareState();
    this.saveNow();
  }

  // Disconnect every open tab of one account, telling them why.
  kick(accountId, message) {
    for (const [socket, u] of [...this.clients]) {
      if (u.accountId !== accountId) continue;
      socket.send({ type: 'denied', reason: 'removed', message });
      this.leave(socket);
      setTimeout(() => socket.destroy(), 1000);
    }
  }

  // The host's Share panel: everyone with access, who's here now, and requests.
  sendShareState() {
    const hostSockets = [...this.clients].filter(([, u]) => u.accountId === this.owner).map(([s]) => s);
    if (!hostSockets.length) return;
    const here = new Set([...this.clients.values()].map((u) => u.accountId));
    const person = (id) => {
      const u = getUser(id);
      return u && { ...publicUser(u), online: here.has(id) };
    };
    const list = (ids) => ids.map(person).filter(Boolean);
    const host = getUser(this.owner);
    const state = {
      type: 'share',
      access: this.access,
      host: person(this.owner),
      members: list(this.members),
      visitors: list(this.visitors),
      requests: list(this.requests),
      removed: list(this.removed),
      // Contacts who don't have access yet, offered as quick picks.
      contacts: host ? contactLists(host).contacts.filter((c) => !this.members.includes(c.id) && c.id !== this.owner) : [],
    };
    for (const s of hostSockets) s.send(state);
  }

  notifyHost(accountId) {
    const who = getUser(accountId)?.displayName || 'Someone';
    for (const [s, u] of this.clients) if (u.accountId === this.owner) s.send({ type: 'notice', message: `${who} is asking to join this room. Open Share to let them in.` });
  }

  // ---- sending the shared prompt to a model ----

  async send(socket, user) {
    if (this.generating) return socket.send({ type: 'notice', message: 'A response is already being generated.' });
    const prompt = this.docs.prompt.text.trim();
    if (!prompt) return socket.send({ type: 'notice', message: 'The prompt is empty.' });
    const resolved = await this.modelFor(socket, user);
    if (!resolved) return;

    const userMsg = {
      id: crypto.randomUUID(), role: 'user', content: prompt, ts: Date.now(),
      sentBy: user.name, authors: [...this.contributors].slice(0, 12),
    };
    const history = buildHistory(this.thread, prompt);
    this.thread.push(userMsg);
    this.clearedThread = null;
    this.contributors.clear();
    this.broadcast({ type: 'append', messages: [userMsg] });
    // Clear the shared prompt for everyone, as a normal edit so OT stays consistent.
    const cleared = this.docs.prompt.set('');
    if (cleared) this.broadcast({ type: 'op', field: 'prompt', op: cleared.op, rev: cleared.rev, by: null });

    return this.respond(user, resolved, history);
  }

  // Throw away the last reply and ask the room's current model again.
  async regenerate(socket, user) {
    if (this.generating) return socket.send({ type: 'notice', message: 'A response is already being generated.' });
    const last = this.thread[this.thread.length - 1];
    const prev = this.thread[this.thread.length - 2];
    if (last?.role !== 'assistant' || prev?.role !== 'user') return;
    const resolved = await this.modelFor(socket, user);
    if (!resolved) return;

    this.thread.pop();
    this.broadcast({ type: 'remove', id: last.id });
    return this.respond(user, resolved, buildHistory(this.thread.slice(0, -1), prev.content));
  }

  // The room's model plus the key of the person sending, who pays for the reply.
  // Tells them (and returns null) if they don't have a key for it.
  async modelFor(socket, user) {
    const keys = keysFor(user.accountId);
    if (!this.model) {
      this.model = (await modelsFor(keys))[0]?.id || null;
      this.broadcast({ type: 'room', room: this.roomInfo() });
    }
    const m = this.model && parseModel(this.model);
    if (!m) { socket.send({ type: 'notice', message: 'Pick a model first.' }); return null; }
    const key = m.provider.free ? 'demo' : keys[m.name];
    if (!key) {
      socket.send({
        type: 'notice',
        message: `To send with ${m.provider.label} models, add your own ${m.provider.label} API key. Your key is only used for messages you send.`,
        action: { label: 'Add key', href: '/keys' },
      });
      return null;
    }
    return { provider: m.provider, model: m.model, key };
  }

  // Stream a model reply to `history` into the thread, for everyone in the room.
  async respond(user, resolved, history) {
    const reply = {
      id: crypto.randomUUID(), role: 'assistant', content: '', ts: Date.now(),
      model: this.model, status: 'streaming',
    };
    this.thread.push(reply);
    const controller = new AbortController();
    this.generating = { controller, messageId: reply.id, by: user.name };

    this.broadcast({ type: 'append', messages: [reply] });
    this.broadcast({ type: 'generating', generating: { messageId: reply.id, by: user.name } });

    const system = this.docs.system.text.trim();
    let pending = '';
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      if (!pending) return;
      this.broadcast({ type: 'delta', id: reply.id, text: pending });
      pending = '';
    };
    try {
      for await (const piece of resolved.provider.stream(resolved.key, resolved.model, system, history, controller.signal)) {
        if (piece.text) {
          reply.content += piece.text;
          pending += piece.text;
          if (!flushTimer) flushTimer = setTimeout(flush, 30);
        }
        if (piece.usage) reply.usage = piece.usage;
      }
      reply.status = 'done';
    } catch (e) {
      if (controller.signal.aborted) reply.status = 'stopped';
      else {
        // Provider errors are shown to the whole room: never let the sender's key appear in one.
        reply.status = 'error';
        reply.error = redact(e.message, resolved.key);
        console.warn('[send]', reply.error);
      }
    } finally {
      clearTimeout(flushTimer);
      flush();
      if (!reply.usage) reply.usage = { input: Math.round(history.reduce((n, m) => n + m.content.length, system.length) / 4), output: Math.round(reply.content.length / 4), estimated: true };
      this.usage.input += reply.usage.input;
      this.usage.output += reply.usage.output;
      this.usage.requests++;
      this.generating = null;
      this.broadcast({ type: 'done', id: reply.id, status: reply.status, error: reply.error, usage: reply.usage, content: reply.content });
      this.broadcast({ type: 'usage', usage: this.usage });
      this.broadcast({ type: 'generating', generating: null });
      this.scheduleSave();
    }
  }

  // ---- persistence ----

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 1500);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const data = {
      id: this.id, name: this.name, createdAt: this.createdAt, model: this.model,
      docs: Object.fromEntries(FIELDS.map((f) => [f, this.docs[f].text])),
      thread: this.thread.map((m) => (m.status === 'streaming' ? { ...m, status: 'stopped' } : m)),
      usage: this.usage, contributors: [...this.contributors],
      owner: this.owner, access: this.access, members: this.members,
      visitors: this.visitors, requests: this.requests, removed: this.removed,
    };
    try {
      fs.mkdirSync(ROOM_DIR, { recursive: true });
      fs.writeFileSync(path.join(ROOM_DIR, `${this.id}.json`), JSON.stringify(data));
    } catch (e) {
      console.warn('[save]', e.message);
    }
  }
}

// The conversation as the model sees it: earlier turns from `thread`, then `prompt`.
function buildHistory(thread, prompt) {
  const history = thread
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.status === 'done' && m.content))
    .map((m) => ({ role: m.role, content: m.content }));
  // Providers want strictly alternating turns; drop a dangling user turn.
  if (history.length && history[history.length - 1].role === 'user') history.pop();
  history.push({ role: 'user', content: prompt });
  return history;
}

function validOp(op) {
  return op.every((c) => c && typeof c.p === 'number' && c.p >= 0 &&
    ((c.t === 'i' && typeof c.s === 'string') || (c.t === 'd' && typeof c.n === 'number' && c.n > 0)));
}

// A new room, hosted by the person who created it. Restricted until they open it up.
export function createRoom(ownerId) {
  let id;
  do id = newRoomId(); while (loadRoom(id));
  const room = new Room(id, { owner: ownerId, access: 'restricted' });
  rooms.set(id, room);
  room.saveNow();
  return room;
}

// The room with this code, or null if there isn't one.
export function loadRoom(id) {
  if (!validRoomId(id)) return null;
  let room = rooms.get(id);
  if (room) return room;
  let saved;
  try { saved = JSON.parse(fs.readFileSync(path.join(ROOM_DIR, `${id}.json`), 'utf8')); } catch { return null; }
  if (!saved.owner) return null;
  room = new Room(id, saved);
  rooms.set(id, room);
  return room;
}

// Rooms someone hosts, was added to, or joined through a link, newest first.
export function roomsFor(accountId) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(ROOM_DIR).filter((f) => f.endsWith('.json')); } catch { /* no rooms yet */ }
  for (const f of files) {
    const room = loadRoom(f.slice(0, -5));
    const role = room?.roleOf(accountId);
    if (!role || room.canEnter(accountId) !== 'ok') continue;
    const updated = Math.max(room.createdAt, ...room.thread.map((m) => m.ts || 0));
    out.push({ ...room.roomInfo(), role, updated, online: room.clients.size });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// After someone edits their profile, update their name and picture in rooms they're in.
export function refreshAccount(account) {
  for (const room of rooms.values()) {
    let changed = false;
    for (const u of room.clients.values()) {
      if (u.accountId !== account.id) continue;
      Object.assign(u, { name: account.displayName, color: account.color, avatar: account.avatar });
      changed = true;
    }
    if (changed) room.broadcast({ type: 'users', users: room.userList() });
    if (room.owner === account.id) room.broadcast({ type: 'room', room: room.roomInfo() });
    room.sendShareState();
  }
}

export function saveAll() {
  for (const r of rooms.values()) r.saveNow();
}

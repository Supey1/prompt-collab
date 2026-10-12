import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DocState } from './doc.js';
import { resolveModel, getCatalog } from './providers.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
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
    this.clients = new Map(); // socket -> user
    this.generating = null;   // { controller, messageId, by }
    this.saveTimer = null;
  }

  // ---- connection lifecycle ----

  join(socket, hello) {
    const user = {
      id: crypto.randomUUID().slice(0, 8),
      name: String(hello.name || 'Anonymous').slice(0, 40),
      color: /^#[0-9a-f]{6}$/i.test(hello.color || '') ? hello.color : '#6b5bd6',
      cursor: null,
    };
    this.clients.set(socket, user);
    socket.send({
      type: 'init',
      you: user.id,
      room: { id: this.id, name: this.name, model: this.model },
      docs: Object.fromEntries(FIELDS.map((f) => [f, { text: this.docs[f].text, rev: this.docs[f].rev }])),
      thread: this.thread,
      usage: this.usage,
      users: this.userList(),
      generating: this.generating ? { messageId: this.generating.messageId, by: this.generating.by } : null,
    });
    this.broadcast({ type: 'users', users: this.userList() }, socket);
    return user;
  }

  leave(socket) {
    this.clients.delete(socket);
    this.broadcast({ type: 'users', users: this.userList() });
    if (!this.clients.size) this.saveNow();
  }

  userList() {
    return [...this.clients.values()].map(({ id, name, color, cursor }) => ({ id, name, color, cursor }));
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
      case 'profile': {
        if (msg.name) user.name = String(msg.name).slice(0, 40);
        if (/^#[0-9a-f]{6}$/i.test(msg.color || '')) user.color = msg.color;
        this.broadcast({ type: 'users', users: this.userList() });
        break;
      }
      case 'rename': {
        this.name = String(msg.name || '').slice(0, 80) || 'Untitled prompt';
        this.broadcast({ type: 'room', room: { id: this.id, name: this.name, model: this.model } });
        this.scheduleSave();
        break;
      }
      case 'model': {
        if (!resolveModel(String(msg.model || ''))) return;
        this.model = msg.model;
        this.broadcast({ type: 'room', room: { id: this.id, name: this.name, model: this.model }, by: user.name });
        this.scheduleSave();
        break;
      }
      case 'send': return this.send(socket, user);
      case 'stop': {
        if (this.generating) this.generating.controller.abort();
        break;
      }
      case 'clear': {
        if (this.generating) return;
        this.thread = [];
        this.broadcast({ type: 'thread', thread: [] });
        this.scheduleSave();
        break;
      }
    }
  }

  // ---- sending the shared prompt to a model ----

  async send(socket, user) {
    if (this.generating) return socket.send({ type: 'notice', message: 'A response is already being generated.' });
    const prompt = this.docs.prompt.text.trim();
    if (!prompt) return socket.send({ type: 'notice', message: 'The prompt is empty.' });

    if (!this.model) this.model = (await getCatalog())[0]?.id || null;
    const resolved = this.model && resolveModel(this.model);
    if (!resolved) return socket.send({ type: 'notice', message: 'Pick a model first.' });

    const userMsg = {
      id: crypto.randomUUID(), role: 'user', content: prompt, ts: Date.now(),
      sentBy: user.name, authors: [...this.contributors].slice(0, 12),
    };
    const reply = {
      id: crypto.randomUUID(), role: 'assistant', content: '', ts: Date.now(),
      model: this.model, status: 'streaming',
    };
    const history = this.thread
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.status === 'done' && m.content))
      .map((m) => ({ role: m.role, content: m.content }));
    // Providers want strictly alternating turns; drop a dangling user turn.
    if (history.length && history[history.length - 1].role === 'user') history.pop();
    history.push({ role: 'user', content: prompt });

    this.thread.push(userMsg, reply);
    this.contributors.clear();
    const controller = new AbortController();
    this.generating = { controller, messageId: reply.id, by: user.name };

    this.broadcast({ type: 'append', messages: [userMsg, reply] });
    this.broadcast({ type: 'generating', generating: { messageId: reply.id, by: user.name } });
    // Clear the shared prompt for everyone, as a normal edit so OT stays consistent.
    const cleared = this.docs.prompt.set('');
    if (cleared) this.broadcast({ type: 'op', field: 'prompt', op: cleared.op, rev: cleared.rev, by: null });

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
      else { reply.status = 'error'; reply.error = e.message; console.warn('[send]', e.message); }
    } finally {
      clearTimeout(flushTimer);
      flush();
      if (!reply.usage) reply.usage = { input: Math.round(history.reduce((n, m) => n + m.content.length, system.length) / 4), output: Math.round(reply.content.length / 4), estimated: true };
      if (reply.status === 'stopped' && !reply.content) reply.status = 'stopped';
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
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, `${this.id}.json`), JSON.stringify(data));
    } catch (e) {
      console.warn('[save]', e.message);
    }
  }
}

function validOp(op) {
  return op.every((c) => c && typeof c.p === 'number' && c.p >= 0 &&
    ((c.t === 'i' && typeof c.s === 'string') || (c.t === 'd' && typeof c.n === 'number' && c.n > 0)));
}

export function getRoom(id) {
  let room = rooms.get(id);
  if (room) return room;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${id}.json`), 'utf8')); } catch { /* new room */ }
  room = new Room(id, saved);
  rooms.set(id, room);
  return room;
}

export function saveAll() {
  for (const r of rooms.values()) r.saveNow();
}

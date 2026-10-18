import { SharedEditor } from './editor.js';
import { renderMarkdown } from './markdown.js';
import { estimateTokens } from '../shared/ot.js';
import { bindThemeToggle } from './theme.js';

const COLORS = ['#3d6bff', '#e8457c', '#13a57a', '#d98a00', '#8b5cf6', '#0e9fbf'];
const roomId = location.pathname.split('/')[2];
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  ws: null, me: null, users: [], models: [], model: null,
  generating: null, thread: [], usage: { input: 0, output: 0, requests: 0 },
  connected: false, retry: 0,
};

bindThemeToggle($('themeBtn'));

// ---------- editors ----------
const send = (msg) => { if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg)); };
const onLocalCursor = (c) => send({ type: 'cursor', ...c });
const updateTokens = () => {
  const n = estimateTokens(promptEd.doc.text) + estimateTokens(systemEd.doc.text);
  const u = state.usage;
  $('tokens').textContent = `~${n.toLocaleString()} tokens in prompt` +
    (u.requests ? `, ${(u.input + u.output).toLocaleString()} used by this room so far` : '');
  updateSendButton();
};
const promptEd = new SharedEditor($('promptEditor'), { field: 'prompt', send, onLocalCursor, onChange: updateTokens });
const systemEd = new SharedEditor($('systemEditor'), { field: 'system', send, onLocalCursor, onChange: (t) => { updateTokens(); updateSystemToggle(t); } });
const editors = { prompt: promptEd, system: systemEd };

function updateSystemToggle(text = systemEd.doc.text) {
  const open = !$('systemBox').hidden;
  $('toggleSystem').textContent = open ? 'Hide system prompt' : text.trim() ? 'System prompt (set)' : 'Add system prompt';
  $('toggleSystem').setAttribute('aria-expanded', String(open));
}
$('toggleSystem').addEventListener('click', () => {
  $('systemBox').hidden = !$('systemBox').hidden;
  updateSystemToggle();
  if (!$('systemBox').hidden) { systemEd.autosize(); systemEd.focus(); }
});

for (const ed of [promptEd, systemEd]) {
  ed.ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendPrompt(); }
  });
}

// ---------- profile ----------
function askProfile() {
  return new Promise((resolve) => {
    const existing = store.get('pc-profile');
    let color = existing?.color || COLORS[Math.floor(Math.random() * COLORS.length)];
    const sw = $('swatches');
    sw.innerHTML = COLORS.map((c) => `<button type="button" class="swatch" role="radio" style="--c:${c}" data-c="${c}" aria-label="Color ${c}" aria-checked="${c === color}"></button>`).join('');
    sw.onclick = (e) => {
      const b = e.target.closest('.swatch'); if (!b) return;
      color = b.dataset.c;
      sw.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    };
    $('nameInput').value = existing?.name || '';
    $('nameForm').onsubmit = () => {
      const p = { name: $('nameInput').value.trim().slice(0, 40) || 'Anonymous', color };
      store.set('pc-profile', p);
      resolve(p);
    };
    $('nameDialog').addEventListener('cancel', (e) => e.preventDefault());
    $('nameDialog').showModal();
  });
}

function askCode() {
  return new Promise((resolve) => {
    $('codeForm').onsubmit = () => { const c = $('codeInput').value.trim(); store.set('pc-code', c); resolve(c); };
    $('codeDialog').showModal();
  });
}

// ---------- connection ----------
let profile = store.get('pc-profile');

function setStatus(s) {
  const el = $('status');
  el.dataset.state = s;
  el.querySelector('span').textContent = { online: 'Live', connecting: 'Connecting', offline: 'Reconnecting' }[s];
}

function connect() {
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(roomId)}`);
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', name: profile.name, color: profile.color, code: store.get('pc-code') || '' }));
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.connected = false;
    setStatus('offline');
    updateSendButton();
    setTimeout(connect, Math.min(8000, 500 * 2 ** state.retry++));
  };
}

async function handle(m) {
  switch (m.type) {
    case 'auth':
      state.ws.onclose = null; state.ws.close();
      await askCode();
      return connect();
    case 'init':
      state.connected = true; state.retry = 0; setStatus('online');
      state.me = m.you;
      state.thread = m.thread; state.usage = m.usage; state.generating = m.generating;
      applyRoom(m.room);
      promptEd.reset(m.docs.prompt.text, m.docs.prompt.rev);
      systemEd.reset(m.docs.system.text, m.docs.system.rev);
      if (m.docs.system.text.trim()) { $('systemBox').hidden = false; systemEd.autosize(); }
      updateSystemToggle();
      setUsers(m.users);
      renderThread();
      updateTokens();
      break;
    case 'ack': editors[m.field]?.ack(); break;
    case 'op': editors[m.field]?.remote(m.op, m.rev, m.by); updateWriting(); break;
    case 'resync': editors[m.field]?.resync(m.text, m.rev); break;
    case 'users': setUsers(m.users); break;
    case 'cursor': {
      const u = state.users.find((x) => x.id === m.id);
      if (!u) break;
      u.cursor = m.cursor;
      for (const ed of Object.values(editors)) ed.setRemote(u.id, u, m.cursor);
      renderAvatars(); updateWriting();
      break;
    }
    case 'room': {
      const prev = state.model;
      applyRoom(m.room);
      if (m.by && prev && prev !== m.room.model) toast(`${m.by} switched the model to ${labelFor(m.room.model)}`);
      break;
    }
    case 'append':
      state.thread.push(...m.messages);
      renderThread();
      break;
    case 'delta': {
      const msg = state.thread.find((x) => x.id === m.id);
      if (msg) { msg.content += m.text; scheduleRender(msg); }
      break;
    }
    case 'done': {
      const msg = state.thread.find((x) => x.id === m.id);
      if (msg) Object.assign(msg, { status: m.status, error: m.error, usage: m.usage, content: m.content });
      if (msg) renderMessage(msg);
      break;
    }
    case 'remove':
      state.thread = state.thread.filter((x) => x.id !== m.id);
      renderThread();
      break;
    case 'thread':
      state.thread = m.thread;
      renderThread();
      if (m.clearedBy) toast(`${m.clearedBy} cleared the conversation`, { label: 'Undo', onClick: () => send({ type: 'undo-clear' }) });
      if (m.restoredBy) toast(`${m.restoredBy} brought the conversation back`);
      break;
    case 'usage': state.usage = m.usage; updateTokens(); break;
    case 'generating': state.generating = m.generating; updateSendButton(); break;
    case 'notice': toast(m.message); break;
  }
}

function applyRoom(room) {
  if (document.activeElement !== $('roomName')) $('roomName').value = room.name;
  document.title = `${room.name} · PromptCollab`;
  state.model = room.model;
  syncModelSelect();
  rememberRoom(room);
}

// Keep a short list of rooms this browser has visited, for the home page.
function rememberRoom(room) {
  const recent = (store.get('pc-recent') || []).filter((r) => r.id !== room.id);
  recent.unshift({ id: room.id, name: room.name, at: Date.now() });
  store.set('pc-recent', recent.slice(0, 8));
}

// ---------- people ----------
function setUsers(users) {
  state.users = users;
  const live = new Set(users.map((u) => u.id));
  for (const ed of Object.values(editors)) {
    ed.pruneRemotes(live);
    for (const u of users) if (u.id !== state.me) ed.setRemote(u.id, u, u.cursor);
  }
  renderAvatars();
  updateWriting();
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function renderAvatars() {
  $('avatars').innerHTML = state.users.map((u) =>
    `<span class="avatar${u.id === state.me ? ' you' : ''}" style="--c:${u.color}" title="${esc(u.name)}${u.id === state.me ? ' (you)' : ''}"${u.cursor ? ' data-active' : ''}>${esc(initials(u.name))}</span>`
  ).join('');
}

function updateWriting() {
  const names = state.users.filter((u) => u.id !== state.me && u.cursor).map((u) => u);
  const el = $('writing');
  if (!names.length) {
    el.textContent = state.users.length > 1 ? `${state.users.length} people in this room` : 'Only you so far. Copy the invite link to bring teammates in.';
    return;
  }
  const list = names.map((u) => `<span class="dot" style="--c:${u.color}"></span>${esc(u.name)}`);
  const joined = list.length === 1 ? list[0] : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  el.innerHTML = `${joined} ${names.length === 1 ? 'is' : 'are'} editing`;
}

// ---------- models ----------
async function loadModels() {
  try {
    const r = await fetch('/api/models');
    state.models = (await r.json()).models;
  } catch { state.models = []; }
  const groups = {};
  for (const m of state.models) (groups[m.providerLabel] ||= []).push(m);
  $('modelSelect').innerHTML = Object.entries(groups).map(([g, ms]) =>
    `<optgroup label="${esc(g)}">${ms.map((m) => `<option value="${esc(m.id)}">${esc(m.model)}</option>`).join('')}</optgroup>`
  ).join('') || '<option value="">No models configured</option>';
  syncModelSelect();
}

function syncModelSelect() {
  const sel = $('modelSelect');
  if (state.model && state.models.some((m) => m.id === state.model)) sel.value = state.model;
}

const labelFor = (id) => state.models.find((m) => m.id === id)?.model || id?.split(':').slice(1).join(':') || 'a model';

$('modelSelect').addEventListener('change', (e) => {
  state.model = e.target.value;
  send({ type: 'model', model: e.target.value });
});

// ---------- sending ----------
function updateSendButton() {
  const btn = $('sendBtn');
  if (state.generating) {
    btn.textContent = 'Stop';
    btn.disabled = !state.connected;
  } else {
    btn.textContent = 'Send to model';
    btn.disabled = !state.connected || !promptEd.doc.text.trim();
  }
}

function sendPrompt() {
  if (state.generating || !promptEd.doc.text.trim()) return;
  // Make sure the room uses what this person sees selected.
  const sel = $('modelSelect').value;
  if (sel && sel !== state.model) { state.model = sel; send({ type: 'model', model: sel }); }
  send({ type: 'send' });
}

$('sendBtn').addEventListener('click', () => (state.generating ? send({ type: 'stop' }) : sendPrompt()));

// ---------- thread ----------
const nodes = new Map();
let stick = true;
$('threadWrap').addEventListener('scroll', () => {
  const w = $('threadWrap');
  stick = w.scrollHeight - w.scrollTop - w.clientHeight < 80;
});

function renderThread() {
  const root = $('thread');
  nodes.clear();
  if (!state.thread.length) {
    root.innerHTML = `<div class="empty">
      <h2>One prompt, written together</h2>
      <p>Everyone who opens this room's link edits the same prompt below, live. When it's ready, anyone can send it, and the answer streams to the whole team at once.</p>
      <div class="share-row"><button class="btn ghost" type="button" data-copy-link>Copy invite link</button></div>
    </div>`;
    return;
  }
  root.innerHTML = '';
  for (const m of state.thread) renderMessage(m);
  if (state.thread.length) {
    const clear = document.createElement('div');
    clear.style.textAlign = 'center';
    clear.innerHTML = '<button class="btn ghost small" type="button" data-clear>Clear conversation</button>';
    root.appendChild(clear);
  }
  scrollDown(true);
}

function renderMessage(m) {
  let el = nodes.get(m.id);
  if (!el) {
    el = document.createElement('article');
    el.className = `msg ${m.role}`;
    nodes.set(m.id, el);
    const clearRow = $('thread').querySelector('[data-clear]')?.parentElement;
    $('thread').insertBefore(el, clearRow || null);
  }
  if (m.role === 'user') {
    const authors = (m.authors?.length ? m.authors : [m.sentBy]).filter(Boolean);
    const colorOf = (n) => state.users.find((u) => u.name === n)?.color || 'var(--ink-3)';
    el.innerHTML = `<div class="msg-meta">
        <span class="authors">${authors.map((a) => `<span class="dot" style="--c:${colorOf(a)}"></span>`).join('')}
        Written by <span class="who">${esc(joinNames(authors))}</span></span>
        ${m.sentBy && !(authors.length === 1 && authors[0] === m.sentBy) ? `<span>sent by ${esc(m.sentBy)}</span>` : ''}
      </div>
      <div class="bubble">${esc(m.content)}</div>
      <div class="msg-actions"><button type="button" data-edit="${m.id}">Edit &amp; resend</button></div>`;
  } else {
    const streaming = m.status === 'streaming';
    const u = m.usage;
    const isLast = state.thread[state.thread.length - 1] === m;
    const actions = streaming ? '' : `<div class="msg-actions">
        ${m.content ? `<button type="button" data-copy-msg="${m.id}">Copy</button>` : ''}
        ${isLast ? `<button type="button" data-regenerate>Regenerate</button>` : ''}
      </div>`;
    el.innerHTML = `<div class="msg-meta"><span class="model-tag">${esc(labelFor(m.model))}</span></div>
      <div class="body">${renderMarkdown(m.content)}${streaming ? '<span class="cursor-blink" aria-hidden="true"></span>' : ''}</div>
      ${m.status === 'error' ? `<div class="msg-error">The model returned an error: ${esc(m.error)}</div>` : ''}
      ${m.status === 'stopped' ? '<div class="msg-foot">Stopped before finishing.</div>' : ''}
      ${!streaming && u ? `<div class="msg-foot">${u.estimated ? '~' : ''}${u.input.toLocaleString()} tokens in, ${u.output.toLocaleString()} out</div>` : ''}
      ${actions}`;
  }
  scrollDown();
}

const joinNames = (a) => (a.length <= 1 ? a[0] || 'someone' : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

let raf = null;
function scheduleRender(msg) {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = null; renderMessage(msg); });
}

function scrollDown(force) {
  if (!force && !stick) return;
  const w = $('threadWrap');
  w.scrollTop = w.scrollHeight;
}

$('thread').addEventListener('click', async (e) => {
  if (e.target.closest('[data-copy-link]')) return copyLink();
  if (e.target.closest('[data-clear]')) return send({ type: 'clear' });
  if (e.target.closest('[data-regenerate]')) return send({ type: 'regenerate' });
  const copyMsg = e.target.closest('[data-copy-msg]');
  if (copyMsg) {
    const m = state.thread.find((x) => x.id === copyMsg.dataset.copyMsg);
    try { await navigator.clipboard.writeText(m.content); copyMsg.textContent = 'Copied'; }
    catch { copyMsg.textContent = 'Copy failed'; }
    setTimeout(() => { copyMsg.textContent = 'Copy'; }, 1200);
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) return editAndResend(state.thread.find((x) => x.id === edit.dataset.edit));
  const copy = e.target.closest('.copy-code');
  if (copy) {
    await navigator.clipboard?.writeText(copy.parentElement.querySelector('code').textContent);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
  }
});

// Put an earlier prompt back in the shared editor so the team can tweak it.
function editAndResend(m) {
  if (!m) return;
  const current = promptEd.doc.text;
  if (current.trim() && current !== m.content && !confirm('Replace what is in the prompt box right now with this earlier prompt?')) return;
  promptEd.ta.value = m.content;
  promptEd.onInput(); // sends the change to everyone, like typing it
  promptEd.focus();
  promptEd.ta.setSelectionRange(m.content.length, m.content.length);
}

// ---------- misc ----------
async function copyLink() {
  try { await navigator.clipboard.writeText(location.href); toast('Invite link copied'); }
  catch { toast(location.href); }
}
$('shareBtn').addEventListener('click', copyLink);

let renameTimer = null;
$('roomName').addEventListener('input', () => {
  clearTimeout(renameTimer);
  renameTimer = setTimeout(() => send({ type: 'rename', name: $('roomName').value }), 400);
});
$('roomName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

// A short message at the top of the page, optionally with one button (like Undo).
function toast(text, action) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = () => { action.onClick(); t.remove(); };
    t.appendChild(b);
  }
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), action ? 10000 : 3200);
}

// ---------- start ----------
(async () => {
  updateSendButton();
  loadModels();
  if (!profile) profile = await askProfile();
  connect();
})();

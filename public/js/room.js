import { SharedEditor } from './editor.js';
import { renderMarkdown } from './markdown.js';
import { estimateTokens } from '../shared/ot.js';
import { bindThemeToggle } from './theme.js';
import { avatarContent } from './avatar.js';

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
  account: null, room: null, share: null, // you, the room's sharing settings, the host's Share panel
};
const isHost = () => state.account && state.room && state.account.id === state.room.owner;

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

function askCode() {
  return new Promise((resolve) => {
    $('codeForm').onsubmit = () => { const c = $('codeInput').value.trim(); store.set('pc-code', c); resolve(c); };
    $('codeDialog').showModal();
  });
}

// ---------- connection ----------
const toSignIn = () => location.replace(`/signin?next=${encodeURIComponent(location.pathname)}`);

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
  // Who you are comes from your sign-in cookie, which the browser sends automatically.
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', code: store.get('pc-code') || '' }));
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
    case 'signin':
      state.ws.onclose = null; state.ws.close();
      return toSignIn();
    case 'denied': // not allowed in, or the host just removed you
      state.ws.onclose = null; state.ws.close();
      $('shareDialog').close();
      return showGate(m.reason, m.hostName, m.message);
    case 'share': state.share = m; renderShare(); break;
    case 'auth':
      state.ws.onclose = null; state.ws.close();
      await askCode();
      return connect();
    case 'init':
      state.connected = true; state.retry = 0; setStatus('online');
      state.me = m.you;
      state.account = m.account;
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
      const prev = state.room;
      applyRoom(m.room);
      if (m.by && prev?.model && prev.model !== m.room.model) toast(`${m.by} switched the model to ${labelFor(m.room.model)}`);
      if (prev && prev.access !== m.room.access && !isHost()) {
        toast(m.room.access === 'open' ? `${m.room.hostName} opened this room to anyone with the link` : `${m.room.hostName} made this room restricted`);
      }
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
    case 'notice':
      toast(m.message, m.action && { label: m.action.label, onClick: () => window.open(m.action.href, '_blank', 'noopener') });
      break;
  }
}

function applyRoom(room) {
  state.room = room;
  if (document.activeElement !== $('roomName')) $('roomName').value = room.name;
  document.title = `${room.name} · PromptCollab`;
  state.model = room.model;
  syncModelSelect();
  const tag = $('accessTag');
  tag.hidden = false;
  tag.textContent = room.access === 'open' ? 'Anyone with the link' : 'Restricted';
  tag.title = isHost() ? 'You host this room' : `Hosted by ${room.hostName}`;
  $('shareBtn').textContent = isHost() ? 'Share' : 'Copy invite link';
  $('shareBtn').classList.toggle('ghost', !isHost());
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

function renderAvatars() {
  $('avatars').innerHTML = state.users.map((u) =>
    `<span class="avatar${u.id === state.me ? ' you' : ''}" style="--c:${u.color}" title="${esc(u.name)}${u.id === state.me ? ' (you)' : ''}"${u.cursor ? ' data-active' : ''}>${avatarContent(u)}</span>`
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
  syncModelSelect();
}

// The menu lists the models your own keys unlock. If the room uses a model you
// have no key for, it still shows (so you can see what's picked), marked as such.
const ADD_KEY = '__add-key';
function syncModelSelect() {
  const groups = {};
  for (const m of state.models) (groups[m.providerLabel] ||= []).push(m);
  let html = Object.entries(groups).map(([g, ms]) =>
    `<optgroup label="${esc(g)}">${ms.map((m) => `<option value="${esc(m.id)}">${esc(m.model)}</option>`).join('')}</optgroup>`
  ).join('');
  if (state.model && !state.models.some((m) => m.id === state.model)) {
    const [provider, ...rest] = state.model.split(':');
    const label = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', openrouter: 'OpenRouter' }[provider] || provider;
    html = `<option value="${esc(state.model)}">${esc(rest.join(':'))} (needs your ${esc(label)} key)</option>` + html;
  }
  html += `<option value="${ADD_KEY}">+ Add an API key…</option>`;
  const sel = $('modelSelect');
  sel.innerHTML = html;
  if (state.model) sel.value = state.model;
}

// Coming back from adding a key in another tab: show the new models.
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadModels(); });

const labelFor = (id) => state.models.find((m) => m.id === id)?.model || id?.split(':').slice(1).join(':') || 'a model';

$('modelSelect').addEventListener('change', (e) => {
  if (e.target.value === ADD_KEY) {
    // Open the keys page in a new tab so you don't lose your place in the room.
    window.open('/keys', '_blank', 'noopener');
    syncModelSelect();
    return;
  }
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
  if (sel && sel !== ADD_KEY && sel !== state.model) { state.model = sel; send({ type: 'model', model: sel }); }
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
    copyMsg.textContent = (await copyText(m.content)) ? 'Copied' : 'Copy failed';
    setTimeout(() => { copyMsg.textContent = 'Copy'; }, 1200);
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) return editAndResend(state.thread.find((x) => x.id === edit.dataset.edit));
  const copy = e.target.closest('.copy-code');
  if (copy) {
    copy.textContent = (await copyText(copy.parentElement.querySelector('code').textContent)) ? 'Copied' : 'Copy failed';
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
// Copy text to the clipboard. Browsers (Safari especially) only allow this
// right after a click, so nothing here waits on the network first. The older
// execCommand copy goes first because it also works on plain http://
// network addresses, where navigator.clipboard doesn't exist.
function copyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  const focused = document.activeElement;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS Safari ignores select()
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
  ta.remove();
  focused?.focus?.();
  if (ok) return Promise.resolve(true);
  if (!navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(() => true, () => false);
}

// A localhost link only works on this computer, so invites use the network
// address instead. Looked up when the page loads, so copying stays instant.
let networkUrl = null;
const onThisComputerOnly = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (onThisComputerOnly) {
  fetch('/api/config').then((r) => r.json()).then((c) => { networkUrl = c.lanUrls?.[0] || null; }).catch(() => {});
}

function inviteLink() {
  if (onThisComputerOnly && networkUrl) return networkUrl + location.pathname;
  return location.href;
}

async function copyLink() {
  const link = inviteLink();
  if (!(await copyText(link))) {
    prompt('Copying was blocked by the browser. Copy this invite link:', link);
    return;
  }
  const localOnly = onThisComputerOnly && !networkUrl;
  toast(localOnly ? `Copied ${link} (only works on this computer)` : `Invite link copied: ${link}`);
}
$('shareBtn').addEventListener('click', () => (isHost() ? openShare() : copyLink()));

// ---------- no access ----------
// Shown instead of the room: it doesn't exist, it's restricted, or the host removed you.
let gatePoll = null;
function showGate(reason, hostName = 'the host', message) {
  clearInterval(gatePoll);
  document.querySelector('.room').hidden = true;
  $('gate').hidden = false;
  const home = '<a class="btn ghost" href="/">Back to home</a>';
  const ask = '<button class="btn" type="button" id="askAccess">Ask for access</button>';
  if (reason === 'missing') {
    $('gateTitle').textContent = "This room doesn't exist";
    $('gateText').textContent = 'Check the link with whoever sent it. The room may have a different code.';
    $('gateActions').innerHTML = home;
    return;
  }
  $('gateTitle').textContent = reason === 'removed' ? "You've been removed from this room" : 'You need access';
  $('gateText').textContent = reason === 'removed'
    ? (message || `${hostName} removed you from this room.`) + ' You can ask to be let back in.'
    : `This room is restricted. Ask ${hostName}, who hosts it, to let you in.`;
  $('gateActions').innerHTML = ask + home;
  $('askAccess').addEventListener('click', requestAccess);
}

async function requestAccess() {
  $('askAccess').disabled = true;
  try {
    await fetch(`/api/rooms/${encodeURIComponent(roomId)}/request`, { method: 'POST' });
    $('askAccess').remove();
    $('gateOk').textContent = "Request sent. You'll be let in automatically when the host adds you.";
    waitForAccess();
  } catch {
    $('askAccess').disabled = false;
    toast("Couldn't reach the server. Try again.");
  }
}

// After asking, check every few seconds and walk in as soon as the host says yes.
function waitForAccess() {
  clearInterval(gatePoll);
  gatePoll = setInterval(async () => {
    const access = await checkAccess().catch(() => null);
    if (access?.access === 'ok') { clearInterval(gatePoll); location.reload(); }
  }, 4000);
}

async function checkAccess() {
  return (await fetch(`/api/rooms/${encodeURIComponent(roomId)}`)).json();
}

// ---------- Share panel (host only) ----------
function openShare() {
  renderShare();
  $('shareDialog').showModal();
  $('shareUsername').focus();
}
$('shareClose').addEventListener('click', () => $('shareDialog').close());
$('shareDone').addEventListener('click', () => $('shareDialog').close());
$('shareCopy').addEventListener('click', copyLink);

const shareAction = (action, extra) => send({ type: 'share', action, ...extra });

$('shareAddForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const username = $('shareUsername').value.trim();
  if (!username) return;
  shareAction('add', { username });
  $('shareUsername').value = '';
});
$('accessSelect').addEventListener('change', (e) => shareAction('access', { access: e.target.value }));
$('shareDialog').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-share]');
  if (!b) return;
  if (b.dataset.share === 'remove' && !confirm(`Remove ${b.dataset.name} from this room? They'll be disconnected and can't come back unless you add them again.`)) return;
  shareAction(b.dataset.share, { userId: b.dataset.id });
});

function sharePerson(u, tag, buttons = []) {
  return `<li>
    <span class="avatar" style="--c:${u.color}">${avatarContent(u)}</span>
    <span class="who"><strong>${esc(u.displayName)}${u.id === state.account?.id ? ' (you)' : ''}${u.online ? '<span class="online-dot" title="In the room now"></span>' : ''}</strong><span>@${esc(u.username)}</span></span>
    ${tag ? `<span class="tag">${tag}</span>` : ''}
    <span class="actions">${buttons.map(([label, action, cls = 'ghost']) =>
      `<button class="btn ${cls} small" type="button" data-share="${action}" data-id="${u.id}" data-name="${esc(u.displayName)}">${label}</button>`).join('')}</span>
  </li>`;
}

function renderShare() {
  const s = state.share;
  if (!s) return;
  $('shareTitle').textContent = `Share “${state.room?.name || 'this room'}”`;
  $('shareContacts').innerHTML = s.contacts.length
    ? '<span class="chips-label">Your contacts:</span>' + s.contacts.map((c) =>
      `<button class="chip" type="button" data-share="add" data-id="${c.id}"><span class="avatar" style="--c:${c.color}">${avatarContent(c)}</span>${esc(c.displayName)}</button>`).join('')
    : '';
  $('shareRequestsBlock').hidden = !s.requests.length;
  $('shareRequests').innerHTML = s.requests.map((u) => sharePerson(u, '', [['Let in', 'add', ''], ['Dismiss', 'dismiss']])).join('');
  $('sharePeople').innerHTML = [
    s.host && sharePerson(s.host, 'Host'),
    ...s.members.map((u) => sharePerson(u, '', [['Remove', 'remove']])),
    ...s.visitors.map((u) => sharePerson(u, 'Joined with link', [['Remove', 'remove']])),
  ].filter(Boolean).join('');
  $('shareRemovedBlock').hidden = !s.removed.length;
  $('shareRemoved').innerHTML = s.removed.map((u) => sharePerson(u, '', [['Allow back', 'allow-back']])).join('');
  $('accessSelect').value = s.access;
  $('accessIcon').innerHTML = s.access === 'open'
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  $('accessIcon').dataset.access = s.access;
  $('accessHint').textContent = s.access === 'open'
    ? 'Anyone who is signed in and has the link can join.'
    : 'Only you and people you add can open this room.';
}

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
  // Check access first, so people without it see why instead of a blank room.
  const access = await checkAccess().catch(() => null);
  if (access?.access === 'signin') return toSignIn();
  if (access && access.access !== 'ok') {
    showGate(access.exists ? access.access : 'missing', access.hostName);
    if (access.requested) {
      $('askAccess')?.remove();
      $('gateOk').textContent = "You've asked to join. You'll be let in automatically when the host adds you.";
      waitForAccess();
    }
    return;
  }
  connect();
})();

import { bindThemeToggle } from './theme.js';
import { estimateTokens } from '../shared/ot.js';
import { avatarContent } from './avatar.js';

bindThemeToggle(document.getElementById('themeBtn'));

// Header: Sign in / Sign up buttons, or who you're signed in as.
showAccount();
async function showAccount() {
  const el = document.getElementById('account');
  let user = null;
  try { ({ user } = await (await fetch('/api/me')).json()); } catch { /* offline: show sign-in buttons */ }
  if (!user) {
    el.innerHTML = '<a class="btn ghost small" href="/signin">Sign in</a><a class="btn small" href="/signup">Sign up</a>';
    return;
  }
  const badge = user.requests ? `<span class="badge" title="${user.requests} contact request${user.requests > 1 ? 's' : ''}">${user.requests}</span>` : '';
  el.innerHTML = `<a class="me" href="/account${user.requests ? '#contacts' : ''}" title="Your account (@${esc(user.username)})">
      <span class="avatar" style="--c:${user.color};margin:0">${avatarContent(user)}</span>${badge}
      <span class="name">${esc(user.displayName)}</span>
    </a>
    <button class="btn ghost small" type="button" id="signOut">Sign out</button>`;
  showMyRooms();
  document.getElementById('signOut').addEventListener('click', async () => {
    await fetch('/api/signout', { method: 'POST' }).catch(() => {});
    location.reload();
  });
}

// "Join a room": accept a full invite link or just the room code.
const joinDialog = document.getElementById('joinDialog');
const joinInput = document.getElementById('joinInput');
const joinError = document.getElementById('joinError');
document.getElementById('joinBtn').addEventListener('click', () => {
  joinError.textContent = '';
  joinInput.value = '';
  joinDialog.showModal();
});
document.getElementById('joinCancel').addEventListener('click', () => joinDialog.close());
document.getElementById('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = joinInput.value.trim();
  // Take the part after "/r/" if it's a link, otherwise use the text as the code.
  const id = (raw.match(/\/r\/([^/?#\s]+)/)?.[1] || raw).toLowerCase();
  if (!raw) return (joinError.textContent = 'Paste a link or type a room code.');
  if (!/^[a-z0-9-]{3,40}$/.test(id)) return (joinError.textContent = "That doesn't look like a room link or code.");
  joinError.textContent = 'Checking…';
  try {
    const { exists } = await (await fetch(`/api/rooms/${encodeURIComponent(id)}`)).json();
    if (!exists) return (joinError.textContent = 'No room found with that code. Check it with whoever invited you.');
  } catch {
    return (joinError.textContent = "Couldn't reach the server. Try again.");
  }
  location.href = `/r/${id}`;
});

// Rooms you host, were added to, or joined through a link, newest first.
async function showMyRooms() {
  let rooms = [];
  try { ({ rooms } = await (await fetch('/api/my-rooms')).json()); } catch { return; }
  if (!rooms?.length) return;
  const ago = (t) => {
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
    return `${Math.round(min / 60 / 24)} days ago`;
  };
  document.getElementById('recentList').innerHTML = rooms.map((r) => {
    const who = r.role === 'host' ? 'You host' : `Hosted by ${esc(r.hostName)}`;
    const access = r.access === 'open' ? 'Anyone with the link' : 'Restricted';
    return `<li><span class="room-line"><a href="/r/${encodeURIComponent(r.id)}">${esc(r.name || 'Untitled prompt')}</a>
      <span class="room-meta">${who} · ${access}${r.online ? ` · <span class="online-dot"></span> ${r.online} here now` : ''}</span></span>
      <span>${ago(r.updated)}</span></li>`;
  }).join('');
  document.getElementById('recent').hidden = false;
}

// Scripted demo: two teammates co-writing one prompt.
const el = document.getElementById('demo');
const tokens = document.getElementById('demoTokens');
const people = {
  ana: { name: 'Ana', color: '#3d6bff', pos: 0 },
  ben: { name: 'Ben', color: '#e8457c', pos: 0 },
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const script = [
  ['ana', 'type', 'Refactor src/auth/middleware.ts so token checks run once per request.'],
  ['ben', 'end'],
  ['ben', 'type', '\n\nConstraints:\n- keep the public API the same\n- add tests for expired tokens'],
  ['ana', 'find', 'once per request'],
  ['ana', 'type', ' and cache the decoded user'],
  ['ben', 'type', '\n- explain each change in one line'],
];

let text = '';
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));

function render() {
  const marks = Object.values(people).filter((p) => p.shown).sort((a, b) => a.pos - b.pos);
  let html = '', last = 0;
  for (const p of marks) {
    html += esc(text.slice(last, p.pos));
    html += `<span class="caret" style="--c:${p.color}" data-name="${p.name}">⁠</span>`;
    last = p.pos;
  }
  el.innerHTML = html + esc(text.slice(last));
  tokens.textContent = `~${estimateTokens(text)} tokens`;
}

function insert(who, s) {
  const p = people[who];
  text = text.slice(0, p.pos) + s + text.slice(p.pos);
  for (const other of Object.values(people)) if (other !== p && other.pos >= p.pos) other.pos += s.length;
  p.pos += s.length;
}

async function run() {
  for (;;) {
    text = '';
    for (const p of Object.values(people)) { p.pos = 0; p.shown = false; }
    render();
    await wait(600);
    for (const [who, action, arg] of script) {
      const p = people[who];
      p.shown = true;
      if (action === 'end') { p.pos = text.length; render(); await wait(500); continue; }
      if (action === 'find') { p.pos = text.indexOf(arg) + arg.length; render(); await wait(600); continue; }
      if (reduce) { insert(who, arg); render(); continue; }
      for (const ch of arg) {
        insert(who, ch);
        render();
        await wait(ch === '\n' ? 160 : 28 + Math.random() * 40);
      }
      await wait(500);
    }
    if (reduce) return;
    await wait(4000);
  }
}
run();

import { bindThemeToggle } from './theme.js';
import { avatarContent } from './avatar.js';
import { setupProfileEditor, setErrors } from './profile-editor.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
bindThemeToggle($('themeBtn'));

async function api(url, body) {
  try {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    if (r.status === 401) location.href = '/signin?next=/account';
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: "Couldn't reach the server. Try again." } };
  }
}

// Show a message briefly in one of the green/red lines under a form.
function say(id, text) {
  $(id).textContent = text || '';
  if (text && id.endsWith('Ok')) setTimeout(() => { if ($(id).textContent === text) $(id).textContent = ''; }, 4000);
}

const { ok, data } = await api('/api/account');
if (!ok) throw new Error('Could not load account');
$('signedInAs').textContent = `Signed in as @${data.user.username}`;

// ---------- profile ----------
const editor = setupProfileEditor(data.user);
$('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  say('profileOk'); say('profileError');
  const errors = {};
  if (!$('displayName').value.trim()) errors.displayName = 'Enter a display name.';
  if (editor.mode === 'picture' && !editor.picture) errors.avatar = 'Choose a picture, or switch to Letter.';
  setErrors(errors, $('profileForm'));
  if (Object.keys(errors).length) return;
  const res = await api('/api/account/profile', {
    displayName: $('displayName').value.trim(),
    color: editor.color,
    avatarMode: editor.mode,
    avatar: editor.changedPicture ? editor.picture : null, // null keeps the current picture
  });
  if (res.ok) {
    editor.changedPicture = false;
    say('profileOk', 'Saved. Rooms you have open update right away.');
  } else if (res.data.field) setErrors({ [res.data.field]: res.data.error }, $('profileForm'));
  else say('profileError', res.data.error || 'Something went wrong.');
});

// ---------- password ----------
$('showPassword').addEventListener('change', (e) => {
  for (const id of ['current', 'newPassword', 'confirmNew']) $(id).type = e.target.checked ? 'text' : 'password';
});
$('passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  say('passwordOk'); say('passwordError');
  const errors = {};
  if (!$('current').value) errors.current = 'Enter your current password.';
  if ($('newPassword').value.length < 8) errors.newPassword = 'Use at least 8 characters.';
  if ($('confirmNew').value !== $('newPassword').value) errors.confirmNew = "Passwords don't match.";
  setErrors(errors, $('passwordForm'));
  if (Object.keys(errors).length) return;
  const res = await api('/api/account/password', { current: $('current').value, password: $('newPassword').value });
  if (res.ok) {
    e.target.reset();
    say('passwordOk', 'Password changed. Any other devices were signed out.');
  } else if (res.data.field) setErrors({ [res.data.field]: res.data.error }, $('passwordForm'));
  else say('passwordError', res.data.error || 'Something went wrong.');
});

// ---------- contacts ----------
function person(u, buttons) {
  return `<li>
    <span class="avatar" style="--c:${u.color}">${avatarContent(u)}</span>
    <span class="who"><strong>${esc(u.displayName)}</strong><span>@${esc(u.username)}</span></span>
    <span class="actions">${buttons.map(([label, action, cls = 'ghost']) =>
      `<button class="btn ${cls} small" type="button" data-action="${action}" data-id="${u.id}">${label}</button>`).join('')}</span>
  </li>`;
}

function renderContacts({ contacts, incoming, outgoing }) {
  $('incomingBlock').hidden = !incoming.length;
  $('incomingList').innerHTML = incoming.map((u) => person(u, [['Accept', 'accept', ''], ['Decline', 'remove']])).join('');
  $('contactList').innerHTML = contacts.map((u) => person(u, [['Remove', 'remove']])).join('') ||
    '<li class="empty-row">No contacts yet. Send a request to someone by their username.</li>';
  $('outgoingBlock').hidden = !outgoing.length;
  $('outgoingList').innerHTML = outgoing.map((u) => person(u, [['Cancel', 'remove']])).join('');
}
renderContacts(data);
if (location.hash === '#contacts') $('contacts').scrollIntoView();

$('contactForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  say('contactOk'); say('contactError');
  const username = $('contactUsername').value.trim();
  if (!username) return say('contactError', 'Type their username.');
  const res = await api('/api/contacts/request', { username });
  if (res.data.contacts) renderContacts(res.data);
  if (res.ok) { $('contactUsername').value = ''; say('contactOk', res.data.message); }
  else say('contactError', res.data.error || 'Something went wrong.');
});

$('contacts').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  if (b.textContent === 'Remove' && !confirm('Remove this contact?')) return;
  b.disabled = true;
  const res = await api(`/api/contacts/${b.dataset.action}`, { userId: b.dataset.id });
  if (res.data.contacts) renderContacts(res.data);
  if (res.data.message) say('contactOk', res.data.message);
  if (!res.ok) say('contactError', res.data.error || 'Something went wrong.');
});

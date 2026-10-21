import { bindThemeToggle } from './theme.js';
import { setupProfileEditor, setErrors } from './profile-editor.js';

// Runs both the sign-up and the sign-in page.
const $ = (id) => document.getElementById(id);
bindThemeToggle($('themeBtn'));

// Where to go after signing in, e.g. the room an invite link pointed to.
const next = new URLSearchParams(location.search).get('next');
const goTo = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
if (next) $('switchLink').href += `?next=${encodeURIComponent(next)}`;

// "Show password" switches every password box on the page between dots and text.
$('showPassword').addEventListener('change', (e) => {
  for (const id of ['password', 'confirm']) if ($(id)) $(id).type = e.target.checked ? 'text' : 'password';
});

async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: "Couldn't reach the server. Check your connection and try again." } };
  }
}

async function submitting(form, label, work) {
  const btn = form.querySelector('[type=submit]');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await work(); } finally { btn.disabled = false; btn.textContent = original; }
}

// ---------- sign in ----------
if ($('signinForm')) {
  if (next?.startsWith('/r/')) $('signinReason').textContent = 'Sign in to join this room.';
  $('signinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('formError').textContent = '';
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) { $('formError').textContent = 'Enter your username and password.'; return; }
    submitting(e.target, 'Signing in…', async () => {
      const { ok, data } = await post('/api/signin', { username, password });
      if (ok) location.href = goTo;
      else $('formError').textContent = data.error || 'Something went wrong. Try again.';
    });
  });
}

// ---------- sign up ----------
if ($('signupForm')) {
  const editor = setupProfileEditor();

  $('signupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('formError').textContent = '';
    const values = {
      username: $('username').value.trim(),
      displayName: $('displayName').value.trim(),
      password: $('password').value,
      color: editor.color,
      avatar: editor.mode === 'picture' ? editor.picture : null,
    };
    // Same rules as the server, checked here first so mistakes show up instantly.
    const errors = {};
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(values.username)) errors.username = 'Use 3–20 letters, numbers, dots, dashes or underscores.';
    if (!values.displayName) errors.displayName = 'Enter a display name.';
    if (values.password.length < 8) errors.password = 'Use at least 8 characters.';
    if ($('confirm').value !== values.password) errors.confirm = "Passwords don't match.";
    if (editor.mode === 'picture' && !editor.picture) errors.avatar = 'Choose a picture, or switch to Letter.';
    setErrors(errors);
    if (Object.keys(errors).length) return;

    submitting(e.target, 'Creating account…', async () => {
      const { ok, data } = await post('/api/signup', values);
      if (ok) { location.href = goTo; return; }
      if (data.field) setErrors({ [data.field]: data.error });
      else $('formError').textContent = data.error || 'Something went wrong. Try again.';
    });
  });
}

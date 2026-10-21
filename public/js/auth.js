import { bindThemeToggle } from './theme.js';
import { firstLetter } from './avatar.js';

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

function setErrors(errors) {
  document.querySelectorAll('.field-error').forEach((el) => { el.textContent = errors[el.dataset.for] || ''; });
  document.querySelectorAll('input[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  for (const field of Object.keys(errors)) $(field)?.setAttribute('aria-invalid', 'true');
  const first = Object.keys(errors).find((f) => $(f));
  if (first) $(first).focus();
}

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
  const COLORS = ['#3d6bff', '#e8457c', '#13a57a', '#d98a00', '#8b5cf6', '#0e9fbf', '#e4572e', '#4a5468'];
  const state = { mode: 'letter', color: COLORS[Math.floor(Math.random() * COLORS.length)], picture: null };

  // Color swatches, plus a rainbow one that opens the system color picker for any color.
  $('colorSwatches').innerHTML = COLORS.map((c) =>
    `<button type="button" class="swatch" role="radio" style="--c:${c}" data-c="${c}" aria-label="Color ${c}"></button>`
  ).join('') + `<label class="swatch custom" title="Any color"><input type="color" id="customColor" aria-label="Choose any color"></label>`;
  $('colorSwatches').addEventListener('click', (e) => {
    const b = e.target.closest('button.swatch');
    if (b) { state.color = b.dataset.c; render(); }
  });
  $('customColor').addEventListener('input', (e) => { state.color = e.target.value; render(); });

  document.querySelectorAll('input[name=avatarMode]').forEach((r) => r.addEventListener('change', () => {
    state.mode = document.querySelector('input[name=avatarMode]:checked').value;
    render();
  }));
  $('displayName').addEventListener('input', render);

  $('avatarFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      state.picture = await shrinkPicture(file);
      $('fileName').textContent = file.name;
      setErrors({});
    } catch {
      state.picture = null;
      setErrors({ avatar: "That file couldn't be read as a picture. Try a PNG or JPG." });
    }
    render();
  });

  // Live preview of what teammates will see.
  function render() {
    $('pictureControls').hidden = state.mode !== 'picture';
    const preview = $('avatarPreview');
    preview.style.setProperty('--c', state.color);
    preview.classList.toggle('empty', state.mode === 'picture' && !state.picture);
    if (state.mode === 'picture') {
      preview.innerHTML = state.picture ? `<img src="${state.picture}" alt="">` : 'No picture';
    } else {
      preview.textContent = firstLetter($('displayName').value);
    }
    const custom = !COLORS.includes(state.color);
    document.querySelectorAll('#colorSwatches button.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.c === state.color)));
    const customSwatch = document.querySelector('.swatch.custom');
    customSwatch.setAttribute('aria-checked', String(custom));
    customSwatch.style.setProperty('--c', custom ? state.color : 'transparent');
    $('customColor').value = state.color;
  }
  render();

  $('signupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('formError').textContent = '';
    const values = {
      username: $('username').value.trim(),
      displayName: $('displayName').value.trim(),
      password: $('password').value,
      color: state.color,
      avatar: state.mode === 'picture' ? state.picture : null,
    };
    // Same rules as the server, checked here first so mistakes show up instantly.
    const errors = {};
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(values.username)) errors.username = 'Use 3–20 letters, numbers, dots, dashes or underscores.';
    if (!values.displayName) errors.displayName = 'Enter a display name.';
    if (values.password.length < 8) errors.password = 'Use at least 8 characters.';
    if ($('confirm').value !== values.password) errors.confirm = "Passwords don't match.";
    if (state.mode === 'picture' && !state.picture) errors.avatar = 'Choose a picture, or switch to Letter.';
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

// Crop a picture to a centered square and shrink it to 160×160, so uploads stay small.
async function shrinkPicture(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const size = 160;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // JPEG has no transparency
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}

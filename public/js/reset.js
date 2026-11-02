import { bindThemeToggle } from './theme.js';
import { setErrors } from './profile-editor.js';

const $ = (id) => document.getElementById(id);
bindThemeToggle($('themeBtn'));

$('showPassword').addEventListener('change', (e) => {
  for (const id of ['password', 'confirm']) $(id).type = e.target.checked ? 'text' : 'password';
});

$('resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('formError').textContent = '';
  const values = { username: $('username').value.trim(), code: $('code').value.trim(), password: $('password').value };
  const errors = {};
  if (!values.username) errors.username = 'Enter your username.';
  if (!values.code) errors.code = 'Enter one of your recovery codes.';
  if (values.password.length < 8) errors.password = 'Use at least 8 characters.';
  if ($('confirm').value !== values.password) errors.confirm = "Passwords don't match.";
  setErrors(errors, e.target);
  if (Object.keys(errors).length) return;

  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const r = await fetch('/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const left = data.recoveryCodesLeft;
      $('doneText').textContent = left
        ? `You're signed in. That code is now used up; you have ${left} recovery code${left === 1 ? '' : 's'} left.`
        : "You're signed in. That was your last recovery code, so make new ones on your account page.";
      $('resetCard').hidden = true;
      $('doneCard').hidden = false;
      $('doneCard').querySelector('h1').focus();
    } else if (data.field) setErrors({ [data.field]: data.error }, e.target);
    else $('formError').textContent = data.error || 'Something went wrong. Try again.';
  } catch {
    $('formError').textContent = "Couldn't reach the server. Try again.";
  } finally {
    btn.disabled = false;
  }
});

import { bindThemeToggle } from './theme.js';

// The "This site is private" page, shown at whatever address was opened.
// After the right code, reload that same address (e.g. the room an invite pointed to).
const $ = (id) => document.getElementById(id);
bindThemeToggle($('themeBtn'));

$('showCode').addEventListener('click', (e) => {
  const show = $('code').type === 'password';
  $('code').type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? 'Hide' : 'Show';
  e.currentTarget.setAttribute('aria-pressed', String(show));
});

$('accessForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('formError').textContent = '';
  const code = $('code').value.trim();
  if (!code) { $('formError').textContent = 'Enter the access code.'; return; }
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const r = await fetch('/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const data = await r.json().catch(() => ({}));
    if (r.ok) { location.reload(); return; }
    $('formError').textContent = data.error || 'Something went wrong. Try again.';
    $('code').select();
  } catch {
    $('formError').textContent = "Couldn't reach the server. Try again.";
  } finally {
    btn.disabled = false;
  }
});
$('code').focus();

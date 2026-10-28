import { bindThemeToggle } from './theme.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
bindThemeToggle($('themeBtn'));

const BLURB = {
  openrouter: 'One key for hundreds of models (GPT, Claude, Gemini, Llama, DeepSeek and more), some free. The easiest place to start.',
  openai: 'GPT models, straight from OpenAI.',
  anthropic: 'Claude models, straight from Anthropic.',
  google: 'Gemini models, from Google AI Studio.',
};

async function api(url, body) {
  try {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    if (r.status === 401) location.href = '/signin?next=/keys';
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: "Couldn't reach the server. Try again." } };
  }
}

let page = null;
let editing = new Set(); // providers whose "Replace" box is open

function render() {
  $('insecure').hidden = page.secure;
  $('providers').innerHTML = page.providers.map((p) => {
    const saved = p.saved;
    const showForm = !saved || editing.has(p.name);
    const added = saved && new Date(saved.addedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return `<section class="auth-card key-card" data-provider="${p.name}" aria-labelledby="h-${p.name}">
      <div class="key-head">
        <h2 id="h-${p.name}">${esc(p.label)}${p.name === 'openrouter' ? ' <span class="pill">Recommended</span>' : ''}</h2>
        ${saved ? `<span class="key-state ${saved.readable ? 'ok' : 'bad'}">${saved.readable ? 'Saved' : 'Needs re-entering'}</span>` : '<span class="key-state">Not added</span>'}
      </div>
      <p class="hint">${esc(BLURB[p.name] || '')}</p>
      ${saved ? `<p class="key-saved">Key ending in <code>…${esc(saved.last4)}</code> · added ${esc(added)}
        ${saved.readable ? '' : '<br><span class="field-error">This key can no longer be read (the server\'s encryption secret changed). Paste it again.</span>'}</p>` : ''}
      ${showForm ? `<form class="key-form" novalidate>
          <label class="visually-hidden" for="key-${p.name}">${esc(p.label)} API key</label>
          <div class="key-input">
            <input id="key-${p.name}" type="password" placeholder="Paste your key (${esc(p.keyHint)})"
              autocomplete="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore ${page.secure ? '' : 'disabled'}>
            <button class="btn ghost small" type="button" data-toggle aria-pressed="false">Show</button>
          </div>
          <div class="key-actions">
            <button class="btn" type="submit" ${page.secure ? '' : 'disabled'}>${saved ? 'Save new key' : 'Save key'}</button>
            ${saved ? '<button class="btn ghost" type="button" data-cancel>Cancel</button>' : ''}
          </div>
        </form>`
      : `<div class="key-actions">
          <button class="btn ghost" type="button" data-replace>Replace</button>
          <button class="btn ghost danger-text" type="button" data-remove>Remove</button>
        </div>`}
      <p class="form-ok" role="status"></p>
      <p class="form-error" role="alert"></p>
      <p class="key-links"><a href="${esc(p.keyUrl)}" target="_blank" rel="noopener noreferrer">Get a key ↗</a>
        <a href="${esc(p.limitsUrl)}" target="_blank" rel="noopener noreferrer">Set a spending limit ↗</a></p>
    </section>`;
  }).join('');
}

function say(card, kind, text) {
  card.querySelector('.form-ok').textContent = kind === 'ok' ? text : '';
  card.querySelector('.form-error').textContent = kind === 'error' ? text : '';
}

$('providers').addEventListener('click', async (e) => {
  const card = e.target.closest('.key-card');
  if (!card) return;
  const provider = card.dataset.provider;
  if (e.target.closest('[data-toggle]')) {
    const btn = e.target.closest('[data-toggle]');
    const input = card.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', String(show));
    return;
  }
  if (e.target.closest('[data-replace]')) { editing.add(provider); render(); $(`key-${provider}`)?.focus(); return; }
  if (e.target.closest('[data-cancel]')) { editing.delete(provider); render(); return; }
  if (e.target.closest('[data-remove]')) {
    const label = page.providers.find((p) => p.name === provider).label;
    if (!confirm(`Remove your ${label} key? You won't be able to send with ${label} models until you add one again.`)) return;
    const res = await api(`/api/keys/${provider}/remove`, {});
    if (res.data.providers) { page = res.data; render(); }
    say($('providers').querySelector(`[data-provider=${provider}]`), res.ok ? 'ok' : 'error',
      res.ok ? `${label} key removed. Also delete it on ${label}'s website if you no longer need it.` : res.data.error);
  }
});

$('providers').addEventListener('submit', async (e) => {
  e.preventDefault();
  const card = e.target.closest('.key-card');
  const provider = card.dataset.provider;
  const input = card.querySelector('input');
  const key = input.value.trim();
  if (!key) return say(card, 'error', 'Paste your key first.');
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Checking key…';
  say(card);
  const res = await api(`/api/keys/${provider}`, { key });
  input.value = ''; // don't leave the key sitting in the page
  if (res.ok) {
    editing.delete(provider);
    page = res.data;
    render();
    say($('providers').querySelector(`[data-provider=${provider}]`), 'ok', res.data.message);
  } else {
    btn.disabled = false;
    btn.textContent = 'Save key';
    say(card, 'error', res.data.error || 'Something went wrong.');
    input.focus();
  }
});

const res = await api('/api/keys');
if (res.ok) { page = res.data; render(); }

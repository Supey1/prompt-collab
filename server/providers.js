// AI providers. Each one streams a reply as an async generator of
//   { text: '...' }  pieces of the answer, and finally
//   { usage: { input, output } }  when the provider reports token counts.
// Keys belong to each person (see keys.js) and are passed in per request.
// `keyPattern` makes sure a key only ever goes to the company that issued it.

import crypto from 'node:crypto';

const env = (k) => (process.env[k] || '').trim();

export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    keyPattern: /^sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}$/,
    keyHint: 'starts with sk-',
    keyUrl: 'https://platform.openai.com/api-keys',
    limitsUrl: 'https://platform.openai.com/settings/organization/limits',
    check: (key) => getJSON('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` }),
    fallback: ['gpt-5', 'gpt-5-mini'],
    async list(key) {
      const r = await getJSON('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` });
      return r.data.map((m) => m.id)
        .filter((id) => /^(gpt-|o\d|chatgpt)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding|instruct)/.test(id))
        .sort().reverse();
    },
    stream: (key, model, system, messages, signal) => openAICompatible(
      'https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${key}` },
      model, system, messages, signal),
  },

  anthropic: {
    label: 'Anthropic',
    keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    keyHint: 'starts with sk-ant-',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    limitsUrl: 'https://console.anthropic.com/settings/limits',
    check: (key) => getJSON('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    fallback: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    async list(key) {
      const r = await getJSON('https://api.anthropic.com/v1/models?limit=100',
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
      return r.data.map((m) => m.id);
    },
    async *stream(key, model, system, messages, signal) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model, max_tokens: 8192, stream: true,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      await ensureOk(res);
      let input = 0, output = 0;
      for await (const data of sse(res)) {
        const ev = JSON.parse(data);
        if (ev.type === 'message_start') input = ev.message?.usage?.input_tokens || 0;
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') yield { text: ev.delta.text };
        else if (ev.type === 'message_delta') output = ev.usage?.output_tokens || output;
        else if (ev.type === 'error') throw new Error(ev.error?.message || 'Anthropic error');
      }
      yield { usage: { input, output } };
    },
  },

  google: {
    label: 'Google',
    keyPattern: /^AIza[A-Za-z0-9_-]{30,}$/,
    keyHint: 'starts with AIza',
    keyUrl: 'https://aistudio.google.com/apikey',
    limitsUrl: 'https://console.cloud.google.com/billing',
    check: (key) => getJSON('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key }),
    fallback: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    async list(key) {
      const r = await getJSON('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': key });
      return r.models
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/.test(m.name))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((id) => !/(embedding|tts|image|audio|live)/.test(id))
        .sort().reverse();
    },
    async *stream(key, model, system, messages, signal) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const res = await fetch(url, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        }),
      });
      await ensureOk(res);
      let usage = null;
      for await (const data of sse(res)) {
        const ev = JSON.parse(data);
        const parts = ev.candidates?.[0]?.content?.parts || [];
        for (const p of parts) if (p.text && !p.thought) yield { text: p.text };
        if (ev.usageMetadata) usage = { input: ev.usageMetadata.promptTokenCount || 0, output: ev.usageMetadata.candidatesTokenCount || 0 };
      }
      if (usage) yield { usage };
    },
  },

  openrouter: {
    label: 'OpenRouter',
    keyPattern: /^sk-or-[A-Za-z0-9_-]{20,}$/,
    keyHint: 'starts with sk-or-',
    keyUrl: 'https://openrouter.ai/settings/keys',
    limitsUrl: 'https://openrouter.ai/settings/keys',
    // The model list is public, so check the key against an endpoint that needs it.
    check: (key) => getJSON('https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${key}` }),
    fallback: ['openai/gpt-5', 'anthropic/claude-sonnet-5-5', 'google/gemini-2.5-pro', 'meta-llama/llama-4-maverick', 'deepseek/deepseek-chat', 'mistralai/mistral-large'],
    async list() {
      const r = await getJSON('https://openrouter.ai/api/v1/models', {});
      return r.data.map((m) => m.id);
    },
    stream: (key, model, system, messages, signal) => openAICompatible(
      'https://openrouter.ai/api/v1/chat/completions',
      { Authorization: `Bearer ${key}`, 'X-Title': 'PromptCollab' },
      model, system, messages, signal),
  },

  demo: {
    label: 'Demo',
    free: true, // needs no key
    fallback: ['echo'],
    list: async () => ['echo'],
    stream: demoStream,
  },
};

// ---- keys -----------------------------------------------------------------

export const KEYED = Object.keys(PROVIDERS).filter((p) => !PROVIDERS[p].free);

// Problem with a pasted key, or null. Checked before the key goes anywhere.
export function keyFormatProblem(provider, key) {
  const p = PROVIDERS[provider];
  if (!p || p.free) return 'Unknown provider.';
  if (typeof key !== 'string' || key.length > 300 || !p.keyPattern.test(key)) {
    return `That doesn't look like an ${p.label} key (it ${p.keyHint}). Check you pasted the whole key into the right box.`;
  }
  return null;
}

// Ask the provider whether the key works. Resolves, or throws a readable error.
export async function checkKey(provider, key) {
  try {
    await withTimeout(PROVIDERS[provider].check(key), 10000);
  } catch (e) {
    const msg = redact(e.message, key);
    if (/^40[13]/.test(msg)) throw new Error(`${PROVIDERS[provider].label} rejected that key. Make sure it's active and copied in full.`);
    throw new Error(`Couldn't check the key with ${PROVIDERS[provider].label}: ${msg}`);
  }
}

// Blank out a key wherever it appears (provider errors are shown to the whole room).
export function redact(text, ...keys) {
  let out = String(text ?? '');
  for (const k of keys) if (k && k.length > 8) out = out.split(k).join('[your key]');
  return out;
}

// ---- model catalog -------------------------------------------------------

const MAX_PER_PROVIDER = 40;
const LIST_TTL = 10 * 60e3;
const listCache = new Map(); // sha256(provider + key) -> { at, models }

// Models someone can use with their own keys ({ provider: key }), plus the demo.
// Returns [{ id: 'provider:model', provider, model, providerLabel }]
export async function modelsFor(keys = {}) {
  const out = [];
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.free ? env('DISABLE_DEMO') === '1' : !keys[name]) continue;
    const models = await listModels(name, keys[name] || 'free');
    for (const model of models) out.push({ id: `${name}:${model}`, provider: name, model, providerLabel: p.label });
  }
  return out;
}

async function listModels(name, key) {
  const p = PROVIDERS[name];
  // Cache by a hash so the plain key isn't kept around as a map key.
  const cacheKey = crypto.createHash('sha256').update(`${name}:${key}`).digest('hex');
  const hit = listCache.get(cacheKey);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.models;
  let models = p.fallback;
  try {
    const live = await withTimeout(p.list(key), 8000);
    if (live?.length) models = live;
  } catch (e) {
    console.warn(`[models] couldn't list ${p.label} models (${redact(e.message, key)}); using defaults`);
  }
  // Keep the featured defaults first, then the rest of the live list.
  const ordered = [...new Set([...p.fallback.filter((m) => models.includes(m)), ...models])].slice(0, MAX_PER_PROVIDER);
  listCache.set(cacheKey, { at: Date.now(), models: ordered });
  return ordered;
}

// 'openai:gpt-5' -> { name: 'openai', provider, model: 'gpt-5' }, or null.
export function parseModel(id) {
  const i = String(id).indexOf(':');
  if (i < 0) return null;
  const name = id.slice(0, i);
  const provider = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;
  const model = id.slice(i + 1);
  if (!provider || !model || model.length > 200) return null;
  return { name, provider, model };
}

// ---- helpers --------------------------------------------------------------

async function* openAICompatible(url, headers, model, system, messages, signal) {
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model, stream: true, stream_options: { include_usage: true },
      messages: [...(system ? [{ role: 'system', content: system }] : []),
        ...messages.map((m) => ({ role: m.role, content: m.content }))],
    }),
  });
  await ensureOk(res);
  let usage = null;
  for await (const data of sse(res)) {
    if (data === '[DONE]') break;
    const ev = JSON.parse(data);
    if (ev.error) throw new Error(ev.error.message || 'Provider error');
    const t = ev.choices?.[0]?.delta?.content;
    if (t) yield { text: t };
    if (ev.usage) usage = { input: ev.usage.prompt_tokens || 0, output: ev.usage.completion_tokens || 0 };
  }
  if (usage) yield { usage };
}

async function* sse(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) yield data;
      }
    }
  }
}

async function ensureOk(res) {
  if (res.ok) return;
  let detail = '';
  try {
    const body = await res.text();
    detail = JSON.parse(body)?.error?.message || body.slice(0, 300);
  } catch { /* ignore */ }
  throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
}

async function getJSON(url, headers) {
  const res = await fetch(url, { headers });
  await ensureOk(res);
  return res.json();
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// A stand-in model so the app is usable before any API key is configured.
async function* demoStream(_key, _model, system, messages, signal) {
  const last = messages[messages.length - 1]?.content || '';
  const words = last.trim().split(/\s+/).filter(Boolean).length;
  const reply =
`**Demo mode** — no API key is configured, so this reply comes from a built-in stand-in instead of a real model.

Your team's prompt was **${words} words** (~${Math.round(last.length / 4)} tokens)${system ? ', with a shared system prompt' : ''}. Here's the start of it:

> ${last.slice(0, 280).replace(/\n/g, '\n> ')}${last.length > 280 ? '…' : ''}

To get real answers, open **API keys** from the home page and add your own key (OpenRouter, OpenAI, Anthropic or Google). Each person's key is used only for the messages they send.

Everyone in this room saw this answer stream in at the same time.`;
  const pieces = reply.match(/\S+\s*/g) || [];
  for (const p of pieces) {
    if (signal?.aborted) return;
    await new Promise((r) => setTimeout(r, 18));
    yield { text: p };
  }
  yield { usage: { input: Math.round(last.length / 4), output: Math.round(reply.length / 4) } };
}

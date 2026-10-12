// AI providers. Each one streams a reply as an async generator of
//   { text: '...' }  pieces of the answer, and finally
//   { usage: { input, output } }  when the provider reports token counts.
// Keys come from environment variables; a provider without a key is hidden.

const env = (k) => (process.env[k] || '').trim();

export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    key: () => env('OPENAI_API_KEY'),
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
    key: () => env('ANTHROPIC_API_KEY'),
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
    key: () => env('GEMINI_API_KEY') || env('GOOGLE_API_KEY'),
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
    key: () => env('OPENROUTER_API_KEY'),
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
    key: () => 'demo',
    fallback: ['echo'],
    list: async () => ['echo'],
    stream: demoStream,
  },
};

// ---- model catalog -------------------------------------------------------

const MAX_PER_PROVIDER = 40;
let catalog = null;

// Returns [{ id: 'provider:model', provider, model, providerLabel }]
export async function getCatalog({ refresh = false } = {}) {
  if (catalog && !refresh) return catalog;
  const out = [];
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const key = p.key();
    if (!key) continue;
    if (name === 'demo' && env('DISABLE_DEMO') === '1') continue;
    let models = p.fallback;
    try {
      const live = await withTimeout(p.list(key), 8000);
      if (live?.length) models = live;
    } catch (e) {
      console.warn(`[models] couldn't list ${p.label} models (${e.message}); using defaults`);
    }
    // Keep the featured defaults first, then the rest of the live list.
    const ordered = [...new Set([...p.fallback.filter((m) => models.includes(m)), ...models])].slice(0, MAX_PER_PROVIDER);
    for (const model of ordered) out.push({ id: `${name}:${model}`, provider: name, model, providerLabel: p.label });
  }
  catalog = out;
  return catalog;
}

export function resolveModel(id) {
  const i = id.indexOf(':');
  if (i < 0) return null;
  const provider = PROVIDERS[id.slice(0, i)];
  const model = id.slice(i + 1);
  if (!provider || !provider.key() || !model) return null;
  return { provider, model, key: provider.key() };
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

To get real answers, add one or more keys and restart the server:

\`\`\`bash
OPENAI_API_KEY=...      # GPT models
ANTHROPIC_API_KEY=...   # Claude models
GEMINI_API_KEY=...      # Gemini models
OPENROUTER_API_KEY=...  # hundreds of models through one key
\`\`\`

Everyone in this room saw this answer stream in at the same time.`;
  const pieces = reply.match(/\S+\s*/g) || [];
  for (const p of pieces) {
    if (signal?.aborted) return;
    await new Promise((r) => setTimeout(r, 18));
    yield { text: p };
  }
  yield { usage: { input: Math.round(last.length / 4), output: Math.round(reply.length / 4) } };
}

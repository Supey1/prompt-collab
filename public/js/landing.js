import { bindThemeToggle } from './theme.js';
import { estimateTokens } from '../shared/ot.js';

bindThemeToggle(document.getElementById('themeBtn'));

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

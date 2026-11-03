// Small, safe Markdown renderer for model replies. Everything is escaped first;
// only a known set of constructs is turned back into HTML. LaTeX math is
// rendered with KaTeX (vendored in /vendor), loaded the first time a reply has math.
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- math ----

const KATEX_DIR = '/vendor/katex-0.16.11';
let katexState = 'idle'; // idle -> loading -> ready (or failed)
let onMathReady = () => {};

// Called once KaTeX has loaded, so replies already on screen can be redrawn with real math.
export function whenMathReady(fn) { onMathReady = fn; }

function loadKatex() {
  if (katexState !== 'idle') return;
  katexState = 'loading';
  const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${KATEX_DIR}/katex.min.css` });
  const js = Object.assign(document.createElement('script'), { src: `${KATEX_DIR}/katex.min.js` });
  js.onload = () => { katexState = 'ready'; onMathReady(); };
  js.onerror = () => { katexState = 'failed'; };
  document.head.append(css, js);
}

const mathCache = new Map(); // rendering the same formula on every streamed token would be slow

function renderMath(tex, display) {
  if (katexState !== 'ready') {
    loadKatex();
    // Until KaTeX arrives (or if it can't load), show the LaTeX as it was written.
    const raw = display ? `$$${tex}$$` : `$${tex}$`;
    return `<span class="math-raw${display ? ' display' : ''}">${esc(raw)}</span>`;
  }
  const key = (display ? 'D' : 'I') + tex;
  if (!mathCache.has(key)) {
    if (mathCache.size > 500) mathCache.clear();
    let html;
    try {
      html = window.katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false, // a typo shows that part in red instead of breaking the reply
        output: 'htmlAndMathml', // MathML lets screen readers read the formula
        trust: false, // no links, classes or ids from model output
        strict: 'ignore',
        maxSize: 20,
        maxExpand: 500, // stop runaway macros from freezing the page
      });
    } catch {
      html = `<span class="math-raw">${esc(tex)}</span>`;
    }
    mathCache.set(key, display ? `<div class="math-display">${html}</div>` : html);
  }
  return mathCache.get(key);
}

// Display math ($$...$$, \[...\], and bare \begin{align}-style environments) is
// pulled out first, outside code blocks, and put back as its own block.
const DISPLAY_MATH = new RegExp([
  String.raw`(^|\n)[ \t]*(\x60\x60\x60|~~~)[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)`, // a code block: left alone
  String.raw`\$\$([\s\S]+?)\$\$`,
  String.raw`\\\[([\s\S]+?)\\\]`,
  String.raw`(\\begin\{(equation|align|gather|multline|alignat|eqnarray)\*?\}[\s\S]+?\\end\{\6\*?\})`,
].join('|'), 'g');

function protectDisplayMath(src, store) {
  return src.replace(DISPLAY_MATH, (match, lead, fence, dollars, brackets, env, envName, offset) => {
    if (fence) return match; // code blocks stay exactly as written
    store.push((dollars ?? brackets ?? env).trim());
    // Inside a quote ("> $$...$$"), keep the "> " so the equation stays in the quote.
    const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
    const quote = src.slice(lineStart, offset).match(/^(\s*>\s?)+/)?.[0] || '';
    return `\n${quote}\u0001${store.length - 1}\u0001\n${quote}`;
  });
}

// Inline math: \(...\) and $...$. A $ only opens math when followed by a
// non-space and closes when preceded by one and not followed by a digit,
// so prices like "$5 and $10" stay text.
const INLINE_MATH = new RegExp([
  String.raw`\\\((.+?)\\\)`,
  String.raw`(?<![\\$\w])\$(?=\S)([^$\n]*?\S)\$(?![\d$])`,
].join('|'), 'g');

function inline(s) {
  const codes = [];
  const maths = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\\\$/g, '\u0003'); // \$ is a literal dollar sign
  s = s.replace(INLINE_MATH, (_, paren, dollar) => { maths.push(paren ?? dollar); return `\u0002${maths.length - 1}\u0002`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`)
    .replace(/\u0002(\d+)\u0002/g, (_, i) => renderMath(maths[+i], false))
    .replace(/\u0003/g, '$');
}

export function renderMarkdown(src) {
  const display = [];
  return render(protectDisplayMath(src.replace(/\r\n/g, '\n'), display), display);
}

function render(src, display) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const math = line.match(/^\u0001(\d+)\u0001$/);
    if (math) { out.push(renderMath(display[+math[1]], true)); i++; continue; }
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><button class="copy-code" type="button">Copy</button><code data-lang="${esc(fence[2])}">${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { const n = Math.min(3, h[1].length); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${render(q.join('\n'), display)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] || '')) {
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = row(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
        if (m && /\d/.test(m[1]) === ordered) { items.push(m[2]); i++; }
        else if (lines[i].match(/^\s{2,}\S/) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\u0001)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

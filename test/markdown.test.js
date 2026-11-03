// Which parts of a model's reply are treated as LaTeX math, and which aren't.
// (KaTeX itself runs in the browser; here math shows up as its raw-text fallback.)
// Run: node test/markdown.test.js
import assert from 'node:assert/strict';

// Just enough of a browser for markdown.js to ask for KaTeX (which never arrives here).
globalThis.document = { createElement: () => ({}), head: { append() {} } };
const { renderMarkdown } = await import('../public/js/markdown.js');

const inlineMath = (html) => [...html.matchAll(/<span class="math-raw">([^<]*)<\/span>/g)].map((m) => m[1]);
const displayMath = (html) => [...html.matchAll(/<span class="math-raw display">([^<]*)<\/span>/g)].map((m) => m[1]);

// Display math, in every form models use.
assert.deepEqual(displayMath(renderMarkdown('Solve:\n\n$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$\n\nDone.')), ['$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$']);
assert.deepEqual(displayMath(renderMarkdown('\\[\n  a^2 + b^2 = c^2\n\\]')), ['$$a^2 + b^2 = c^2$$']);
assert.deepEqual(displayMath(renderMarkdown('\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}')).length, 1);
assert.deepEqual(displayMath(renderMarkdown('Text before $$E = mc^2$$ text after')), ['$$E = mc^2$$'], 'display math mid-sentence');

// Inline math, and underscores inside it are not turned into italics.
let html = renderMarkdown('Let $a_1 + b_1$ be the sum, and \\(x_n\\) the term.');
assert.deepEqual(inlineMath(html), ['$a_1 + b_1$', '$x_n$']);
assert.ok(!html.includes('<em>'), 'subscripts are not italics');

// Prices and dollar amounts stay as text.
for (const text of ['It costs $5 and $10.', 'Between $5-$10 per month', 'I have $ 20 and you have $ 30', 'Pay \\$100 now']) {
  html = renderMarkdown(text);
  assert.equal(inlineMath(html).length, 0, `no math in: ${text}`);
}
assert.match(renderMarkdown('Pay \\$100 now'), /Pay \$100 now/, '\\$ is a literal dollar sign');

// Code stays code.
html = renderMarkdown('```js\nconst price = `$${x}$$`;\n```');
assert.equal(displayMath(html).length + inlineMath(html).length, 0, 'no math inside code blocks');
html = renderMarkdown('Use `$x$` in your template.');
assert.equal(inlineMath(html).length, 0, 'no math inside inline code');
assert.match(html, /<code>\$x\$<\/code>/);

// While a reply is still streaming, an unfinished $$ just stays as text.
html = renderMarkdown('The answer is $$\\frac{1}{');
assert.equal(displayMath(html).length, 0);
assert.match(html, /The answer is \$\$\\frac\{1\}\{/);

// Math inside lists, tables and quotes.
assert.equal(inlineMath(renderMarkdown('- first $x^2$\n- second $y^2$')).length, 2);
assert.equal(inlineMath(renderMarkdown('| a | b |\n|---|---|\n| $x$ | $y$ |')).length, 2);
assert.equal(displayMath(renderMarkdown('> $$z = 1$$')).length, 1);
html = renderMarkdown('> Solve this:\n> $$x = 1$$\n> and check it.');
assert.equal((html.match(/<blockquote>/g) || []).length, 1, 'an equation inside a quote stays in one quote');

// Nothing in a formula can become real HTML.
html = renderMarkdown('$<script>alert(1)</script>$ and $$<img src=x onerror=alert(1)>$$');
assert.ok(!/<script|<img/.test(html), 'HTML in a formula is escaped');

console.log('Markdown math tests passed');

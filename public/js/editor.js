import { DocClient, transformCursor } from './doc-client.js';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A <textarea> bound to a shared DocClient, with teammates' carets and
// selections painted on a mirror layer behind the text.
export class SharedEditor {
  constructor(root, { field, send, onLocalCursor, onChange }) {
    this.field = field;
    this.ta = root.querySelector('textarea');
    this.mirror = root.querySelector('.mirror');
    this.onChange = onChange || (() => {});
    this.remotes = new Map(); // userId -> { name, color, anchor, head }
    this.doc = new DocClient((m) => send({ type: 'op', field, rev: m.rev, op: m.op }));
    this.composing = false;

    this.ta.addEventListener('compositionstart', () => { this.composing = true; });
    this.ta.addEventListener('compositionend', () => { this.composing = false; this.onInput(); });
    this.ta.addEventListener('input', () => { if (!this.composing) this.onInput(); });
    this.ta.addEventListener('scroll', () => this.syncScroll());

    let t = null;
    const emitCursor = () => {
      t = null;
      if (document.activeElement !== this.ta) return;
      onLocalCursor?.({ field, anchor: this.ta.selectionStart, head: this.ta.selectionEnd });
    };
    document.addEventListener('selectionchange', () => { if (!t) t = setTimeout(emitCursor, 60); });
    this.ta.addEventListener('focus', emitCursor);
    this.ta.addEventListener('blur', () => onLocalCursor?.({ field: null }));
    new ResizeObserver(() => this.render()).observe(this.ta);
  }

  reset(text, rev) {
    this.doc.reset(text, rev);
    this.ta.value = text;
    this.autosize();
    this.render();
    this.onChange(text);
  }

  onInput() {
    const op = this.doc.localChange(this.ta.value, this.ta.selectionEnd);
    if (!op) return;
    for (const r of this.remotes.values()) {
      r.anchor = transformCursor(r.anchor, op);
      r.head = transformCursor(r.head, op);
    }
    this.autosize();
    this.render();
    this.onChange(this.doc.text);
  }

  ack() { this.doc.ack(); }

  remote(op, rev, byId) {
    const focused = document.activeElement === this.ta;
    let { selectionStart: s, selectionEnd: e } = this.ta;
    const applied = this.doc.remote(op, rev);
    s = transformCursor(s, applied);
    e = transformCursor(e, applied);
    for (const [id, r] of this.remotes) {
      r.anchor = transformCursor(r.anchor, applied, id === byId);
      r.head = transformCursor(r.head, applied, id === byId);
    }
    const top = this.ta.scrollTop;
    this.ta.value = this.doc.text;
    if (focused) this.ta.setSelectionRange(s, e);
    this.ta.scrollTop = top;
    this.autosize();
    this.render();
    this.onChange(this.doc.text);
  }

  resync(text, rev) {
    const focused = document.activeElement === this.ta;
    const pos = this.ta.selectionEnd;
    this.reset(text, rev);
    if (focused) this.ta.setSelectionRange(Math.min(pos, text.length), Math.min(pos, text.length));
  }

  setRemote(id, user, cursor) {
    if (!cursor || cursor.field !== this.field) this.remotes.delete(id);
    else this.remotes.set(id, { name: user.name, color: user.color, anchor: cursor.anchor, head: cursor.head });
    this.render();
  }

  pruneRemotes(liveIds) {
    for (const id of this.remotes.keys()) if (!liveIds.has(id)) this.remotes.delete(id);
    this.render();
  }

  autosize() {
    this.ta.style.height = 'auto';
    this.ta.style.height = `${this.ta.scrollHeight + 2}px`;
    this.syncScroll();
  }

  syncScroll() {
    this.mirror.style.transform = `translateY(${-this.ta.scrollTop}px)`;
    this.mirror.style.width = `${this.ta.clientWidth}px`;
  }

  // Paint carets and selections. Text in the mirror is transparent; only the
  // marks show through behind the real textarea.
  render() {
    const text = this.doc.text;
    const len = text.length;
    const marks = [...this.remotes.values()].map((r) => ({
      ...r,
      a: Math.min(Math.max(0, Math.min(r.anchor, r.head)), len),
      b: Math.min(Math.max(0, Math.max(r.anchor, r.head)), len),
      h: Math.min(Math.max(0, r.head), len),
    }));
    const points = new Set([0, len]);
    for (const m of marks) { points.add(m.a); points.add(m.b); points.add(m.h); }
    const sorted = [...points].sort((x, y) => x - y);
    let html = '';
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      for (const m of marks) {
        if (m.h === p) html += `<span class="caret" style="--c:${m.color}" data-name="${esc(m.name)}">⁠</span>`;
      }
      const next = sorted[i + 1];
      if (next === undefined || next === p) continue;
      let seg = esc(text.slice(p, next));
      for (const m of marks) {
        if (m.a <= p && m.b >= next && m.a !== m.b) seg = `<span class="sel" style="--c:${m.color}">${seg}</span>`;
      }
      html += seg;
    }
    this.mirror.innerHTML = html + '​';
    this.syncScroll();
  }

  focus() { this.ta.focus(); }
}

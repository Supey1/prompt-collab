import { apply, transform } from '../public/shared/ot.js';

const MAX_HISTORY = 2000;

// Server-side copy of one shared text field. Orders every edit and keeps a
// short history so late ops from clients can be transformed forward.
export class DocState {
  constructor(text = '', rev = 0) {
    this.text = text;
    this.rev = rev;
    this.history = []; // ops for revisions (rev - history.length + 1) .. rev
  }

  // Apply an op a client made against `baseRev`. Returns the op as actually
  // applied (after transforming) and the new revision, or null if too stale.
  receive(baseRev, op) {
    const behind = this.rev - baseRev;
    if (behind < 0 || behind > this.history.length) return null;
    let A = op;
    for (const B of this.history.slice(this.history.length - behind)) {
      // B was sequenced first, so on a tie it stays left and A moves after it.
      [A] = transform(A, B, true);
    }
    this.text = apply(this.text, A);
    this.rev++;
    this.history.push(A);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    return { op: A, rev: this.rev };
  }

  // Replace the whole text (e.g. clearing the prompt after send), as an op.
  set(text) {
    if (text === this.text) return null;
    const op = [];
    if (this.text.length) op.push({ t: 'd', p: 0, n: this.text.length });
    if (text.length) op.push({ t: 'i', p: 0, s: text });
    return this.receive(this.rev, op);
  }
}

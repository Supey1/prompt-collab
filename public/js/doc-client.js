import { apply, transform, diff, transformCursor } from '../shared/ot.js';

// Client-side copy of one shared text field. Sends one op at a time to the
// server and transforms incoming remote ops past whatever is still pending.
export class DocClient {
  constructor(send) {
    this.send = send;          // (msg: {rev, op}) => void
    this.text = '';
    this.rev = 0;
    this.inflight = null;      // op sent, awaiting ack
    this.pending = [];         // ops not yet sent (each relative to the previous)
    this.onRemote = null;      // (op) => void, called after a remote op is applied
  }

  reset(text, rev) {
    this.text = text;
    this.rev = rev;
    this.inflight = null;
    this.pending = [];
  }

  // Called with the new full text after the local user edited it.
  localChange(newText, cursorHint) {
    const op = diff(this.text, newText, cursorHint);
    if (!op.length) return null;
    this.text = newText;
    this.pending.push(op);
    this.flush();
    return op;
  }

  flush() {
    if (this.inflight || !this.pending.length) return;
    this.inflight = this.pending.flat();
    this.pending = [];
    this.send({ rev: this.rev, op: this.inflight });
  }

  ack() {
    this.inflight = null;
    this.rev++;
    this.flush();
  }

  remote(op, rev) {
    let B = op;
    // Remote op was sequenced before ours, so ours shift right on ties.
    if (this.inflight) [this.inflight, B] = transform(this.inflight, B, true);
    this.pending = this.pending.map((P) => {
      let P2;
      [P2, B] = transform(P, B, true);
      return P2;
    });
    this.text = apply(this.text, B);
    this.rev = rev;
    if (this.onRemote) this.onRemote(B);
    return B;
  }
}

export { transformCursor };

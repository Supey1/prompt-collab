// Operational transformation for plain text, shared by the server and the browser.
//
// An operation is an array of primitives applied in order:
//   { t: 'i', p: <position>, s: <string> }   insert s at p
//   { t: 'd', p: <position>, n: <count> }    delete n chars starting at p
//
// The server is the single source of truth: it orders every op, so clients only
// ever need to transform against ops the server has already sequenced.

export function apply(text, op) {
  for (const c of op) {
    if (c.t === 'i') text = text.slice(0, c.p) + c.s + text.slice(c.p);
    else text = text.slice(0, c.p) + text.slice(c.p + c.n);
  }
  return text;
}

// Transform primitive a against primitive b (both made on the same base text).
// `aAfter` breaks ties for inserts at the same spot: true means b goes first.
function tPrim(a, b, aAfter) {
  if (a.t === 'i') {
    if (b.t === 'i') {
      if (b.p < a.p || (b.p === a.p && aAfter)) return [{ ...a, p: a.p + b.s.length }];
      return [a];
    }
    // b is a delete
    if (a.p <= b.p) return [a];
    if (a.p >= b.p + b.n) return [{ ...a, p: a.p - b.n }];
    return [{ ...a, p: b.p }];
  }
  // a is a delete
  if (b.t === 'i') {
    if (b.p <= a.p) return [{ ...a, p: a.p + b.s.length }];
    if (b.p >= a.p + a.n) return [a];
    const k = b.p - a.p; // b inserts in the middle of the deleted range: keep its text
    return [
      { t: 'd', p: a.p, n: k },
      { t: 'd', p: a.p + b.s.length, n: a.n - k },
    ];
  }
  // both deletes
  const as = a.p, ae = a.p + a.n, bs = b.p, be = b.p + b.n;
  const overlap = Math.max(0, Math.min(ae, be) - Math.max(as, bs));
  const before = Math.max(0, Math.min(be, as) - bs); // part of b that lies before a
  const n = a.n - overlap;
  if (n <= 0) return [];
  return [{ t: 'd', p: as - before, n }];
}

// Transform op A against op B. Returns [A', B'] such that
// apply(apply(s, B), A') === apply(apply(s, A), B').
export function transform(A, B, aAfter) {
  if (A.length === 0 || B.length === 0) return [A, B];
  if (A.length > 1) {
    const [a1, B1] = transform([A[0]], B, aAfter);
    const [rest, B2] = transform(A.slice(1), B1, aAfter);
    return [a1.concat(rest), B2];
  }
  if (B.length > 1) {
    const [A1, b1] = transform(A, [B[0]], aAfter);
    const [A2, rest] = transform(A1, B.slice(1), aAfter);
    return [A2, b1.concat(rest)];
  }
  return [tPrim(A[0], B[0], aAfter), tPrim(B[0], A[0], !aAfter)];
}

// Move a cursor position through an op. Inserts exactly at the cursor push it
// right only when `stickRight` is set (used for the person who typed).
export function transformCursor(pos, op, stickRight = false) {
  for (const c of op) {
    if (c.t === 'i') {
      if (c.p < pos || (c.p === pos && stickRight)) pos += c.s.length;
    } else if (c.p < pos) {
      pos -= Math.min(c.n, pos - c.p);
    }
  }
  return pos;
}

// Smallest op that turns `before` into `after` (one delete and/or one insert).
// `cursorHint` (the caret after the edit) disambiguates repeated characters.
export function diff(before, after, cursorHint) {
  if (before === after) return [];
  let start = 0;
  const maxStart = Math.min(before.length, after.length);
  while (start < maxStart && before[start] === after[start]) start++;
  if (cursorHint != null) {
    // The edit can't start after the caret position minus inserted length.
    const inserted = after.length - before.length;
    start = Math.min(start, Math.max(0, cursorHint - Math.max(0, inserted)));
  }
  let endB = before.length, endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) { endB--; endA--; }
  const op = [];
  if (endB > start) op.push({ t: 'd', p: start, n: endB - start });
  if (endA > start) op.push({ t: 'i', p: start, s: after.slice(start, endA) });
  return op;
}

// Rough token estimate (≈4 chars/token for English and code) for live display.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

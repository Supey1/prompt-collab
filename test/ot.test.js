// Fuzz test: several simulated clients edit concurrently through a simulated
// server; every replica must end with identical text.
// Run: node test/ot.test.js
import assert from 'node:assert/strict';
import { apply, transform, diff } from '../public/shared/ot.js';
import { DocState } from '../server/doc.js';
import { DocClient } from '../public/js/doc-client.js';

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const randInt = (n) => Math.floor(rand() * n);
const alphabet = 'abc xyz\n';

function randomEdit(text) {
  const p = randInt(text.length + 1);
  if (rand() < 0.55 || text.length === 0) {
    let s = '';
    for (let i = 0, n = 1 + randInt(4); i < n; i++) s += alphabet[randInt(alphabet.length)];
    return text.slice(0, p) + s + text.slice(p);
  }
  const n = 1 + randInt(Math.min(5, text.length - Math.min(p, text.length - 1)));
  const q = Math.min(p, text.length - 1);
  return text.slice(0, q) + text.slice(q + n);
}

// 1) transform() satisfies the convergence property on random op pairs.
for (let i = 0; i < 5000; i++) {
  let base = '';
  for (let k = randInt(12); k > 0; k--) base += alphabet[randInt(alphabet.length)];
  const A = diff(base, randomEdit(base));
  const B = diff(base, randomEdit(base));
  const [A2, B2] = transform(A, B, true);
  assert.equal(apply(apply(base, B), A2), apply(apply(base, A), B2), `pair ${i}`);
}

// 2) Full client/server simulation with random message delivery order.
for (let round = 0; round < 300; round++) {
  const server = new DocState('hello world');
  const clients = [];
  const toServer = []; // [clientIndex, msg]
  const toClient = [];  // per client queue
  for (let c = 0; c < 3; c++) {
    toClient.push([]);
    const dc = new DocClient((msg) => toServer.push([c, msg]));
    dc.reset(server.text, server.rev);
    clients.push(dc);
  }
  for (let step = 0; step < 60; step++) {
    const r = rand();
    if (r < 0.45) {
      const c = randInt(3);
      clients[c].localChange(randomEdit(clients[c].text));
    } else if (r < 0.75 && toServer.length) {
      const [c, msg] = toServer.splice(randInt(Math.min(2, toServer.length)), 1)[0];
      // Messages from one client must stay in order; only interleave across clients.
      const res = server.receive(msg.rev, msg.op);
      toClient.forEach((q, i) => q.push(i === c ? { ack: true } : { op: res.op, rev: res.rev }));
    } else {
      const c = randInt(3);
      const m = toClient[c].shift();
      if (m) m.ack ? clients[c].ack() : clients[c].remote(m.op, m.rev);
    }
  }
  // Drain everything.
  while (toServer.length || toClient.some((q) => q.length)) {
    if (toServer.length) {
      const [c, msg] = toServer.shift();
      const res = server.receive(msg.rev, msg.op);
      toClient.forEach((q, i) => q.push(i === c ? { ack: true } : { op: res.op, rev: res.rev }));
    }
    toClient.forEach((q, i) => {
      const m = q.shift();
      if (m) m.ack ? clients[i].ack() : clients[i].remote(m.op, m.rev);
    });
  }
  for (const c of clients) assert.equal(c.text, server.text, `round ${round}`);
}

console.log('OT tests passed');

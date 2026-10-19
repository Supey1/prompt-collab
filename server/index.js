import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.js';
import { getRoom, roomExists, newRoomId, validRoomId, saveAll } from './rooms.js';
import { getCatalog } from './providers.js';

loadDotEnv();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/new') return redirect(res, `/r/${newRoomId()}`);
    if (p.startsWith('/r/')) {
      if (!validRoomId(p.slice(3))) return redirect(res, '/');
      return sendFile(res, path.join(ROOT, 'room.html'));
    }
    if (p === '/api/models') {
      const models = await getCatalog({ refresh: url.searchParams.has('refresh') });
      return json(res, { models });
    }
    if (p.startsWith('/api/rooms/')) {
      const id = p.slice('/api/rooms/'.length);
      return json(res, { exists: validRoomId(id) && roomExists(id) });
    }
    if (p === '/api/config') return json(res, { accessCodeRequired: !!ACCESS_CODE, lanUrls: lanUrls() });
    if (p === '/healthz') return json(res, { ok: true });

    const file = path.normalize(path.join(ROOT, p === '/' ? 'index.html' : p));
    if (!file.startsWith(ROOT)) return notFound(res);
    return sendFile(res, file);
  } catch (e) {
    console.error(e);
    res.writeHead(500).end('Server error');
  }
});

attachWebSocket(server, '/ws', (socket, _req, url) => {
  const roomId = url.searchParams.get('room') || '';
  if (!validRoomId(roomId)) return socket.destroy();
  let room = null;
  socket.on('message', (msg) => {
    if (!room) {
      if (msg.type !== 'hello') return;
      if (ACCESS_CODE && msg.code !== ACCESS_CODE) {
        socket.send({ type: 'auth', ok: false });
        return;
      }
      room = getRoom(roomId);
      room.join(socket, msg);
      return;
    }
    room.handle(socket, msg).catch((e) => console.error('[room]', e));
  });
  socket.on('close', () => room && room.leave(socket));
});

server.listen(PORT, () => {
  console.log(`PromptCollab running at http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`  On your network:   ${url}`);
  getCatalog().then((m) => {
    const providers = [...new Set(m.map((x) => x.providerLabel))];
    console.log(`Models available from: ${providers.join(', ')}`);
    if (providers.length === 1 && providers[0] === 'Demo') {
      console.log('No API keys found — running in demo mode. See README to add keys.');
    }
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveAll(); process.exit(0); });
}

// ---- helpers ----

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}
// Addresses other devices on the same Wi-Fi/network can use to reach this server.
function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}
function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
}
function redirect(res, to) { res.writeHead(302, { location: to }).end(); }
function notFound(res) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); }

// Tiny .env loader so keys can live in a file without any dependency.
function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env file */ }
}

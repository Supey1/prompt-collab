// Minimal WebSocket server (RFC 6455) on top of node:http, text frames only.
// Kept dependency-free so the app runs with plain `node`.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 2 * 1024 * 1024;

export class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.open = true;
    sock.setNoDelay(true);
    sock.on('data', (d) => this.onData(d));
    sock.on('close', () => this.closed());
    sock.on('error', () => this.closed());
    this.alive = true;
    this.pinger = setInterval(() => {
      if (!this.alive) return this.destroy();
      this.alive = false;
      this.frame(0x9, Buffer.alloc(0));
    }, 30000);
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      if (len > MAX_PAYLOAD) return this.destroy();
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      const mask = masked ? this.buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(this.buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + maskLen + len);
      this.alive = true;

      if (opcode === 0x8) { this.frame(0x8, Buffer.alloc(0)); return this.destroy(); }
      if (opcode === 0x9) { this.frame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          let msg;
          try { msg = JSON.parse(text); } catch { continue; }
          this.emit('message', msg);
        }
      }
    }
  }

  frame(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    this.sock.write(Buffer.concat([header, payload]));
  }

  send(obj) { this.frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }

  destroy() { this.sock.destroy(); this.closed(); }

  closed() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.pinger);
    this.emit('close');
  }
}

// Attach to an http.Server. `onConnection(socket, req)` fires for each client.
export function attachWebSocket(server, path, onConnection) {
  server.on('upgrade', (req, sock) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key) { sock.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    onConnection(new Socket(sock), req, url);
  });
}

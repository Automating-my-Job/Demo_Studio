'use strict';
/**
 * cdp.js — a minimal Chrome DevTools Protocol client. NODE-ONLY.
 *
 * ===========================================================================
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY
 * ===========================================================================
 * Recording the page as it MOVES needs `Page.startScreencast`, which is only
 * reachable over the DevTools WebSocket. Node has no WebSocket client built in,
 * and this project has no dependencies — every tool here runs on a clean
 * checkout with nothing installed, which is what makes them get run.
 *
 * So this is the smallest client that does the job: the RFC 6455 handshake,
 * frame decoding, masked client frames, and a request/response map over CDP.
 * It is not a general WebSocket implementation and does not pretend to be —
 * it talks to one local Chrome and nothing else.
 *
 * THE PARTS THAT ARE EASY TO GET WRONG, and why they are written out:
 *   - client frames MUST be masked; server frames must NOT be. Chrome closes
 *     the connection on an unmasked client frame with no useful error.
 *   - a screencast frame is a base64 JPEG, routinely over 64KB, so the 16-bit
 *     AND 64-bit length forms both occur. A client that only handles the 7-bit
 *     form works until the first interesting frame.
 *   - frames arrive split across TCP reads. Anything that assumes one read is
 *     one frame works on an idle page and fails under a screencast.
 */

const net = require('net');
const crypto = require('crypto');
const http = require('http');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** GET a JSON endpoint on the DevTools HTTP interface. */
function httpJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: path }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('devtools HTTP timed out')); });
  });
}

/** Waits for Chrome's debugging port to answer. */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  for (;;) {
    try { return await httpJson(port, '/json/version'); } catch (err) { /* not yet */ }
    if (Date.now() > deadline) throw new Error('Chrome never opened port ' + port);
    await new Promise(r => setTimeout(r, 150));
  }
}

class Cdp {
  constructor(socket) {
    this._socket = socket;
    this._buffer = Buffer.alloc(0);
    this._nextId = 1;
    this._pending = {};
    this._listeners = {};
    this._fragments = [];
    this._fragmentOpcode = 0;
    socket.on('data', d => this._onData(d));
  }

  /** Connects to a DevTools WebSocket URL. */
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const m = /^ws:\/\/([^:/]+):(\d+)(\/.*)$/.exec(wsUrl);
      if (!m) { reject(new Error('not a ws:// url: ' + wsUrl)); return; }
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(Number(m[2]), m[1], () => {
        socket.write(
          'GET ' + m[3] + ' HTTP/1.1\r\n' +
          'Host: ' + m[1] + ':' + m[2] + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n');
      });
      socket.setNoDelay(true);

      let handshake = Buffer.alloc(0);
      const onHandshake = chunk => {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end === -1) return;

        const head = handshake.slice(0, end).toString('utf8');
        if (!/^HTTP\/1\.1 101/.test(head)) {
          reject(new Error('handshake refused: ' + head.split('\r\n')[0]));
          socket.destroy();
          return;
        }
        const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (head.indexOf(expect) === -1) {
          reject(new Error('handshake accept key did not match'));
          socket.destroy();
          return;
        }
        socket.removeListener('data', onHandshake);
        const client = new Cdp(socket);
        // Anything that arrived in the same read as the handshake is already
        // websocket data and would otherwise be lost.
        const rest = handshake.slice(end + 4);
        if (rest.length) client._onData(rest);
        resolve(client);
      };
      socket.on('data', onHandshake);
      socket.on('error', reject);
    });
  }

  on(method, fn) {
    (this._listeners[method] = this._listeners[method] || []).push(fn);
  }

  send(method, params, sessionId) {
    const id = this._nextId++;
    const msg = { id: id, method: method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._pending[id] = { resolve: resolve, reject: reject };
      this._writeFrame(Buffer.from(JSON.stringify(msg), 'utf8'));
    });
  }

  close() {
    try { this._socket.destroy(); } catch (err) { /* already gone */ }
  }

  // -------------------------------------------------------------------------

  _writeFrame(payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len % 4294967296, 6);
    }
    header[0] = 0x81;                      // FIN + text

    // MASKING IS MANDATORY for a client. Chrome drops the connection without
    // it, and the failure looks like the server simply going quiet.
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];

    this._socket.write(Buffer.concat([header, mask, masked]));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      if (frame.opcode === 0x8) { this.close(); return; }
      if (frame.opcode === 0x9) continue;                 // ping; Chrome does not need a pong here
      if (frame.opcode === 0x0 || frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (!frame.fin) {
          if (frame.opcode !== 0x0) this._fragmentOpcode = frame.opcode;
          this._fragments.push(frame.payload);
          continue;
        }
        let payload = frame.payload;
        if (this._fragments.length) {
          this._fragments.push(payload);
          payload = Buffer.concat(this._fragments);
          this._fragments = [];
        }
        this._dispatch(payload.toString('utf8'));
      }
    }
  }

  /** One frame, or null when the buffer does not yet hold a whole one. */
  _readFrame() {
    const b = this._buffer;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      const hi = b.readUInt32BE(offset);
      const lo = b.readUInt32BE(offset + 4);
      len = hi * 4294967296 + lo;
      offset += 8;
    }
    if (masked) offset += 4;                 // a server should not mask, but be safe
    if (b.length < offset + len) return null;

    const payload = b.slice(offset, offset + len);
    this._buffer = b.slice(offset + len);
    return { fin: fin, opcode: opcode, payload: payload };
  }

  _dispatch(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (err) { return; }

    if (msg.id && this._pending[msg.id]) {
      const p = this._pending[msg.id];
      delete this._pending[msg.id];
      if (msg.error) p.reject(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && this._listeners[msg.method]) {
      this._listeners[msg.method].forEach(fn => fn(msg.params, msg.sessionId));
    }
  }
}

module.exports = { Cdp: Cdp, httpJson: httpJson, waitForPort: waitForPort };

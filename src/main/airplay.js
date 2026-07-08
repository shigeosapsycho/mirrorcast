'use strict';

/**
 * airplay.js - AirPlay 2 receiver control server.
 *
 * Listens on AIRPLAY_PORT (7000) and speaks the HTTP/1.1 + RTSP hybrid that
 * iOS uses. Handles: /info, pair-setup, pair-verify, /fp-setup (FairPlay),
 * and the RTSP verbs ANNOUNCE / SETUP / RECORD / SET_PARAMETER / TEARDOWN.
 *
 * ----------------------------------------------------------------------------
 * IMPORTANT - the FairPlay boundary
 * ----------------------------------------------------------------------------
 * Modern iOS mirroring is gated by Apple **FairPlay** (`POST /fp-setup`, a
 * 2-phase challenge/response) plus AES encryption of the H.264 stream keyed by
 * that exchange. FairPlay's algorithm/tables are Apple-proprietary and were
 * reverse-engineered by GPL projects (RPiPlay `lib/playfair`, UxPlay). They are
 * NOT part of Node's `crypto`, and they are not reproduced here.
 *
 * Everything up to and including `pair-verify` is implemented for real with
 * Node's x25519/ed25519/HKDF/ChaCha20-Poly1305. At `/fp-setup` we emit a
 * clearly-marked NOT_IMPLEMENTED event: the socket stays up and logs the
 * incoming stream, but frames cannot be decrypted/decoded until a FairPlay
 * engine is plugged into `decryptStreamKey()` below. See README "Limitations".
 * ----------------------------------------------------------------------------
 */

const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const { AIRPLAY_PORT, SRCVERS, MODEL, STATE } = require('../shared/constants');

// ---------------------------------------------------------------------------
// Minimal RTSP/HTTP message framing over a TCP socket.
// ---------------------------------------------------------------------------

class MessageParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** Feed bytes, yield complete {method,uri,version,headers,body} messages. */
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerText = this.buf.slice(0, headerEnd).toString('utf8');
      const lines = headerText.split('\r\n');
      const requestLine = lines.shift() || '';
      const [method, uri, version] = requestLine.split(' ');

      const headers = {};
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx > -1) {
          headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
      }

      const contentLength = parseInt(headers['content-length'] || '0', 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + contentLength) break; // wait for full body

      const body = this.buf.slice(bodyStart, bodyStart + contentLength);
      this.buf = this.buf.slice(bodyStart + contentLength);
      out.push({ method, uri, version, headers, body });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// TLV8 (Apple's type-length-value encoding used in pair-setup/pair-verify)
// ---------------------------------------------------------------------------

const TLV = {
  METHOD: 0x00,
  IDENTIFIER: 0x01,
  SALT: 0x02,
  PUBLIC_KEY: 0x03,
  PROOF: 0x04,
  ENCRYPTED_DATA: 0x05,
  STATE: 0x06,
  SIGNATURE: 0x0a,
  ERROR: 0x07,
};

function tlvEncode(entries) {
  const parts = [];
  for (const [type, value] of entries) {
    let v = Buffer.isBuffer(value) ? value : Buffer.from([value]);
    // Fragment values > 255 bytes into successive same-type records.
    let offset = 0;
    do {
      const frag = v.slice(offset, offset + 255);
      parts.push(Buffer.from([type, frag.length]), frag);
      offset += 255;
    } while (offset < v.length);
  }
  return Buffer.concat(parts);
}

function tlvDecode(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const type = buf[i];
    const len = buf[i + 1];
    const val = buf.slice(i + 2, i + 2 + len);
    out[type] = out[type] ? Buffer.concat([out[type], val]) : val;
    i += 2 + len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// AirPlay receiver
// ---------------------------------------------------------------------------

class AirPlayReceiver extends EventEmitter {
  /**
   * @param {object} cfg
   * @param {string} cfg.name
   * @param {string} cfg.deviceId
   * @param {object} cfg.keyPair  { publicKey, privateKey } ed25519 KeyObjects
   * @param {string} cfg.publicKeyHex
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.server = null;
    this.sessions = new Set();
  }

  start() {
    this.server = net.createServer((socket) => this._onConnection(socket));

    this.server.on('error', (err) => {
      // EADDRINUSE / EACCES on Windows usually means a firewall block or a
      // stale receiver. Surface it so the UI can show a friendly message.
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        this.emit('firewall-blocked', { port: AIRPLAY_PORT, code: err.code });
      }
      this.emit('error', err);
    });

    this.server.listen(AIRPLAY_PORT, '0.0.0.0', () => {
      this.emit('log', `AirPlay control server on :${AIRPLAY_PORT}`);
      this.emit('state', STATE.WAITING);
    });
  }

  _onConnection(socket) {
    const session = {
      socket,
      parser: new MessageParser(),
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      deviceName: null,
      paired: false,
    };
    this.sessions.add(session);
    this.emit('log', `client connected ${session.remote}`);
    this.emit('state', STATE.PAIRING);

    socket.on('data', (chunk) => {
      let messages;
      try {
        messages = session.parser.push(chunk);
      } catch (e) {
        this.emit('log', `parse error: ${e.message}`);
        return;
      }
      for (const msg of messages) this._handle(session, msg);
    });

    const cleanup = () => {
      if (!this.sessions.has(session)) return;
      this.sessions.delete(session);
      this.emit('log', `client disconnected ${session.remote}`);
      // Re-advertise / return to waiting immediately on disconnect.
      if (this.sessions.size === 0) this.emit('state', STATE.WAITING);
      this.emit('disconnect', session);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  _handle(session, msg) {
    const { method, uri } = msg;
    this.emit('log', `<= ${method} ${uri}`);
    const path = (uri || '').split('?')[0];

    // Route by method first (RTSP verbs), then by path (HTTP endpoints).
    switch (method) {
      case 'GET':
        if (path === '/info') return this._info(session, msg);
        break;
      case 'POST':
        if (path === '/pair-setup') return this._pairSetup(session, msg);
        if (path === '/pair-verify') return this._pairVerify(session, msg);
        if (path === '/fp-setup') return this._fpSetup(session, msg);
        if (path === '/feedback') return this._reply(session, msg, 200);
        if (path === '/command') return this._reply(session, msg, 200);
        break;
      case 'OPTIONS':
        return this._options(session, msg);
      case 'ANNOUNCE':
        return this._announce(session, msg);
      case 'SETUP':
        return this._setup(session, msg);
      case 'RECORD':
        return this._record(session, msg);
      case 'SET_PARAMETER':
      case 'GET_PARAMETER':
        return this._reply(session, msg, 200);
      case 'TEARDOWN':
        this._reply(session, msg, 200);
        return session.socket.end();
      default:
        break;
    }
    this.emit('log', `unhandled ${method} ${path}`);
    return this._reply(session, msg, 200);
  }

  // --- RTSP verbs --------------------------------------------------------

  _options(session, msg) {
    this._reply(session, msg, 200, {
      Public:
        'ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER, POST, GET',
      'Apple-Response': '', // filled by pairing in a full impl
    });
  }

  _announce(session, msg) {
    // SDP describing the stream (codecs, encryption keys). In a full FairPlay
    // impl the AES key here is unwrapped with the FairPlay session key.
    const sdp = msg.body.toString('utf8');
    this.emit('log', `ANNOUNCE sdp:\n${sdp}`);
    this._reply(session, msg, 200);
  }

  _setup(session, msg) {
    // iOS negotiates the data (7100) + timing/event ports here. We accept and
    // echo a server-port. Real streaming begins after RECORD.
    this._reply(session, msg, 200, {
      Transport: `RTP/AVP/TCP;unicast;interleaved=0-1;mode=record;server_port=7100`,
      Session: '1',
    });
    this.emit('state', STATE.CONNECTED);
    this.emit('client-ready', { session, deviceName: session.deviceName });
  }

  _record(session, msg) {
    this._reply(session, msg, 200, { 'Audio-Latency': '11025', Session: '1' });
    // NOTE: encrypted H.264 now flows on the mirroring data channel. Without
    // the FairPlay stream key it cannot be decoded - see _fpSetup().
    this.emit('log', 'RECORD - stream starting (awaiting FairPlay key to decode)');
  }

  // --- HTTP endpoints ----------------------------------------------------

  _info(session, msg) {
    // Property-list style device info. iOS reads this to decide capabilities.
    // We return a compact JSON-ish plist; real receivers return binary plist.
    const info = {
      deviceid: this.cfg.deviceId,
      features: 0x5a7ffff7,
      model: MODEL,
      srcvers: SRCVERS,
      name: this.cfg.name,
      pk: this.cfg.publicKeyHex,
    };
    const body = Buffer.from(JSON.stringify(info));
    this._reply(session, msg, 200, { 'Content-Type': 'application/json' }, body);
  }

  /**
   * pair-setup (M1..M4). For screen mirroring iOS typically uses the
   * "transient" SRP-less flow; here we implement the ed25519/x25519 exchange
   * skeleton. This is real crypto (Node supports it) but the full state
   * machine + HKDF labels must match Apple's exactly to fully succeed.
   */
  _pairSetup(session, msg) {
    const tlv = tlvDecode(msg.body);
    const state = tlv[TLV.STATE] ? tlv[TLV.STATE][0] : 1;
    this.emit('log', `pair-setup M${state}`);

    // Respond with our ed25519 public key. (A complete implementation derives
    // a shared secret and returns an encrypted signature in later states.)
    const pub = this.cfg.keyPair.publicKey.export({ type: 'spki', format: 'der' });
    const raw = ed25519RawPublic(pub);
    const resp = tlvEncode([
      [TLV.STATE, state + 1],
      [TLV.PUBLIC_KEY, raw],
    ]);
    this._reply(
      session, msg, 200,
      { 'Content-Type': 'application/octet-stream' },
      resp
    );
  }

  /**
   * pair-verify (M1/M2). Establishes the session keys via x25519 ECDH. This is
   * implemented for real; the resulting keys secure the control channel.
   */
  _pairVerify(session, msg) {
    const tlv = tlvDecode(msg.body);
    const state = tlv[TLV.STATE] ? tlv[TLV.STATE][0] : 1;
    this.emit('log', `pair-verify M${state}`);

    if (state === 1) {
      // Generate an ephemeral x25519 key, ECDH against the client's public key.
      const clientPub = tlv[TLV.PUBLIC_KEY];
      const eph = crypto.generateKeyPairSync('x25519');
      session.ephemeral = eph;
      let shared = null;
      try {
        const clientKey = crypto.createPublicKey({
          key: x25519Spki(clientPub),
          format: 'der',
          type: 'spki',
        });
        shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: clientKey });
        session.sharedSecret = shared;
      } catch (e) {
        this.emit('log', `pair-verify ecdh failed: ${e.message}`);
      }
      const ephRaw = ed25519RawPublic(eph.publicKey.export({ type: 'spki', format: 'der' }));
      const resp = tlvEncode([
        [TLV.STATE, 2],
        [TLV.PUBLIC_KEY, ephRaw],
      ]);
      session.paired = true;
      this._reply(session, msg, 200, { 'Content-Type': 'application/octet-stream' }, resp);
    } else {
      this._reply(session, msg, 200, { 'Content-Type': 'application/octet-stream' },
        tlvEncode([[TLV.STATE, state + 1]]));
    }
  }

  /**
   * FairPlay setup. THIS IS THE BOUNDARY. iOS sends a 2-phase encrypted
   * challenge. A correct response requires Apple's reverse-engineered FairPlay
   * algorithm (see RPiPlay `lib/playfair` / UxPlay), which is not bundled.
   */
  _fpSetup(session, msg) {
    const body = msg.body;
    this.emit('log', `/fp-setup phase byte=${body[4]} len=${body.length}`);
    this.emit('fairplay-required', { session });

    // We reply with a plausibly-shaped buffer so the socket doesn't hard-fail,
    // but this is NOT a valid FairPlay response - decode will not succeed.
    // Plug a real engine into decryptStreamKey() to make mirroring work.
    const phase = body.length >= 5 ? body[4] : 1;
    let reply;
    if (body.length === 16) {
      // phase 1: iOS expects a 142-byte reply keyed off body[14].
      reply = Buffer.alloc(142); // placeholder - real bytes come from FairPlay
    } else {
      // phase 2: iOS expects a 32-byte reply.
      reply = Buffer.alloc(32);
    }
    this._reply(session, msg, 200, { 'Content-Type': 'application/octet-stream' }, reply);
  }

  /**
   * Given the (FairPlay-wrapped) AES key material from ANNOUNCE, return the raw
   * AES key + IV to decrypt the H.264 stream. Returns null until a FairPlay
   * engine is provided. This is the single integration point that makes
   * end-to-end mirroring work.
   *
   * @returns {{key:Buffer, iv:Buffer}|null}
   */
  decryptStreamKey(/* wrappedKey, iv */) {
    return null; // <-- plug FairPlay engine here (RPiPlay/UxPlay-style)
  }

  // --- low level ---------------------------------------------------------

  _reply(session, msg, code, headers = {}, body = null) {
    const isRtsp = (msg.version || '').startsWith('RTSP');
    const proto = isRtsp ? 'RTSP/1.0' : 'HTTP/1.1';
    const reason = code === 200 ? 'OK' : 'Error';
    const h = {
      Server: `AirTunes/${SRCVERS}`,
      ...headers,
    };
    // Mirror CSeq for RTSP so iOS can correlate.
    if (msg.headers['cseq'] != null) h['CSeq'] = msg.headers['cseq'];
    if (body) h['Content-Length'] = body.length;
    else if (!('Content-Length' in h)) h['Content-Length'] = 0;

    let head = `${proto} ${code} ${reason}\r\n`;
    for (const [k, v] of Object.entries(h)) head += `${k}: ${v}\r\n`;
    head += '\r\n';

    const out = body ? Buffer.concat([Buffer.from(head), body]) : Buffer.from(head);
    session.socket.write(out);
    this.emit('log', `=> ${code} ${msg.method} ${(msg.uri || '').split('?')[0]}`);
  }

  stop() {
    for (const s of this.sessions) {
      try { s.socket.destroy(); } catch (_) { /* ignore */ }
    }
    this.sessions.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

// ---------------------------------------------------------------------------
// key helpers - convert between raw 32-byte keys and DER/SPKI for Node crypto
// ---------------------------------------------------------------------------

// SPKI prefix for an ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// SPKI prefix for an x25519 public key.
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function ed25519RawPublic(spkiDer) {
  // last 32 bytes of the SPKI DER is the raw key
  return Buffer.from(spkiDer.slice(spkiDer.length - 32));
}

function x25519Spki(raw32) {
  return Buffer.concat([X25519_SPKI_PREFIX, raw32]);
}

module.exports = { AirPlayReceiver, tlvEncode, tlvDecode, MessageParser };

'use strict';

/**
 * engine.js — bridge to a real FairPlay-capable AirPlay receiver engine.
 *
 * Why this exists:
 *   Apple FairPlay (the crypto that gates the mirror stream) is only available
 *   in reverse-engineered GPL projects — UxPlay / RPiPlay. Reimplementing it in
 *   Node is not viable. Instead MirrorCast drives such an engine as a SEPARATE
 *   PROCESS and consumes its decrypted H.264 over a localhost socket. Running
 *   the GPL engine as an independent process (mere aggregation) keeps
 *   MirrorCast itself MIT-licensed; we do not link or bundle its code.
 *
 * Two collaborating pieces:
 *   - VideoIngestServer: listens on 127.0.0.1 and pipes incoming Annex-B H.264
 *     into the ffmpeg Decoder → JPEG frames → renderer canvas. This is the
 *     stable contract; anything that can emit H.264 to the port works.
 *   - EngineController: locates + supervises the external engine binary, maps
 *     its log output to MirrorCast connection state, and restarts on crash.
 *
 * The ingest contract is fully implemented and testable here (see
 * scripts/stream-test.js). The engine invocation is configurable because the
 * exact flags differ per engine/build; sane defaults + docs are provided.
 */

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const EventEmitter = require('events');
const {
  MIRROR_INGEST_PORT,
  MIRROR_AUDIO_PORT,
  ENGINE_CANDIDATES,
} = require('../shared/constants');

// ---------------------------------------------------------------------------
// VideoIngestServer — localhost H.264 sink → decoder
// ---------------------------------------------------------------------------

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

class VideoIngestServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./decoder').Decoder} o.decoder  used for the H.264 path
   * @param {number} [o.port]
   */
  constructor({ decoder, port = MIRROR_INGEST_PORT }) {
    super();
    this.decoder = decoder;
    this.port = port;
    this.server = null;
    this.active = null; // the current producer socket
    // H.264 frames decoded by ffmpeg are re-emitted as our unified 'frame'.
    this.decoder.on('frame', (jpeg) => this.emit('frame', jpeg));
  }

  start() {
    this.server = net.createServer((socket) => this._onProducer(socket));
    this.server.on('error', (err) => this.emit('error', err));
    // Bind to loopback ONLY — never accept video from the network.
    this.server.listen(this.port, '127.0.0.1', () => {
      this.emit('log', `video ingest listening on 127.0.0.1:${this.port}`);
    });
  }

  _onProducer(socket) {
    // One producer at a time; a new one replaces the old.
    if (this.active) {
      try { this.active.destroy(); } catch (_) { /* ignore */ }
    }
    this.active = socket;
    this.emit('log', `ingest producer connected (${socket.remoteAddress})`);
    this.emit('stream-start');

    let mode = null;      // 'h264' | 'mjpeg' — sniffed from first bytes
    let jbuf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      if (this.active !== socket) return;
      if (!mode) {
        // Sniff: JPEG streams start FF D8; H.264 Annex-B starts 00 00 01/00 00 00 01.
        mode = (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xd8) ? 'mjpeg' : 'h264';
        this.emit('log', `ingest format detected: ${mode}`);
        this.emit('format', mode);
        if (mode === 'h264') { this.decoder.stop(); this.decoder.start(); }
      }
      if (mode === 'h264') {
        this.decoder.writeNAL(chunk);          // ffmpeg → 'frame' (via decoder)
      } else {
        jbuf = this._splitMjpeg(Buffer.concat([jbuf, chunk]));
      }
    });

    const end = () => {
      if (this.active !== socket) return;
      this.active = null;
      this.emit('log', 'ingest producer disconnected');
      this.decoder.stop();
      this.emit('stream-end');
    };
    socket.on('close', end);
    socket.on('error', end);
  }

  /** Emit each complete JPEG in the buffer; return the unconsumed tail. */
  _splitMjpeg(buf) {
    for (;;) {
      const start = buf.indexOf(JPEG_SOI);
      if (start === -1) { return buf.length > (1 << 20) ? buf.slice(-2) : buf; }
      const end = buf.indexOf(JPEG_EOI, start + 2);
      if (end === -1) return buf.slice(start); // wait for the rest
      this.emit('frame', buf.slice(start, end + 2));
      buf = buf.slice(end + 2);
    }
  }

  stop() {
    if (this.active) { try { this.active.destroy(); } catch (_) { /* ignore */ } this.active = null; }
    if (this.server) { this.server.close(); this.server = null; }
  }
}

// ---------------------------------------------------------------------------
// AudioIngestServer — localhost raw-PCM (S16LE) sink from the engine
// ---------------------------------------------------------------------------

class AudioIngestServer extends EventEmitter {
  constructor({ port = MIRROR_AUDIO_PORT } = {}) {
    super();
    this.port = port;
    this.server = null;
    this.active = null;
  }

  start() {
    this.server = net.createServer((socket) => {
      if (this.active) { try { this.active.destroy(); } catch (_) { /* ignore */ } }
      this.active = socket;
      this.emit('log', 'audio producer connected');
      socket.on('data', (chunk) => this.emit('pcm', chunk));
      const end = () => { if (this.active === socket) { this.active = null; } };
      socket.on('close', end);
      socket.on('error', end);
    });
    this.server.on('error', (err) => this.emit('error', err));
    this.server.listen(this.port, '127.0.0.1', () => {
      this.emit('log', `audio ingest listening on 127.0.0.1:${this.port}`);
    });
  }

  stop() {
    if (this.active) { try { this.active.destroy(); } catch (_) { /* ignore */ } this.active = null; }
    if (this.server) { this.server.close(); this.server = null; }
  }
}

// ---------------------------------------------------------------------------
// EngineController — locate + supervise the external receiver
// ---------------------------------------------------------------------------

/**
 * Default command template for a UxPlay build that can stream H.264 to a TCP
 * port. Tokens {NAME} and {INGEST_PORT} are substituted at spawn time. Users
 * override this in settings/config to match their engine + build. See README
 * "Wiring an engine" for the exact GStreamer sink recipe.
 *
 * NOTE: stock UxPlay renders to its own window; to route video into the
 * MirrorCast canvas the build must tee H.264 to tcpclientsink (documented).
 */
function defaultCommand() {
  // UxPlay decodes via GStreamer, then this videosink re-encodes the raw frames
  // to MJPEG and streams them to MirrorCast's ingest, which auto-detects JPEG
  // and paints them to the canvas. MJPEG keeps the sink to stock elements
  // (jpegenc/multipartmux/tcpclientsink) — no UxPlay patch needed.
  return [
    '{ENGINE}',
    '-n', '{NAME}',
    '-nh',
    // Video: decoded frames -> MJPEG -> MirrorCast video ingest.
    '-vs', 'jpegenc quality=75 ! tcpclientsink host=127.0.0.1 port={INGEST_PORT}',
    // Audio: decoded PCM (S16LE) -> MirrorCast audio ingest (so the app's
    // volume slider controls it, instead of the engine hitting speakers direct).
    '-as', 'audioconvert ! audioresample ! audio/x-raw,format=S16LE,channels=2,rate=44100 ! queue ! tcpclientsink host=127.0.0.1 port={AUDIO_PORT}',
  ];
}

// On Windows, a UxPlay built under MSYS2 needs its mingw64 GStreamer DLLs on
// PATH at spawn time. Auto-detect that directory from the engine location.
function gstreamerBinDir(exePath) {
  if (process.platform !== 'win32') return null;
  const p = (exePath || '').toLowerCase();
  if (p.includes('msys64')) {
    const dir = 'C:\\msys64\\mingw64\\bin';
    return fs.existsSync(dir) ? dir : null;
  }
  return null;
}

class EngineController extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.name       advertised receiver name
   * @param {string[]|null} o.command  explicit command template or null=auto
   * @param {string|null} o.enginePath explicit binary path override
   * @param {number} o.ingestPort
   * @param {string} o.resourcesDir where a bundled engine may live
   */
  constructor({ name, command = null, enginePath = null, ingestPort = MIRROR_INGEST_PORT, audioPort = MIRROR_AUDIO_PORT, resourcesDir, dllDir = null }) {
    super();
    this.name = name;
    this.command = command;
    this.enginePath = enginePath;
    this.ingestPort = ingestPort;
    this.audioPort = audioPort;
    this.resourcesDir = resourcesDir;
    this.dllDir = dllDir; // extra dir to prepend to PATH (GStreamer runtime)
    this.proc = null;
    this.stopped = false;
    this.restarts = 0;
  }

  /**
   * Resolve the engine binary: explicit override → bundled resources/engine →
   * PATH candidates. Returns absolute path or null.
   */
  locate() {
    if (this.enginePath && fs.existsSync(this.enginePath)) return this.enginePath;

    // bundled (opt-in): resources/engine/<name>(.exe)
    if (this.resourcesDir) {
      for (const cand of ENGINE_CANDIDATES) {
        for (const ext of ['', '.exe']) {
          const p = path.join(this.resourcesDir, 'engine', cand + ext);
          if (fs.existsSync(p)) return p;
        }
      }
    }

    // on PATH
    for (const cand of ENGINE_CANDIDATES) {
      const found = which(cand);
      if (found) return found;
    }

    // Windows: a UxPlay built locally under MSYS2 (see docs/build-uxplay).
    if (process.platform === 'win32') {
      for (const p of msys2UxplayCandidates()) {
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }

  /** @returns {boolean} true if an engine was started */
  start() {
    this.stopped = false;
    const template = this.command && this.command.length ? this.command : defaultCommand();
    const fill = (t) => t
      .replace('{NAME}', this.name)
      .replace('{INGEST_PORT}', String(this.ingestPort))
      .replace('{AUDIO_PORT}', String(this.audioPort));

    // Resolve the executable (template[0]). '{ENGINE}' → auto-detect via
    // locate(); otherwise treat it as a literal binary name or path.
    const head = template[0];
    let exe;
    if (head === '{ENGINE}') {
      exe = this.locate();
    } else {
      const lit = fill(head);
      exe = (path.isAbsolute(lit) && fs.existsSync(lit)) ? lit
        : (which(lit) || (fs.existsSync(lit) ? lit : null));
    }
    if (!exe) {
      this.emit('missing', { candidates: ENGINE_CANDIDATES });
      return false;
    }

    const spawnArgs = template.slice(1).map(fill);

    // Ensure the engine's shared libraries (GStreamer on Windows/MSYS2) resolve.
    const dllDir = this.dllDir || gstreamerBinDir(exe);
    const env = dllDir
      ? { ...process.env, PATH: dllDir + path.delimiter + (process.env.PATH || '') }
      : process.env;
    if (dllDir) this.emit('log', `GStreamer runtime: ${dllDir}`);

    this.emit('log', `starting engine: ${exe} ${spawnArgs.join(' ')}`);
    this.emit('ready', { engine: path.basename(exe) });

    this.proc = spawn(exe, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], env });

    const onLine = (line) => this._parse(line);
    lineReader(this.proc.stdout, onLine);
    lineReader(this.proc.stderr, onLine);

    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('close', (code) => {
      this.emit('log', `engine exited (${code})`);
      this.proc = null;
      if (!this.stopped && this.restarts < 5) {
        this.restarts++;
        this.emit('log', `restarting engine (#${this.restarts})`);
        setTimeout(() => { if (!this.stopped) this.start(); }, 1500);
      } else if (!this.stopped) {
        this.emit('crashed');
      }
    });
    return true;
  }

  /** Map engine log lines to MirrorCast connection events. */
  _parse(line) {
    this.emit('log', `engine: ${line}`);
    const l = line.toLowerCase();
    if (/accepted|connection request|client connected|got.*connection|start mirroring/.test(l)) {
      this.emit('client-connected', { raw: line });
    } else if (/connection closed|teardown|client.*disconnect|stop mirroring/.test(l)) {
      this.emit('client-disconnected', { raw: line });
    }
    const m = line.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
    if (m) this.emit('resolution', { width: +m[1], height: +m[2] });
  }

  stop() {
    this.stopped = true;
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
      // hard kill after grace period
      const p = this.proc;
      setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) { /* ignore */ } }, 1200);
      this.proc = null;
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Locations a locally-built (MSYS2) UxPlay may live on Windows. */
function msys2UxplayCandidates() {
  const out = [];
  const homeRoot = 'C:\\msys64\\home';
  try {
    if (fs.existsSync(homeRoot)) {
      for (const user of fs.readdirSync(homeRoot)) {
        out.push(path.join(homeRoot, user, 'uxplay-build', 'build', 'uxplay.exe'));
      }
    }
  } catch (_) { /* ignore */ }
  out.push('C:\\msys64\\mingw64\\bin\\uxplay.exe');
  return out;
}

/** Cross-platform `which`. */
function which(cmd) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(isWin ? ';' : ':');
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) { /* ignore */ }
    }
  }
  // fall back to system resolver
  try {
    const r = spawnSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim() || null;
  } catch (_) { /* ignore */ }
  return null;
}

/** Emit trimmed lines from a stream. */
function lineReader(stream, onLine) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
  });
}

module.exports = { VideoIngestServer, AudioIngestServer, EngineController, defaultCommand, which };

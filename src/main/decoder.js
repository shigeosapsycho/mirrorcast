'use strict';

/**
 * decoder.js — H.264 decode pipeline via a bundled ffmpeg (ffmpeg-static).
 *
 * Design: iOS mirroring delivers an Annex-B H.264 elementary stream. We feed
 * NAL units to ffmpeg's stdin and read back a stream of JPEG frames on stdout,
 * split on the JPEG SOI/EOI markers, then hand each complete frame to the main
 * process to forward to the renderer (drawn on a <canvas>).
 *
 * JPEG-over-IPC is simple and robust across platforms and avoids a native
 * video pipeline. For higher performance one could switch ffmpeg to emit
 * fragmented MP4 and use MSE in the renderer; kept simple here.
 *
 * NOTE: real frames only arrive once the stream is decrypted (FairPlay). Until
 * then this pipeline sits idle. It is fully functional the moment decrypted
 * NALs are written via `writeNAL()`.
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (_) {
  ffmpegPath = null;
}

// JPEG markers for framing stdout.
const SOI = Buffer.from([0xff, 0xd8]); // start of image
const EOI = Buffer.from([0xff, 0xd9]); // end of image

class Decoder extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.fps = opts.fps || 60;
    this.proc = null;
    this.outBuf = Buffer.alloc(0);
    this.running = false;
    this.ready = false;
    this._pending = null; // readable waiting for ffmpeg stdin
  }

  available() {
    return !!ffmpegPath;
  }

  start() {
    if (this.running) return;
    if (!ffmpegPath) {
      this.emit('error', new Error('ffmpeg-static not found — run `npm install`'));
      return;
    }

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-f', 'h264',          // input: raw Annex-B H.264
      '-i', 'pipe:0',
      '-an',                 // (audio handled separately)
      '-f', 'image2pipe',    // output: stream of images
      '-vcodec', 'mjpeg',
      '-q:v', '4',           // JPEG quality (2=best..31=worst)
      '-vf', `fps=${this.fps}`,
      'pipe:1',
    ];

    this.proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.running = true;

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (d) => this.emit('log', `ffmpeg: ${d.toString().trim()}`));
    this.proc.on('error', (err) => {
      this.running = false;
      this.ready = false;
      this.emit('error', err);
    });
    this.proc.on('close', (code) => {
      this.running = false;
      this.ready = false;
      this.emit('log', `ffmpeg exited (${code})`);
      this.emit('close', code);
    });

    this.ready = true;
    this.emit('ready');
    this.emit('log', `decoder started (${ffmpegPath})`);

    // Flush a stream that attached before ffmpeg was up.
    if (this._pending) {
      const r = this._pending;
      this._pending = null;
      this.attach(r);
    }
  }

  /**
   * Pipe a readable H.264 stream (e.g. the ingest socket) straight into
   * ffmpeg's stdin with backpressure handling. Auto-starts the decoder.
   */
  attach(readable) {
    if (!this.running) { this._pending = readable; this.start(); return; }
    if (!this.proc || !this.proc.stdin.writable) { this._pending = readable; return; }
    readable.pipe(this.proc.stdin, { end: false });
    readable.on('error', (e) => this.emit('log', `ingest stream error: ${e.message}`));
  }

  /** Write a decrypted H.264 NAL unit (Annex-B, with start code) to ffmpeg. */
  writeNAL(buf) {
    if (this.running && this.proc && this.proc.stdin.writable) {
      this.proc.stdin.write(buf);
    }
  }

  /** Split ffmpeg's JPEG stream into discrete frames. */
  _onStdout(chunk) {
    this.outBuf = Buffer.concat([this.outBuf, chunk]);
    for (;;) {
      const start = this.outBuf.indexOf(SOI);
      if (start === -1) {
        // no image start yet; keep only a tail to bound memory
        if (this.outBuf.length > 1 << 20) this.outBuf = this.outBuf.slice(-2);
        break;
      }
      const end = this.outBuf.indexOf(EOI, start + 2);
      if (end === -1) break; // frame incomplete
      const frame = this.outBuf.slice(start, end + 2);
      this.outBuf = this.outBuf.slice(end + 2);
      this.emit('frame', frame);
    }
  }

  stop() {
    this.running = false;
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (_) { /* ignore */ }
      try { this.proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
      this.proc = null;
    }
    this.outBuf = Buffer.alloc(0);
  }
}

module.exports = { Decoder, ffmpegPath };

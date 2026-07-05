'use strict';

/**
 * capture.js — save screenshots and recordings to the user's media folders.
 *
 * Screenshots: the renderer sends the canvas as a PNG ArrayBuffer; we write it
 * to Pictures/MirrorCast.
 *
 * Recordings: the renderer runs MediaRecorder over the canvas (+ Web Audio
 * tap) and streams container chunks over IPC; we append them to a file in
 * Videos/MirrorCast. When the renderer recorded H.264-in-WebM we remux to .mp4
 * afterwards with the bundled ffmpeg (stream copy — cheap, no re-encode).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (_) {
  ffmpegPath = null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** First non-existing <dir>/<base>[-N].<ext> — stamp() is 1s-granular, so
 *  rapid captures in the same second must not overwrite each other. */
function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base}-${i}.${ext}`);
  return p;
}

/** Write a PNG buffer to <picturesDir>/MirrorCast; returns the file path. */
async function saveScreenshot(picturesDir, pngBuffer) {
  const dir = path.join(picturesDir, 'MirrorCast');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = uniquePath(dir, `MirrorCast_${stamp()}`, 'png');
  await fs.promises.writeFile(file, pngBuffer);
  return file;
}

/** Remux (no re-encode) webm → mp4. Audio goes Opus → AAC for mp4 compat. */
function remuxToMp4(input, output) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const proc = spawn(ffmpegPath, [
      '-y', '-i', input,
      '-c:v', 'copy', '-c:a', 'aac',
      '-movflags', '+faststart',
      output,
    ], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0 && fs.existsSync(output)));
  });
}

class RecordingSink {
  constructor() {
    this.stream = null;
    this.rawPath = null;
    this.container = null; // 'mp4' | 'webm-h264' | 'webm-vp9'
    this.writeError = null;
  }

  get active() {
    return !!this.stream;
  }

  async start(videosDir, container) {
    if (this.stream) await this.stop(); // finalize a stale session first
    const dir = path.join(videosDir, 'MirrorCast');
    await fs.promises.mkdir(dir, { recursive: true });
    this.container = container;
    const ext = container === 'mp4' ? 'mp4' : 'webm';
    this.rawPath = uniquePath(dir, `MirrorCast_${stamp()}`, ext);
    this.writeError = null;
    this.stream = fs.createWriteStream(this.rawPath);
    // Without a listener a write error (disk full, folder deleted) is an
    // uncaught exception that takes down the main process mid-recording.
    this.stream.on('error', (e) => { this.writeError = e; });
    return this.rawPath;
  }

  write(chunk) {
    if (this.stream) this.stream.write(chunk);
  }

  async stop() {
    if (!this.stream) return { error: 'not recording' };
    const stream = this.stream;
    this.stream = null;
    await new Promise((resolve) => {
      // An errored stream never emits 'finish', so end()'s callback would
      // hang this promise (and the renderer awaiting recStop) forever.
      if (this.writeError || stream.destroyed) return resolve();
      stream.on('error', resolve);
      stream.end(resolve);
    });
    const raw = this.rawPath;
    const container = this.container;
    this.rawPath = null;
    this.container = null;

    if (this.writeError) {
      const msg = this.writeError.message;
      this.writeError = null;
      return { error: `could not write recording: ${msg}` };
    }
    if (container !== 'webm-h264') return { path: raw };
    const mp4 = uniquePath(path.dirname(raw), path.basename(raw, '.webm'), 'mp4');
    if (!(await remuxToMp4(raw, mp4))) return { path: raw }; // keep the webm
    await fs.promises.unlink(raw).catch(() => { /* mp4 exists; webm is extra */ });
    return { path: mp4 };
  }
}

module.exports = { saveScreenshot, RecordingSink };

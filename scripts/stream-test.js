'use strict';

/**
 * stream-test.js — pump a synthetic H.264 test pattern into MirrorCast's video
 * ingest (127.0.0.1:9001) using the bundled ffmpeg.
 *
 * Two uses:
 *   npm run stream-test            → stream to a RUNNING MirrorCast app; you
 *                                    should see the test pattern in the window.
 *                                    (Proves your display path works — no
 *                                    iPhone or FairPlay engine needed.)
 *   node scripts/stream-test.js --selftest
 *                                  → boots an in-process ingest + ffmpeg
 *                                    decoder, streams, and asserts that decoded
 *                                    JPEG frames come out. Headless CI check.
 */

const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { MIRROR_INGEST_PORT } = require('../src/shared/constants');

const selftest = process.argv.includes('--selftest');
const PORT = MIRROR_INGEST_PORT;
const SIZE = '1080x2340';          // iPhone-ish portrait
const DURATION = selftest ? 6 : 30;

function hasEncoder(name) {
  try {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return r.stdout.includes(name);
  } catch (_) { return false; }
}

function ffmpegArgs(encoder) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-re',                                   // stream at real time
    '-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=30`,
    '-t', String(DURATION),
    '-c:v', encoder,
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'baseline',
    '-g', '30',                              // keyframe every second
    '-tune', 'zerolatency',
    '-f', 'h264',                            // raw Annex-B elementary stream
    `tcp://127.0.0.1:${PORT}`,               // connect to the ingest server
  ];
}

function pickEncoder() {
  if (hasEncoder('libx264')) return 'libx264';
  if (hasEncoder('libopenh264')) return 'libopenh264';
  console.error('No H.264 encoder (libx264/libopenh264) in bundled ffmpeg.');
  process.exit(3);
}

function runFfmpeg(onExit) {
  const encoder = pickEncoder();
  console.log(`streaming ${SIZE} H.264 (${encoder}) → 127.0.0.1:${PORT} for ${DURATION}s`);
  const ff = spawn(ffmpegPath, ffmpegArgs(encoder), { stdio: ['ignore', 'ignore', 'inherit'] });
  ff.on('close', (code) => onExit(code));
  ff.on('error', (e) => { console.error('ffmpeg spawn error:', e.message); process.exit(3); });
  return ff;
}

if (!selftest) {
  console.log('Make sure the MirrorCast app is running, then watch its window.');
  runFfmpeg((code) => {
    console.log(`done (ffmpeg exit ${code}). If nothing appeared, MirrorCast may not be running.`);
    process.exit(code === 0 ? 0 : 1);
  });
} else {
  // Headless: boot ingest + decoder, count decoded frames.
  const { Decoder } = require('../src/main/decoder');
  const { VideoIngestServer } = require('../src/main/engine');

  const decoder = new Decoder({ fps: 30 });
  let frames = 0;
  let firstDims = null;
  decoder.on('frame', (jpeg) => {
    frames++;
    if (!firstDims) {
      // JPEG SOF0 marker holds dimensions; just record that we got a real frame.
      firstDims = jpeg.length;
    }
  });
  decoder.on('log', (m) => { if (/error|fail/i.test(m)) console.log('[decoder]', m); });

  const ingest = new VideoIngestServer({ decoder });
  ingest.on('log', (m) => console.log('[ingest]', m));
  ingest.start();

  setTimeout(() => {
    const ff = runFfmpeg((code) => {
      setTimeout(() => {
        ingest.stop();
        decoder.stop();
        console.log(`\nffmpeg exit ${code}; decoded ${frames} JPEG frame(s), first frame ${firstDims} bytes`);
        const ok = frames > 10;
        console.log(ok ? 'SELFTEST PASS — ingest → ffmpeg → frames works' : 'SELFTEST FAIL — no frames');
        process.exit(ok ? 0 : 1);
      }, 500);
    });
    void ff;
  }, 500);

  setTimeout(() => { console.log('SELFTEST TIMEOUT'); process.exit(2); }, (DURATION + 12) * 1000);
}

'use strict';

/**
 * setup-engine.js — detect an installed FairPlay engine and print guidance.
 * Never downloads anything; just checks PATH and tells you how to install +
 * how to wire the engine into MirrorCast's ingest.
 *
 *   npm run engine:check
 */

const { which } = require('../src/main/engine');
const { ENGINE_CANDIDATES, MIRROR_INGEST_PORT } = require('../src/shared/constants');

const plat = process.platform;
console.log('MirrorCast — engine check\n');

let found = null;
for (const cand of ENGINE_CANDIDATES) {
  const p = which(cand);
  if (p) { found = { cand, p }; break; }
}

if (found) {
  console.log(`✓ Found engine: ${found.cand}\n    ${found.p}`);
  console.log('\nMirrorCast (engineMode "auto") will use it automatically.');
  console.log(`Configure its video output to stream H.264 to:\n    tcp://127.0.0.1:${MIRROR_INGEST_PORT}`);
  console.log('\nRecommended UxPlay video-sink (H.264 tee to MirrorCast):');
  console.log(`    uxplay -n "MirrorCast" -nh \\\n      -vs "h264parse ! tcpclientsink host=127.0.0.1 port=${MIRROR_INGEST_PORT}"`);
} else {
  console.log('✗ No FairPlay engine found on PATH.');
  console.log(`  Looked for: ${ENGINE_CANDIDATES.join(', ')}\n`);
  if (plat === 'darwin') {
    console.log('Install on macOS:');
    console.log('    brew install uxplay        # pulls gstreamer + uxplay');
  } else if (plat === 'win32') {
    console.log('Install on Windows:');
    console.log('    UxPlay builds via MSYS2 (needs GStreamer). See:');
    console.log('    https://github.com/FDH2/UxPlay/wiki/Windows');
    console.log('    Then add uxplay(.exe) to PATH, or set "enginePath" in the config.');
  } else {
    console.log('Install on Linux:');
    console.log('    sudo apt install uxplay     # or build from source (FDH2/UxPlay)');
  }
  console.log('\nAfter installing, re-run: npm run engine:check');
  console.log(`Engine must stream decrypted H.264 to tcp://127.0.0.1:${MIRROR_INGEST_PORT}`);
  console.log('to display inside the MirrorCast window. (No engine? The iPhone can');
  console.log('still discover MirrorCast via built-in mode, but video stays blank.)');
}

console.log('\nTip: verify your display path right now, no engine/iPhone needed:');
console.log('    npm start          # in one terminal');
console.log('    npm run stream-test # in another → test pattern appears in the app');

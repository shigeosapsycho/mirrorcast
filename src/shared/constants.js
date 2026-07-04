'use strict';

/**
 * Shared constants for main + renderer.
 * Keep protocol numbers and IPC channel names in one place so both
 * processes agree without importing each other.
 */

// ---------------------------------------------------------------------------
// Network / protocol
// ---------------------------------------------------------------------------

// The AirPlay receiver control port. iOS connects here first and speaks a
// mix of HTTP/1.1 and RTSP (same framing, different methods).
const AIRPLAY_PORT = 7000;

// The mirroring data channel. Encrypted H.264 NAL units arrive here after
// SETUP negotiates it. (AirPlay uses 7100 for the video data stream.)
const MIRROR_DATA_PORT = 7100;

// Localhost-only H.264 ingest. The external FairPlay engine (UxPlay/RPiPlay or
// a custom fork) decrypts the stream and streams the raw Annex-B H.264 here;
// MirrorCast decodes it with ffmpeg and paints it in the app canvas. This is
// the clean contract between the GPL engine (separate process) and the MIT app.
const MIRROR_INGEST_PORT = 9001;

// Localhost-only raw-PCM audio ingest. The engine's audio sink streams S16LE
// PCM here so MirrorCast can play it through Web Audio with a volume slider
// (instead of the engine playing straight to system speakers).
const MIRROR_AUDIO_PORT = 9002;
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 2;

// Bonjour / DNS-SD service types. `_airplay._tcp` is what Control Center →
// Screen Mirroring scans for. `_raop._tcp` (Remote Audio Output Protocol) is
// advertised too for broader audio compatibility.
const SERVICE_AIRPLAY = '_airplay._tcp';
const SERVICE_RAOP = '_raop._tcp';
const MDNS_DOMAIN = 'local';

// AirPlay source version string reported in TXT + /info. Spoofed to a value
// modern iOS trusts.
const SRCVERS = '220.68';

// Model string. iOS gates certain features on known Apple hardware, so we
// spoof a common model for maximum compatibility.
const MODEL = 'MacBookPro18,3';

/**
 * AirPlay feature flags (64-bit, sent as two 32-bit hex words
 * "features=<lo>,<hi>"). This particular value advertises screen mirroring,
 * audio, and the pairing/FairPlay handshake that modern iOS requires.
 * Derived from the widely-used RPiPlay / UxPlay receiver defaults.
 *
 * Notable bits: video (bit 0), audio, mirroring, unified pairing,
 * supports legacy pairing, has-unified-supported-encryption-types.
 */
const FEATURES_LO = 0x5a7ffff7;
const FEATURES_HI = 0x000000 ^ 0x1e; // 0x1E — SupportsUnifiedPairSetupAndMFi etc.
const FEATURES = `0x${FEATURES_LO.toString(16).toUpperCase()},0x${FEATURES_HI.toString(16).toUpperCase()}`;

// status flags TXT record. 0x4 == device configured / ready.
const STATUS_FLAGS = '0x4';

// ---------------------------------------------------------------------------
// Video geometry
// ---------------------------------------------------------------------------

// iPhone reference aspect (e.g. iPhone 14 Pro ~ 1179x2556). We letterbox to
// this so the mirrored screen never stretches.
const IPHONE_ASPECT_W = 9;
const IPHONE_ASPECT_H = 19.5;

// ---------------------------------------------------------------------------
// IPC channels (main <-> renderer)
// ---------------------------------------------------------------------------

const IPC = {
  // main -> renderer
  STATUS_UPDATE: 'status:update',   // { state, deviceName, width, height, fps }
  VIDEO_FRAME: 'video:frame',       // ArrayBuffer (JPEG) — one decoded frame
  AUDIO_PCM: 'audio:pcm',           // { sampleRate, channels, pcm:ArrayBuffer }
  LOG: 'log',                       // { level, msg }
  FIREWALL_BLOCKED: 'firewall:blocked', // { port }

  // renderer -> main
  UI_READY: 'ui:ready',
  SET_NAME: 'settings:set-name',        // string
  SET_AUDIO: 'settings:audio',          // boolean (enabled)
  SET_ALWAYS_ON_TOP: 'settings:always-on-top', // boolean
  GET_CONFIG: 'settings:get-config',    // invoke -> config snapshot

  // engine (external FairPlay receiver) status: main -> renderer
  ENGINE_STATUS: 'engine:status',       // { mode, installed, engine, message }

  // auto-update
  UPDATE_STATUS: 'update:status',       // main -> renderer { state, version, percent, message }
  UPDATE_INSTALL: 'update:install',     // renderer -> main (quit + install)
};

// Connection state machine values shared by main + renderer.
const STATE = {
  STARTING: 'starting',
  WAITING: 'waiting',           // advertised, no client
  PAIRING: 'pairing',           // client connected, handshaking
  CONNECTED: 'connected',       // streaming
  ENGINE_MISSING: 'engine-missing', // no FairPlay engine installed
  ERROR: 'error',
};

// How MirrorCast obtains a decoded stream.
//   external — an installed FairPlay engine (UxPlay/RPiPlay) does the crypto
//   builtin  — pure-JS discovery + handshake only (no decode; demo/dev)
const ENGINE_MODE = {
  AUTO: 'auto',
  EXTERNAL: 'external',
  BUILTIN: 'builtin',
};

// Engine binary names we auto-detect on PATH, in preference order.
const ENGINE_CANDIDATES = ['uxplay', 'RPiPlay', 'rpiplay'];

module.exports = {
  AIRPLAY_PORT,
  MIRROR_DATA_PORT,
  MIRROR_INGEST_PORT,
  MIRROR_AUDIO_PORT,
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  ENGINE_MODE,
  ENGINE_CANDIDATES,
  SERVICE_AIRPLAY,
  SERVICE_RAOP,
  MDNS_DOMAIN,
  SRCVERS,
  MODEL,
  FEATURES,
  FEATURES_LO,
  FEATURES_HI,
  STATUS_FLAGS,
  IPHONE_ASPECT_W,
  IPHONE_ASPECT_H,
  IPC,
  STATE,
};

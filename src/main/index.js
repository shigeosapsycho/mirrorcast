'use strict';

/**
 * index.js — Electron main process.
 *
 * Responsibilities:
 *  - create/persist stable identity (deviceid MAC + ed25519 keypair + name)
 *  - own the BrowserWindow
 *  - start mDNS advertising, the AirPlay control server, and the decoder
 *  - marshal state/frames/logs to the renderer over IPC
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { MdnsAdvertiser } = require('./mdns');
const { AirPlayReceiver } = require('./airplay');
const { Decoder } = require('./decoder');
const { VideoIngestServer, AudioIngestServer, EngineController } = require('./engine');
const { initUpdater } = require('./updater');
const { IPC, STATE, ENGINE_MODE, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS } = require('../shared/constants');

const isDev = process.argv.includes('--dev');

let win = null;
let config = null;
let mdns = null;
let airplay = null;
let decoder = null;
let ingest = null;
let audioIngest = null;
let engine = null;
let updater = null;
let lastUpdateStatus = { state: 'idle' };
let currentState = STATE.STARTING;
let engineStatus = { mode: null, installed: false, engine: null, message: '' };

// ---------------------------------------------------------------------------
// Persistent config (identity + user settings)
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(app.getPath('userData'), 'mirrorcast.config.json');
}

/** Stable random MAC-style device id, e.g. "3A:1F:9C:44:B2:07". */
function randomDeviceId() {
  const b = crypto.randomBytes(6);
  b[0] = (b[0] & 0xfe) | 0x02; // locally-administered, unicast
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (_) { /* first run */ }

  let changed = false;
  if (!stored.deviceId) { stored.deviceId = randomDeviceId(); changed = true; }
  if (!stored.name) { stored.name = os.hostname().split('.')[0] || 'MirrorCast'; changed = true; }
  if (stored.audioEnabled == null) { stored.audioEnabled = true; changed = true; }
  if (stored.alwaysOnTop == null) { stored.alwaysOnTop = false; changed = true; }
  // Engine selection. 'auto' uses an external FairPlay engine if one is found,
  // else falls back to built-in discovery. engineCommand/enginePath override.
  if (!stored.engineMode) { stored.engineMode = ENGINE_MODE.AUTO; changed = true; }
  if (stored.engineCommand === undefined) { stored.engineCommand = null; changed = true; }
  if (stored.enginePath === undefined) { stored.enginePath = null; changed = true; }
  // Video settings. UxPlay defaults to a 30 fps cap; we default to 60.
  if (!stored.videoFps) { stored.videoFps = 60; changed = true; }
  if (!stored.videoQuality) { stored.videoQuality = 75; changed = true; }
  if (stored.theme !== 'light' && stored.theme !== 'dark') { stored.theme = 'dark'; changed = true; }

  // ed25519 identity keypair — persisted as PEM so it stays stable.
  if (!stored.privateKeyPem) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    stored.privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    stored.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    changed = true;
  }

  const privateKey = crypto.createPrivateKey(stored.privateKeyPem);
  const publicKey = crypto.createPublicKey(stored.publicKeyPem);
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyHex = Buffer.from(spkiDer.slice(spkiDer.length - 32)).toString('hex');

  const cfg = {
    ...stored,
    keyPair: { publicKey, privateKey },
    publicKeyHex,
    save() { saveConfig(cfg); },
  };
  if (changed) saveConfig(cfg);
  return cfg;
}

function saveConfig(cfg) {
  const persist = {
    deviceId: cfg.deviceId,
    name: cfg.name,
    audioEnabled: cfg.audioEnabled,
    alwaysOnTop: cfg.alwaysOnTop,
    engineMode: cfg.engineMode,
    engineCommand: cfg.engineCommand,
    enginePath: cfg.enginePath,
    videoFps: cfg.videoFps,
    videoQuality: cfg.videoQuality,
    theme: cfg.theme,
    privateKeyPem: cfg.privateKeyPem,
    publicKeyPem: cfg.publicKeyPem,
  };
  try {
    fs.writeFileSync(configPath(), JSON.stringify(persist, null, 2));
  } catch (e) {
    console.error('config save failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 900,
    minWidth: 360,
    minHeight: 640,
    backgroundColor: '#0d0d0d',
    title: 'MirrorCast',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    alwaysOnTop: config.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function log(msg) {
  if (isDev) console.log('[mirrorcast]', msg);
  send(IPC.LOG, { level: 'info', msg });
}

function pushState(state, extra = {}) {
  currentState = state;
  send(IPC.STATUS_UPDATE, { state, deviceName: config.name, ...extra });
}

function sendEngineStatus() {
  send(IPC.ENGINE_STATUS, engineStatus);
}

/**
 * Built-in discovery: pure-JS mDNS + AirPlay handshake. Makes the iPhone SEE
 * MirrorCast even without an engine (no video decode). Used as the fallback
 * when no engine is installed, and as the explicit 'builtin' demo mode.
 */
function startBuiltinDiscovery() {
  if (mdns || airplay) return; // idempotent

  mdns = new MdnsAdvertiser({
    name: config.name,
    deviceId: config.deviceId,
    publicKeyHex: config.publicKeyHex,
  });
  mdns.on('log', log);
  mdns.on('error', (e) => log(`mdns error: ${e.message}`));
  mdns.start();

  airplay = new AirPlayReceiver({
    name: config.name,
    deviceId: config.deviceId,
    keyPair: config.keyPair,
    publicKeyHex: config.publicKeyHex,
  });
  airplay.on('log', log);
  // In "engine missing" mode keep the ENGINE_MISSING notice sticky; don't let
  // the handshake's WAITING override it. In explicit builtin demo mode, show it.
  airplay.on('state', (s) => { if (engineStatus.mode !== 'missing') pushState(s); });
  airplay.on('firewall-blocked', ({ port, code }) => {
    send(IPC.FIREWALL_BLOCKED, { port, code });
    pushState(STATE.ERROR, { reason: `Port ${port} blocked (${code})` });
  });
  airplay.on('error', (e) => log(`airplay error: ${e.message}`));
  airplay.start();
}

function startServices() {
  // Decoder + localhost H.264 ingest are always on — this is where the mirror
  // actually appears in the app canvas, fed by the external engine.
  decoder = new Decoder({ fps: 60 });
  decoder.on('log', log);
  decoder.on('error', (e) => log(`decoder error: ${e.message}`));

  ingest = new VideoIngestServer({ decoder });
  ingest.on('log', log);
  ingest.on('error', (e) => log(`ingest error: ${e.message}`));
  // Ingest emits unified JPEG frames for BOTH paths: MJPEG passthrough (what
  // UxPlay sends) and H.264 decoded via ffmpeg. Forward them to the renderer.
  //
  // IMPORTANT: the ingest producer socket is UxPlay's tcpclientsink, which
  // connects at ENGINE launch — not when an iPhone connects. So "producer
  // connected" must NOT drive the Connected state (it caused a false
  // "Connected" at idle). Connected = first real video frame; Connecting =
  // engine log reports a client; Waiting = client gone.
  let frameCount = 0;
  let clientName = 'iPhone';
  ingest.on('frame', (jpeg) => {
    frameCount++;
    if (frameCount === 1) {
      log(`first video frame from ${clientName} — Connected`);
      pushState(STATE.CONNECTED, { clientName });
    } else if (frameCount % 300 === 0) {
      log(`video frames received: ${frameCount}`);
    }
    send(IPC.VIDEO_FRAME, jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength));
  });
  ingest.on('stream-start', () => { frameCount = 0; });

  // Audio: engine streams raw PCM here; forward to the renderer's Web Audio,
  // where the volume slider applies gain. Only forward when audio is enabled.
  audioIngest = new AudioIngestServer({});
  audioIngest.on('log', log);
  audioIngest.on('error', (e) => log(`audio ingest error: ${e.message}`));
  // Frame-align (S16 * channels bytes) across TCP chunk boundaries so the
  // renderer's Int16Array never gets an odd length and channels stay in sync.
  const FRAME_BYTES = AUDIO_CHANNELS * 2;
  let pcmLeftover = Buffer.alloc(0);
  // A stale partial frame from a previous producer would misalign every
  // sample after it (permanent static) — reset on each new audio stream.
  audioIngest.on('stream-start', () => { pcmLeftover = Buffer.alloc(0); });
  audioIngest.on('pcm', (chunk) => {
    if (!config.audioEnabled) { pcmLeftover = Buffer.alloc(0); return; }
    const buf = Buffer.concat([pcmLeftover, chunk]);
    const usable = buf.length - (buf.length % FRAME_BYTES);
    pcmLeftover = buf.subarray(usable);
    if (usable === 0) return;
    const aligned = Buffer.from(buf.subarray(0, usable)); // copy -> own ArrayBuffer
    send(IPC.AUDIO_PCM, {
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      pcm: aligned.buffer.slice(aligned.byteOffset, aligned.byteOffset + aligned.byteLength),
    });
  });
  audioIngest.start();
  ingest.on('stream-end', () => {
    pushState(engineStatus.mode === 'missing' ? STATE.ENGINE_MISSING : STATE.WAITING);
  });
  ingest.start();

  const mode = config.engineMode || ENGINE_MODE.AUTO;

  if (mode === ENGINE_MODE.BUILTIN) {
    engineStatus = { mode: 'builtin-demo', installed: false, engine: null,
      message: 'Built-in mode: discovery + handshake only — no video decode.' };
    startBuiltinDiscovery();
    sendEngineStatus();
    pushState(STATE.WAITING);
    return;
  }

  // auto / external — drive a real FairPlay engine.
  engine = new EngineController({
    name: config.name,
    command: config.engineCommand,
    enginePath: config.enginePath,
    fps: config.videoFps,
    quality: config.videoQuality,
    resourcesDir: process.resourcesPath,
  });
  engine.on('log', log);
  engine.on('error', (e) => log(`engine error: ${e.message}`));
  engine.on('ready', ({ engine: engName }) => {
    // Engine owns mDNS + :7000 (its FairPlay stack). We do NOT advertise too.
    engineStatus = { mode: 'external', installed: true, engine: engName,
      message: `Mirroring engine: ${engName}` };
    sendEngineStatus();
    pushState(STATE.WAITING);
  });
  engine.on('client-connected', ({ name }) => {
    if (name) clientName = name;
    // Handshake in progress; Connected is only pushed on the first real frame.
    if (currentState !== STATE.CONNECTED) pushState(STATE.PAIRING);
  });
  engine.on('client-disconnected', () => {
    frameCount = 0;
    pushState(STATE.WAITING);
  });
  engine.on('resolution', ({ width, height }) => pushState(currentState, { width, height }));
  engine.on('crashed', () => pushState(STATE.ERROR, { reason: 'Mirroring engine stopped unexpectedly' }));
  engine.on('missing', () => {
    engineStatus = { mode: 'missing', installed: false, engine: null,
      message: 'No FairPlay engine found. Install UxPlay to mirror video — see README ▸ "Install an engine". The iPhone can still discover MirrorCast.' };
    sendEngineStatus();
    startBuiltinDiscovery();          // still let the phone see us
    pushState(STATE.ENGINE_MISSING);
  });

  engine.start(); // fires 'ready' or 'missing' synchronously
}

function stopServices() {
  if (engine) engine.stop();
  if (ingest) ingest.stop();
  if (audioIngest) audioIngest.stop();
  if (mdns) mdns.stop();
  if (airplay) airplay.stop();
  if (decoder) decoder.stop();
  engine = ingest = audioIngest = mdns = airplay = decoder = null;
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.on(IPC.UI_READY, () => {
    pushState(currentState);
    sendEngineStatus();
    send(IPC.UPDATE_STATUS, lastUpdateStatus);
  });

  ipcMain.on(IPC.UPDATE_INSTALL, () => { if (updater) updater.install(); });

  ipcMain.handle(IPC.GET_CONFIG, () => ({
    name: config.name,
    version: app.getVersion(),
    deviceId: config.deviceId,
    audioEnabled: config.audioEnabled,
    alwaysOnTop: config.alwaysOnTop,
    engineMode: config.engineMode,
    videoFps: config.videoFps,
    videoQuality: config.videoQuality,
    theme: config.theme,
  }));

  ipcMain.on(IPC.SET_THEME, (_e, theme) => {
    config.theme = theme === 'light' ? 'light' : 'dark';
    config.save();
  });

  ipcMain.on(IPC.SET_VIDEO, (_e, v) => {
    const fps = [30, 60].includes(Number(v && v.fps)) ? Number(v.fps) : config.videoFps;
    const quality = Math.min(95, Math.max(30, Number(v && v.quality) || config.videoQuality));
    if (fps === config.videoFps && quality === config.videoQuality) return;
    config.videoFps = fps;
    config.videoQuality = quality;
    config.save();
    log(`video settings: ${fps} fps, JPEG quality ${quality} — restarting engine`);
    if (engine) {
      engine.fps = fps;
      engine.quality = quality;
      engine.restarts = 0;
      engine.stop();
      setTimeout(() => { if (engine) engine.start(); }, 600);
    }
  });

  ipcMain.on(IPC.SET_NAME, (_e, name) => {
    name = String(name || '').trim().slice(0, 40) || config.name;
    if (name === config.name) return;
    config.name = name;
    config.save();
    if (mdns) mdns.rename(name);
    // The engine advertises its own mDNS name (-n) — restart it so the new
    // name actually shows up on the iPhone.
    if (engine) {
      engine.name = name;
      engine.restarts = 0;
      engine.stop();
      setTimeout(() => { if (engine) engine.start(); }, 600);
    }
    pushState(currentState);
    log(`receiver renamed to "${name}"`);
  });

  ipcMain.on(IPC.SET_AUDIO, (_e, enabled) => {
    config.audioEnabled = !!enabled;
    config.save();
    log(`audio ${enabled ? 'enabled' : 'muted'}`);
  });

  ipcMain.on(IPC.SET_ALWAYS_ON_TOP, (_e, on) => {
    config.alwaysOnTop = !!on;
    config.save();
    if (win) win.setAlwaysOnTop(!!on);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Single instance — two receivers would fight over port 7000.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    // No app menu: also disables Alt popping the Windows menu bar.
    // (Kept on macOS, where the system menu carries Cmd+Q/copy/paste.)
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    config = loadConfig();
    registerIpc();
    createWindow();
    startServices();

    // Auto-update against GitHub Releases (no-op in dev / unpackaged).
    updater = initUpdater({
      isDev,
      isPackaged: app.isPackaged,
      onStatus: (s) => { lastUpdateStatus = s; send(IPC.UPDATE_STATUS, s); },
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS: app stays alive with the window closed — keep services running
    // so the receiver still works and `activate` gets a live app back.
    if (process.platform !== 'darwin') {
      stopServices();
      app.quit();
    }
  });

  app.on('before-quit', stopServices);
}

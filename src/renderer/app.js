'use strict';

/**
 * app.js — renderer UI logic. Talks to main only through window.mirrorcast
 * (see preload.js). Draws decoded JPEG frames to a canvas, tracks FPS, drives
 * the status bar + settings panel + Web Audio playback.
 */

const api = window.mirrorcast;

// ---- element refs ---------------------------------------------------------
const el = {
  frame: document.getElementById('phone-frame'),
  canvas: document.getElementById('screen'),
  waiting: document.getElementById('waiting'),
  waitingName: document.getElementById('waiting-name'),
  errorOverlay: document.getElementById('error-overlay'),
  errorTitle: document.getElementById('error-title'),
  errorBody: document.getElementById('error-body'),

  engineOverlay: document.getElementById('engine-overlay'),
  engineBody: document.getElementById('engine-body'),
  engineCta: document.getElementById('engine-cta'),

  statusbar: document.getElementById('statusbar'),
  sbEngine: document.getElementById('sb-engine'),
  sbName: document.getElementById('sb-name'),
  sbLed: document.getElementById('sb-led'),
  sbStateText: document.getElementById('sb-state-text'),
  sbRes: document.getElementById('sb-res'),
  sbFps: document.getElementById('sb-fps'),

  gear: document.getElementById('gear'),
  settings: document.getElementById('settings'),
  scrim: document.getElementById('scrim'),
  settingsClose: document.getElementById('settings-close'),
  nameInput: document.getElementById('name-input'),
  audioToggle: document.getElementById('audio-toggle'),
  aotToggle: document.getElementById('aot-toggle'),
  devId: document.getElementById('dev-id'),

  mute: document.getElementById('mute'),
  muteOn: document.getElementById('mute-on'),
  muteOff: document.getElementById('mute-off'),
  volSlider: document.getElementById('vol-slider'),
};

const ctx = el.canvas.getContext('2d', { alpha: false });

// ---- FPS tracking ---------------------------------------------------------
let frameCount = 0;
let lastFpsTs = performance.now();
setInterval(() => {
  const now = performance.now();
  const fps = Math.round((frameCount * 1000) / (now - lastFpsTs));
  el.sbFps.textContent = `${fps} fps`;
  frameCount = 0;
  lastFpsTs = now;
}, 1000);

// ---- Video frame rendering ------------------------------------------------
// Frames arrive as JPEG ArrayBuffers. Decode via createImageBitmap (fast,
// off the main thread) and paint to the canvas at its native pixel size.
let pendingBitmap = null;
let rafScheduled = false;

api.onFrame(async (arrayBuffer) => {
  try {
    const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
    const bmp = await createImageBitmap(blob);
    if (pendingBitmap) pendingBitmap.close();
    pendingBitmap = bmp;
    frameCount++;
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(paint);
    }
  } catch (_) { /* drop malformed frame */ }
});

function paint() {
  rafScheduled = false;
  const bmp = pendingBitmap;
  if (!bmp) return;
  if (el.canvas.width !== bmp.width || el.canvas.height !== bmp.height) {
    el.canvas.width = bmp.width;
    el.canvas.height = bmp.height;
    el.sbRes.textContent = `${bmp.width}×${bmp.height}`;
  }
  ctx.drawImage(bmp, 0, 0);
  if (!el.frame.classList.contains('streaming')) {
    el.frame.classList.add('streaming');
    updateOverlays();
  }
}

// ---- Status updates -------------------------------------------------------
const STATE_LABEL = {
  starting: 'Starting…',
  waiting: 'Waiting…',
  pairing: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
};

api.onStatus((s) => {
  const name = s.deviceName || 'MirrorCast';
  el.sbName.textContent = name;
  el.waitingName.textContent = name;
  if (!document.activeElement || document.activeElement !== el.nameInput) {
    // don't clobber while user is typing
  }

  const state = s.state || 'waiting';
  el.sbStateText.textContent =
    state === 'connected' && s.clientName ? `Connected: ${s.clientName}` : STATE_LABEL[state] || state;

  // Namespace the LED state class — bare state names (e.g. "waiting") collide
  // with overlay classes like .waiting and blow the 8px dot up to an overlay.
  const ledState = state === 'engine-missing' ? 'error'
    : state === 'connected' ? 'connected'
    : state === 'error' ? 'error'
    : 'waiting';
  el.sbLed.className = 'sb-led led-' + ledState;
  el.statusbar.classList.toggle('connected', state === 'connected');

  if (state === 'error' && s.reason) {
    el.errorTitle.textContent = 'Connection problem';
    el.errorBody.textContent = s.reason;
  }
  if (state !== 'connected' && state !== 'pairing') {
    el.frame.classList.remove('streaming'); // clear stale mirror view
    el.sbRes.textContent = '—';
  }
  lastState = state;
  updateOverlays();
});

// Centralized overlay visibility so waiting / engine / error never stack.
let lastState = 'starting';
let engineMode = null;
function updateOverlays() {
  const streaming = el.frame.classList.contains('streaming');
  const showError = lastState === 'error';
  const showEngine = !showError && !streaming && engineMode === 'missing';
  el.errorOverlay.classList.toggle('hidden', !showError);
  el.engineOverlay.classList.toggle('hidden', !showEngine);
  el.waiting.classList.toggle('hidden', streaming || showError || showEngine);
}

// ---- Engine status --------------------------------------------------------
api.onEngineStatus((st) => {
  engineMode = st.mode;
  const label = st.mode === 'external' ? (st.engine || 'engine')
    : st.mode === 'missing' ? 'no engine'
    : st.mode === 'builtin-demo' ? 'built-in'
    : '—';
  el.sbEngine.textContent = '⚙︎ ' + label;
  el.sbEngine.className = 'sb-item sb-engine ' + (st.mode === 'external' ? 'external' : st.mode === 'missing' ? 'missing' : '');
  el.sbEngine.title = st.message || 'Mirroring engine';
  if (st.message && st.mode !== 'external') el.engineBody.textContent = st.message;
  updateOverlays();
});

// ---- Firewall block -------------------------------------------------------
api.onFirewallBlocked(({ port, code }) => {
  el.errorOverlay.classList.remove('hidden');
  el.errorTitle.textContent = 'Port blocked by firewall';
  el.errorBody.innerHTML =
    `MirrorCast couldn't open port <b>${port}</b> (${code || 'blocked'}).<br>` +
    `Allow <b>MirrorCast</b> through Windows Defender Firewall on <b>Private</b> networks, then restart the app.`;
});

// Engine install helper — expand inline, per-OS commands (no network needed).
el.engineCta.addEventListener('click', (e) => {
  e.preventDefault();
  const isMac = /Mac/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent);
  const steps = isMac
    ? 'macOS:  brew install uxplay\nThen restart MirrorCast — it auto-detects UxPlay on PATH.'
    : 'Windows:  install UxPlay via MSYS2 (see README ▸ "Install an engine"),\nor set a custom engine command in the config file. Then restart MirrorCast.';
  el.engineBody.style.whiteSpace = 'pre-line';
  el.engineBody.textContent = steps;
  el.engineCta.textContent = 'Point it at 127.0.0.1:9001 for in-app video';
  el.engineCta.style.pointerEvents = 'none';
});

// ---- Auto-update ----------------------------------------------------------
const updateBanner = document.getElementById('update-banner');
const updateText = document.getElementById('update-text');
const updateBtn = document.getElementById('update-btn');

api.onUpdateStatus((u) => {
  switch (u.state) {
    case 'available':
      updateBanner.classList.remove('hidden');
      updateText.textContent = `Downloading MirrorCast ${u.version || ''}…`;
      updateBtn.classList.add('hidden');
      break;
    case 'progress':
      updateBanner.classList.remove('hidden');
      updateText.textContent = `Downloading update… ${u.percent ?? 0}%`;
      break;
    case 'ready':
      updateBanner.classList.remove('hidden');
      updateText.textContent = `MirrorCast ${u.version || ''} is ready.`;
      updateBtn.classList.remove('hidden');
      break;
    case 'error':
      updateBanner.classList.add('hidden');
      break;
    default: // idle / checking / none / disabled
      updateBanner.classList.add('hidden');
  }
});
updateBtn.addEventListener('click', () => api.installUpdate());

// ---- Logs (dev) -----------------------------------------------------------
api.onLog(({ msg }) => console.debug('[main]', msg));

// ---- Settings panel -------------------------------------------------------
function openSettings() {
  el.settings.classList.add('open');
  el.scrim.classList.remove('hidden');
  requestAnimationFrame(() => el.scrim.classList.add('show'));
  el.settings.setAttribute('aria-hidden', 'false');
}
function closeSettings() {
  el.settings.classList.remove('open');
  el.scrim.classList.remove('show');
  el.settings.setAttribute('aria-hidden', 'true');
  setTimeout(() => el.scrim.classList.add('hidden'), 300);
}
el.gear.addEventListener('click', openSettings);
el.settingsClose.addEventListener('click', closeSettings);
el.scrim.addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

// Swallow Alt so it never focuses a (removed) menu bar or steals key focus.
window.addEventListener('keydown', (e) => { if (e.key === 'Alt') e.preventDefault(); });
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') e.preventDefault(); });

// name (debounced apply)
let nameTimer = null;
el.nameInput.addEventListener('input', () => {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => api.setName(el.nameInput.value), 400);
});

// ---- Video settings (FPS / quality segmented controls) ---------------------
const fpsSeg = document.getElementById('fps-seg');
const qualitySeg = document.getElementById('quality-seg');
let selFps = 60;
let selQuality = 75;
let videoApplyTimer = null;

function setSegActive(seg, attr, val) {
  for (const b of seg.querySelectorAll('button')) {
    b.classList.toggle('active', Number(b.dataset[attr]) === val);
  }
}

function queueVideoApply() {
  // Debounce so picking fps then quality causes one engine restart, not two.
  clearTimeout(videoApplyTimer);
  videoApplyTimer = setTimeout(() => api.setVideo({ fps: selFps, quality: selQuality }), 500);
}

fpsSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  selFps = Number(btn.dataset.fps);
  setSegActive(fpsSeg, 'fps', selFps);
  queueVideoApply();
});

qualitySeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  selQuality = Number(btn.dataset.q);
  setSegActive(qualitySeg, 'q', selQuality);
  queueVideoApply();
});

el.audioToggle.addEventListener('change', () => {
  muted = !el.audioToggle.checked;
  if (!muted && volume === 0) volume = 1;
  applyGain();
  api.setAudio(!muted && volume > 0);
});
el.aotToggle.addEventListener('change', () => api.setAlwaysOnTop(el.aotToggle.checked));

// ---- Volume + mute --------------------------------------------------------
let muted = false;
let volume = 1; // 0..1

function applyGain() {
  if (audio) audio.gain.gain.value = muted ? 0 : volume;
  const silent = muted || volume === 0;
  el.mute.classList.toggle('muted', silent);
  el.muteOn.classList.toggle('hidden', silent);
  el.muteOff.classList.toggle('hidden', !silent);
  el.volSlider.value = String(Math.round((muted ? 0 : volume) * 100));
  el.audioToggle.checked = !silent; // keep settings master-toggle in sync
}

el.mute.addEventListener('click', () => {
  muted = !muted;
  applyGain();
  api.setAudio(!muted && volume > 0);
});

el.volSlider.addEventListener('input', () => {
  volume = Number(el.volSlider.value) / 100;
  muted = false;
  applyGain();
  api.setAudio(volume > 0);
});

// ---- Web Audio playback ---------------------------------------------------
// Main sends decoded PCM (Int16, interleaved). We schedule it gaplessly.
let audio = null;
function ensureAudio(sampleRate, channels) {
  if (audio && audio.sampleRate === sampleRate && audio.channels === channels) return audio;
  if (audio) audio.ctx.close();
  const actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
  const gain = actx.createGain();
  gain.gain.value = muted ? 0 : volume;
  gain.connect(actx.destination);
  audio = { ctx: actx, gain, sampleRate, channels, playHead: actx.currentTime };
  return audio;
}

api.onAudio(({ sampleRate, channels, pcm }) => {
  if (muted || volume === 0) return;
  const a = ensureAudio(sampleRate || 44100, channels || 2);
  const i16 = new Int16Array(pcm);
  const frames = i16.length / a.channels;
  const buffer = a.ctx.createBuffer(a.channels, frames, a.sampleRate);
  for (let ch = 0; ch < a.channels; ch++) {
    const out = buffer.getChannelData(ch);
    for (let i = 0; i < frames; i++) out[i] = i16[i * a.channels + ch] / 32768;
  }
  const src = a.ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(a.gain);
  const now = a.ctx.currentTime;
  if (a.playHead < now) a.playHead = now + 0.02; // small lead to avoid underrun
  src.start(a.playHead);
  a.playHead += buffer.duration;
});

// ---- Boot -----------------------------------------------------------------
(async function boot() {
  try {
    const cfg = await api.getConfig();
    el.nameInput.value = cfg.name || '';
    el.audioToggle.checked = cfg.audioEnabled !== false;
    el.aotToggle.checked = !!cfg.alwaysOnTop;
    el.devId.textContent = `device ${cfg.deviceId || '—'}`;
    selFps = cfg.videoFps || 60;
    selQuality = cfg.videoQuality || 75;
    setSegActive(fpsSeg, 'fps', selFps);
    setSegActive(qualitySeg, 'q', selQuality);
    muted = cfg.audioEnabled === false;
    applyGain();
  } catch (_) { /* main not ready yet; status will follow */ }
  api.ready();
})();

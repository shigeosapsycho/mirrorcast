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
  appVersion: document.getElementById('app-version'),

  mute: document.getElementById('mute'),
  muteOn: document.getElementById('mute-on'),
  muteOff: document.getElementById('mute-off'),
  volSlider: document.getElementById('vol-slider'),

  shot: document.getElementById('shot'),
  rec: document.getElementById('rec'),
  recTime: document.getElementById('rec-time'),
  toast: document.getElementById('toast'),
  pinLine: document.getElementById('pin-line'),
  pinCode: document.getElementById('pin-code'),
  pinToggle: document.getElementById('pin-toggle'),
};

const ctx = el.canvas.getContext('2d', { alpha: false });

// ---- FPS tracking ---------------------------------------------------------
// Rolling 2s window over frame ARRIVAL TIMES. A plain per-second bucket reads
// high when TCP delivers frames in bursts (several JPEGs per chunk): 62 frames
// can land inside one 980ms bucket and display as "63 fps" even though the
// true rate is capped. Rate over the window's actual time span is burst-immune.
const FPS_WINDOW_MS = 2000;
const frameTimes = [];

function noteFrame() {
  const now = performance.now();
  frameTimes.push(now);
  while (frameTimes.length && frameTimes[0] < now - FPS_WINDOW_MS) frameTimes.shift();
}

setInterval(() => {
  const cutoff = performance.now() - FPS_WINDOW_MS;
  while (frameTimes.length && frameTimes[0] < cutoff) frameTimes.shift(); // decay when stream stops
  const n = frameTimes.length;
  let fps = 0;
  if (n >= 2) {
    const span = frameTimes[n - 1] - frameTimes[0];
    if (span > 0) fps = Math.round(((n - 1) * 1000) / span);
  }
  el.sbFps.textContent = `${fps} fps`;
}, 500);

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
    noteFrame();
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
  'engine-missing': 'No engine',
  error: 'Error',
};

api.onStatus((s) => {
  const name = s.deviceName || 'MirrorCast';
  el.waitingName.textContent = name; // name lives in the waiting overlay only now

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
    stopRecording(); // stream is gone — finalize the file
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
  // Capture only makes sense with live frames; keep Record clickable while a
  // recording is finalizing so Stop always works.
  el.shot.disabled = !streaming;
  el.rec.disabled = !streaming && !recorder;
}

// ---- Engine status --------------------------------------------------------
// No statusbar badge — engine problems surface via the engine overlay.
api.onEngineStatus((st) => {
  engineMode = st.mode;
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (el.settings.classList.contains('open')) closeSettings();
    else if (isFullscreen) api.setFullscreen(false);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    takeScreenshot();
  } else if (e.key === 'F11') {
    e.preventDefault();
    api.setFullscreen(null); // toggle
  }
});

// ---- Theme toggle -----------------------------------------------------------
const themeBtn = document.getElementById('theme-btn');
const themeSun = document.getElementById('theme-sun');
const themeMoon = document.getElementById('theme-moon');
let theme = 'dark';

function applyTheme(t) {
  theme = t === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  // show the icon of the mode a click will switch TO
  themeSun.classList.toggle('hidden', theme === 'light');
  themeMoon.classList.toggle('hidden', theme === 'dark');
}

themeBtn.addEventListener('click', () => {
  applyTheme(theme === 'dark' ? 'light' : 'dark');
  api.setTheme(theme);
});

// ---- Floating controls dissolve unless the pointer is near -----------------
const floatBtns = [themeBtn, el.gear];
const NEAR_PX = 110;
let lastProximityTs = 0;

function updateBtnProximity(mx, my) {
  for (const btn of floatBtns) {
    const r = btn.getBoundingClientRect();
    const near = Math.hypot(mx - (r.x + r.width / 2), my - (r.y + r.height / 2)) < NEAR_PX;
    btn.classList.toggle('visible', near || btn === document.activeElement);
  }
}

// Timestamp throttle — NOT requestAnimationFrame: rAF pauses in occluded
// windows, which would latch the throttle shut and kill proximity forever.
window.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastProximityTs < 33) return;
  lastProximityTs = now;
  updateBtnProximity(e.clientX, e.clientY);
});
window.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget) floatBtns.forEach((b) => b.classList.remove('visible'));
});

// Boot grace: show both briefly so their position is discoverable.
floatBtns.forEach((b) => b.classList.add('visible'));
setTimeout(() => updateBtnProximity(-9999, -9999), 2600);

// Swallow Alt so it never focuses a (removed) menu bar or steals key focus.
window.addEventListener('keydown', (e) => { if (e.key === 'Alt') e.preventDefault(); });
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') e.preventDefault(); });

// name (debounced apply)
let nameTimer = null;
el.nameInput.addEventListener('input', () => {
  clearTimeout(nameTimer);
  // Long debounce: applying a rename restarts the engine, so wait until the
  // user has clearly stopped typing.
  nameTimer = setTimeout(() => api.setName(el.nameInput.value), 900);
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
el.pinToggle.addEventListener('change', () => api.setRequirePin(el.pinToggle.checked));

// ---- Pairing PIN ------------------------------------------------------------
// Main relays the engine's per-session code; visible inside the waiting overlay
// (auto-hidden once frames stream).
api.onPin((p) => {
  const pin = p && p.pin;
  el.pinLine.classList.toggle('hidden', !pin);
  el.pinCode.textContent = pin || '····';
});

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

// ---- Toast ------------------------------------------------------------------
let toastTimer = null;
let toastClick = null;

function showToast(text, onClick) {
  el.toast.textContent = text;
  toastClick = onClick || null;
  el.toast.classList.toggle('clickable', !!onClick);
  el.toast.classList.remove('hidden');
  requestAnimationFrame(() => el.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() {
  el.toast.classList.remove('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 300);
}
el.toast.addEventListener('click', () => {
  if (toastClick) toastClick();
  hideToast();
});

// ---- Screenshot ---------------------------------------------------------------
let shotBusy = false;

async function takeScreenshot() {
  if (el.shot.disabled || shotBusy) return;
  shotBusy = true;
  try {
    const blob = await new Promise((resolve) => el.canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas capture failed');
    const res = await api.saveScreenshot(await blob.arrayBuffer());
    if (res && res.path) {
      showToast('Screenshot saved — click to open folder', () => api.showInFolder(res.path));
    } else {
      throw new Error((res && res.error) || 'save failed');
    }
  } catch (err) {
    showToast(`Screenshot failed: ${err.message}`);
  }
  shotBusy = false;
}
el.shot.addEventListener('click', takeScreenshot);

// ---- Screen recording ---------------------------------------------------------
// MediaRecorder over the canvas stream (+ a Web Audio tap when audio is live).
// Chunks stream to main, which writes Videos/MirrorCast and remuxes
// H.264-in-WebM to .mp4. Prefer H.264 mimetypes: stream-copy remux, and VP9
// software encode can't keep up at 60 fps phone resolutions.
let recorder = null;
let recChain = Promise.resolve(); // serializes chunk arrayBuffer() -> IPC order
let recTimer = null;
let recAudioTap = null;
let recStartedAt = 0;

function pickRecFormat() {
  const candidates = [
    ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=h264,opus', 'webm-h264'],
    ['video/webm;codecs=vp9,opus', 'webm-vp9'],
    ['video/webm', 'webm-vp9'],
  ];
  for (const [mime, container] of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(mime)) return { mime, container };
  }
  return null;
}

async function startRecording() {
  if (recorder || el.rec.disabled) return;
  const fmt = pickRecFormat();
  if (!fmt) { showToast('Recording is not supported on this system'); return; }

  const stream = el.canvas.captureStream(); // frames captured as they paint
  // Pre-create the audio pipeline: MediaRecorder snapshots its tracks at
  // construction, so audio that starts after recording began would otherwise
  // be lost forever. An idle context records silence until PCM flows in.
  const a = ensureAudio(44100, 2);
  recAudioTap = a.ctx.createMediaStreamDestination();
  a.gain.connect(recAudioTap); // post-volume mix, same as the speakers
  for (const t of recAudioTap.stream.getAudioTracks()) stream.addTrack(t);

  const res = await api.recStart({ container: fmt.container });
  if (res && res.error) {
    showToast(`Recording failed: ${res.error}`);
    cleanupAudioTap();
    return;
  }

  recorder = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 12e6 });
  recChain = Promise.resolve();
  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    recChain = recChain.then(async () => { api.recChunk(await e.data.arrayBuffer()); });
  };
  recorder.onstop = finishRecording;
  recorder.start(1000); // 1s chunks

  recStartedAt = performance.now();
  el.rec.classList.add('rec-on');
  el.rec.title = 'Stop recording';
  el.recTime.textContent = '0:00';
  el.recTime.classList.remove('hidden');
  recTimer = setInterval(() => {
    const s = Math.floor((performance.now() - recStartedAt) / 1000);
    el.recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function cleanupAudioTap() {
  if (recAudioTap && audio) {
    try { audio.gain.disconnect(recAudioTap); } catch (_) { /* ctx may be gone */ }
  }
  recAudioTap = null;
}

async function finishRecording() {
  const rec = recorder;
  recorder = null;
  clearInterval(recTimer);
  el.rec.classList.remove('rec-on');
  el.rec.title = 'Record';
  el.recTime.classList.add('hidden');
  cleanupAudioTap();
  if (rec) for (const t of rec.stream.getTracks()) t.stop();
  updateOverlays(); // refresh button enablement

  await recChain; // every chunk is in main's write stream before we finalize
  const res = await api.recStop();
  if (res && res.path) {
    showToast('Recording saved — click to open folder', () => api.showInFolder(res.path));
  } else if (res && res.error && res.error !== 'not recording') {
    showToast(`Recording failed: ${res.error}`);
  }
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

el.rec.addEventListener('click', () => (recorder ? stopRecording() : startRecording()));

// ---- Fullscreen -----------------------------------------------------------------
// Double-click the mirror (or F11) to fill the window; Esc exits. Chrome (status
// bar + gear) hides and slides back while the mouse moves.
let isFullscreen = false;
let chromeTimer = null;

api.onFullscreen((fs) => {
  isFullscreen = !!fs;
  document.body.classList.toggle('fullscreen', isFullscreen);
  document.body.classList.remove('chrome');
  clearTimeout(chromeTimer);
});

el.frame.addEventListener('dblclick', () => api.setFullscreen(null));

window.addEventListener('mousemove', () => {
  if (!isFullscreen) return;
  document.body.classList.add('chrome');
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => document.body.classList.remove('chrome'), 2500);
});

// ---- Boot -----------------------------------------------------------------
(async function boot() {
  try {
    const cfg = await api.getConfig();
    el.nameInput.value = cfg.name || '';
    el.audioToggle.checked = cfg.audioEnabled !== false;
    el.aotToggle.checked = !!cfg.alwaysOnTop;
    el.appVersion.textContent = `MirrorCast v${cfg.version || '1.0.0'}`;
    applyTheme(cfg.theme || 'dark');
    el.pinToggle.checked = !!cfg.requirePin;
    selFps = cfg.videoFps || 60;
    selQuality = cfg.videoQuality || 75;
    setSegActive(fpsSeg, 'fps', selFps);
    setSegActive(qualitySeg, 'q', selQuality);
    muted = cfg.audioEnabled === false;
    applyGain();
  } catch (_) { /* main not ready yet; status will follow */ }
  api.ready();
})();

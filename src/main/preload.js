'use strict';

/**
 * preload.js — secure bridge between the sandboxed renderer and main.
 * Exposes a tiny, explicit API on window.mirrorcast; no raw ipcRenderer.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/constants');

contextBridge.exposeInMainWorld('mirrorcast', {
  // ---- subscribe to main -> renderer events -------------------------------
  onStatus: (cb) => sub(IPC.STATUS_UPDATE, cb),
  onFrame: (cb) => sub(IPC.VIDEO_FRAME, cb),
  onAudio: (cb) => sub(IPC.AUDIO_PCM, cb),
  onLog: (cb) => sub(IPC.LOG, cb),
  onFirewallBlocked: (cb) => sub(IPC.FIREWALL_BLOCKED, cb),
  onEngineStatus: (cb) => sub(IPC.ENGINE_STATUS, cb),
  onUpdateStatus: (cb) => sub(IPC.UPDATE_STATUS, cb),

  // ---- renderer -> main ---------------------------------------------------
  ready: () => ipcRenderer.send(IPC.UI_READY),
  installUpdate: () => ipcRenderer.send(IPC.UPDATE_INSTALL),
  setName: (name) => ipcRenderer.send(IPC.SET_NAME, name),
  setAudio: (enabled) => ipcRenderer.send(IPC.SET_AUDIO, enabled),
  setAlwaysOnTop: (on) => ipcRenderer.send(IPC.SET_ALWAYS_ON_TOP, on),
  getConfig: () => ipcRenderer.invoke(IPC.GET_CONFIG),
});

function sub(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

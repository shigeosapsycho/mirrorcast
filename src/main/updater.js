'use strict';

/**
 * updater.js — auto-updates via electron-updater against GitHub Releases.
 *
 * Publishing is configured in electron-builder.yml (provider: github). At
 * runtime the packaged app reads app-update.yml and polls the Releases feed.
 * Disabled in dev / unpackaged runs so local work never hits the network.
 */

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null; // dependency not installed yet
}

/**
 * @param {object} o
 * @param {boolean} o.isDev
 * @param {boolean} o.isPackaged
 * @param {(status:object)=>void} o.onStatus
 * @returns {{check:Function, install:Function}}
 */
function initUpdater({ isDev, isPackaged, onStatus }) {
  const noop = { check() {}, install() {} };

  if (isDev || !isPackaged || !autoUpdater) {
    onStatus({ state: 'disabled', message: isPackaged ? 'updater unavailable' : 'dev build' });
    return noop;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => onStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => onStatus({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => onStatus({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => onStatus({ state: 'progress', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => onStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => onStatus({ state: 'error', message: String((err && err.message) || err) }));

  // Kick an initial check; ignore rejection (offline etc.).
  autoUpdater.checkForUpdates().catch(() => {});
  // Re-check every 6 hours while running.
  const timer = setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();

  return {
    check: () => autoUpdater.checkForUpdates().catch(() => {}),
    install: () => { try { autoUpdater.quitAndInstall(); } catch (_) { /* ignore */ } },
  };
}

module.exports = { initUpdater };

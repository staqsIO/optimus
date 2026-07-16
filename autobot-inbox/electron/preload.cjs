const { contextBridge } = require('electron');

/**
 * Preload script — minimal bridge between renderer and main process.
 * contextIsolation: true means the renderer can't access Node.js directly.
 * Only expose what's explicitly needed.
 */
contextBridge.exposeInMainWorld('autobot', {
  platform: process.platform,
  isElectron: true,
});

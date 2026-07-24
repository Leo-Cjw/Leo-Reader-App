const { contextBridge, ipcRenderer } = require('electron');

const allowedCommands = new Set(['new', 'search', 'edit', 'settings', 'data-safety', 'toggle-ai']);

contextBridge.exposeInMainWorld('readerDesktop', Object.freeze({
  platform: process.platform,
  onCommand(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, command) => {
      if (allowedCommands.has(command)) callback(command);
    };
    ipcRenderer.on('reader:command', handler);
    return () => ipcRenderer.removeListener('reader:command', handler);
  }
}));

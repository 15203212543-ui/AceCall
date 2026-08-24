const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acecallDesktop', {
  getPlatform: () => ipcRenderer.invoke('platform'),
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  start: directory => ipcRenderer.invoke('start-sync', directory),
  stop: () => ipcRenderer.invoke('stop-sync'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  onStatus: callback => ipcRenderer.on('sync-status', (_event, status) => callback(status))
});

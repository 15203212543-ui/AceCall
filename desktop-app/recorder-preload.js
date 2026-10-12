const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acecallRecorder', {
  onStart: callback => ipcRenderer.on('recording-start', (_event, payload) => callback(payload)),
  onStop: callback => ipcRenderer.on('recording-stop', callback),
  sendChunk: chunk => ipcRenderer.send('recording-chunk', chunk),
  stopped: payload => ipcRenderer.send('recording-stopped', payload)
});

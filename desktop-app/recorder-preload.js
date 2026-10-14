const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acecallRecorder', {
  onStart: callback => ipcRenderer.on('recording-start', (_event, payload) => callback(payload)),
  onStop: callback => ipcRenderer.on('recording-stop', callback),
  sendChunk: chunk => ipcRenderer.send('recording-chunk', chunk),
  ready: payload => ipcRenderer.send('recording-ready', payload),
  failed: error => ipcRenderer.send('recording-error', { name: error?.name || 'RecordingError', message: error?.message || '无法访问麦克风' }),
  stopped: payload => ipcRenderer.send('recording-stopped', payload)
});

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { SyncAgent, platformPolicy } = require('./local-sync-agent');

let window;
let agent;
let currentDirectory = '';
let recorderWindow;
let recording = { status: 'idle', startedAt: null, filePath: '', bytes: 0 };
let localServer;
const LOCAL_PORT = Number(process.env.ACECALL_AGENT_PORT || 17890);
let sessionToken = process.env.ACECALL_AUTH_TOKEN || '';

function sendStatus(status, message = '') { window?.webContents.send('sync-status', { status, message, directory: currentDirectory }); }

function createWindow() {
  window = new BrowserWindow({ width: 760, height: 560, minWidth: 620, minHeight: 460, title: 'AceCall Sync', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  window.loadFile(path.join(__dirname, 'renderer.html'));
  window.on('close', event => { if (!app.isQuitting) { event.preventDefault(); window.hide(); } });
}

async function stopAgent() {
  if (!agent) return;
  await agent.stop(); agent = null; sendStatus('stopped', '监听已暂停');
}

async function startAgent(directory) {
  await stopAgent();
  currentDirectory = directory;
  const options = { directory, interval: 300000, once: false, apiBase: process.env.ACECALL_API_BASE || '', authToken: process.env.ACECALL_AUTH_TOKEN || '' };
  agent = new SyncAgent(options);
  await agent.start();
  sendStatus('running', `${platformPolicy().label}正在监听`);
}

function cors(response) {
  response.setHeader('Access-Control-Allow-Origin', 'https://15203212543-ui.github.io');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function startRecorder() {
  if (recording.status === 'recording') return recording;
  const recordingDirectory = path.join(app.getPath('userData'), 'recordings');
  await fsp.mkdir(recordingDirectory, { recursive: true });
  const filePath = path.join(recordingDirectory, `call-${Date.now()}.webm`);
  recorderWindow = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'recorder-preload.js'), contextIsolation: true, nodeIntegration: false } });
  recorderWindow.on('closed', () => { recorderWindow = null; });
  recorderWindow.loadFile(path.join(__dirname, 'recorder.html'));
  await new Promise(resolve => recorderWindow.webContents.once('did-finish-load', resolve));
  recording = { status: 'recording', startedAt: new Date().toISOString(), filePath, bytes: 0 };
  recorderWindow.webContents.send('recording-start', { filePath });
  return { status: recording.status, startedAt: recording.startedAt };
}

async function stopRecorder() {
  if (!recorderWindow || recording.status !== 'recording') return recording;
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({}), 10000);
    ipcMain.once('recording-stopped', (_event, payload) => { clearTimeout(timer); resolve(payload || {}); });
    recorderWindow.webContents.send('recording-stop');
  });
  recording = { ...recording, ...result, status: 'stopped', stoppedAt: new Date().toISOString() };
  recorderWindow.close(); recorderWindow = null;
  return { status: recording.status, filePath: recording.filePath, bytes: recording.bytes, startedAt: recording.startedAt, stoppedAt: recording.stoppedAt };
}

function startLocalServer() {
  localServer = http.createServer(async (request, response) => {
    cors(response);
    if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/status') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return response.end(JSON.stringify({ ok: true, service: 'acecall-desktop-agent', platform: process.platform, authenticated: Boolean(sessionToken), recording, sync: { status: agent ? 'running' : 'stopped', directory: currentDirectory } }));
    }
    if (request.method === 'GET' && url.pathname === '/recording/file' && recording.status === 'stopped' && recording.filePath) {
      try {
        const stat = await fsp.stat(recording.filePath);
        response.writeHead(200, { 'Content-Type': 'audio/webm', 'Content-Length': stat.size, 'Content-Disposition': 'inline' });
        return fs.createReadStream(recording.filePath).pipe(response);
      } catch { response.writeHead(404); return response.end(JSON.stringify({ error: '录音文件不存在' })); }
    }
    try {
      let result;
      if (request.method === 'POST' && url.pathname === '/session') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body || '{}');
        sessionToken = typeof input.token === 'string' ? input.token.slice(0, 12000) : '';
        if (agent) agent.options.authToken = sessionToken;
        result = { authenticated: Boolean(sessionToken) };
      }
      else if (request.method === 'POST' && url.pathname === '/recording/start') result = await startRecorder();
      else if (request.method === 'POST' && url.pathname === '/recording/stop') result = await stopRecorder();
      else { response.writeHead(404); return response.end(JSON.stringify({ error: 'Not found' })); }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message || '本地助手操作失败' }));
    }
  });
  localServer.listen(LOCAL_PORT, '127.0.0.1');
}

app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--background'] });
  startLocalServer();
  if (!process.argv.includes('--background')) createWindow();
  await startAgent(path.join(os.homedir(), 'Downloads')).catch(error => console.error(`[AceCall] 后台监听启动失败：${error.message}`));
  ipcMain.handle('platform', () => platformPolicy());
  ipcMain.handle('choose-directory', async () => { const result = await dialog.showOpenDialog(window, { title: '选择要监听的文件夹', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? '' : result.filePaths[0]; });
  ipcMain.handle('start-sync', (_event, directory) => startAgent(directory));
  ipcMain.handle('stop-sync', () => stopAgent());
  ipcMain.handle('get-config', () => ({ apiBase: Boolean(process.env.ACECALL_API_BASE), authToken: Boolean(process.env.ACECALL_AUTH_TOKEN), directory: currentDirectory }));
});

ipcMain.on('recording-chunk', async (_event, chunk) => {
  if (recording.status !== 'recording') return;
  await fsp.appendFile(recording.filePath, Buffer.from(chunk));
  recording.bytes += chunk.byteLength;
});
app.on('before-quit', async () => { app.isQuitting = true; await stopRecorder().catch(() => {}); await stopAgent(); localServer?.close(); });
app.on('window-all-closed', event => event.preventDefault());

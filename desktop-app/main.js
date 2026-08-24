const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { SyncAgent, platformPolicy } = require('./local-sync-agent');

let window;
let tray;
let agent;
let currentDirectory = '';

function icon() {
  return nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
}

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

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'AceCall Sync', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }, { label: '操作', submenu: [{ label: '显示窗口', click: () => window.show() }, { label: '停止监听', click: () => stopAgent() }] }]));
  tray = new Tray(icon()); tray.setToolTip('AceCall Sync'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示 AceCall Sync', click: () => window.show() }, { label: '停止监听', click: () => stopAgent() }, { type: 'separator' }, { role: 'quit' }])); tray.on('double-click', () => window.show());
  createWindow();
  ipcMain.handle('platform', () => platformPolicy());
  ipcMain.handle('choose-directory', async () => { const result = await dialog.showOpenDialog(window, { title: '选择要监听的文件夹', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? '' : result.filePaths[0]; });
  ipcMain.handle('start-sync', (_event, directory) => startAgent(directory));
  ipcMain.handle('stop-sync', () => stopAgent());
  ipcMain.handle('get-config', () => ({ apiBase: Boolean(process.env.ACECALL_API_BASE), authToken: Boolean(process.env.ACECALL_AUTH_TOKEN), directory: currentDirectory }));
});

app.on('before-quit', async () => { app.isQuitting = true; await stopAgent(); });
app.on('window-all-closed', event => event.preventDefault());

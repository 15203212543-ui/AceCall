const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tcb = require('@cloudbase/node-sdk');
const { createProvider } = require('./providers');

const PORT = Number(process.env.PORT || 8080);
const INTERVAL_MS = Math.max(5_000, Number(process.env.WORKER_INTERVAL_MS || 15_000));
const COLLECTION = 'acecall_transcription_tasks';
const WORKER_ID = process.env.WORKER_ID || `worker-${crypto.randomUUID()}`;
let app;
let running = false;

function database() {
  if (!process.env.TCB_ENV || !process.env.CLOUDBASE_APIKEY) throw new Error('转写 worker 未配置 TCB_ENV 或 CLOUDBASE_APIKEY');
  app ||= tcb.init({ env: process.env.TCB_ENV, accessKey: process.env.CLOUDBASE_APIKEY });
  return app.database();
}

function storage() {
  if (!process.env.TCB_ENV || !process.env.CLOUDBASE_APIKEY) throw new Error('转写 worker 未配置 CloudBase 凭证');
  app ||= tcb.init({ env: process.env.TCB_ENV, accessKey: process.env.CLOUDBASE_APIKEY });
  return app;
}

async function tempFileUrl(fileID) {
  const result = await storage().getTempFileURL({ fileList: [{ fileID, maxAge: 3600 }] });
  const item = result.fileList?.[0];
  if (!item?.tempFileURL || item.code !== 'SUCCESS') throw new Error(`无法读取录音分片：${item?.code || 'unknown'}`);
  return item.tempFileURL;
}

async function downloadParts(parts, directory) {
  const buffers = [];
  for (const part of [...parts].sort((a, b) => a.index - b.index)) {
    const fileID = part.fileId || part.path;
    if (!fileID) throw new Error('录音任务存在空分片路径');
    const response = await fetch(await tempFileUrl(fileID));
    if (!response.ok) throw new Error(`录音分片下载失败（${response.status}）`);
    buffers.push(Buffer.from(await response.arrayBuffer()));
  }
  const inputPath = path.join(directory, 'source.audio');
  await fs.writeFile(inputPath, Buffer.concat(buffers));
  return inputPath;
}

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const process = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    process.stderr.on('data', chunk => { stderr += chunk.toString(); });
    process.once('error', reject);
    process.once('close', code => code === 0 ? resolve() : reject(new Error(`音频格式转换失败（${code}）：${stderr.slice(-500)}`)));
  });
}

async function normalizeAudio(inputPath, directory) {
  const outputPath = path.join(directory, 'normalized.wav');
  await runFfmpeg(inputPath, outputPath);
  return outputPath;
}

async function uploadNormalized(filePath, task) {
  const fileContent = await fs.readFile(filePath);
  const cloudPath = `${task.storagePrefix}/normalized.wav`;
  const uploaded = await storage().uploadFile({ cloudPath, fileContent });
  const fileID = uploaded.fileID || cloudPath;
  return { fileContent, fileID, url: await tempFileUrl(fileID) };
}

async function claimTask(task) {
  const now = new Date().toISOString();
  const updated = { ...task, status: 'transcribing', workerId: WORKER_ID, startedAt: now, updatedAt: now, error: '' };
  await database().collection(COLLECTION).doc(task.id).set(updated);
  return updated;
}

async function updateTask(task, patch) {
  await database().collection(COLLECTION).doc(task.id).set({ ...task, ...patch, updatedAt: new Date().toISOString() });
}

async function processTask(task) {
  const claimed = await claimTask(task);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acecall-transcription-'));
  try {
    const sourcePath = await downloadParts(claimed.parts || [], directory);
    await updateTask(claimed, { status: 'converting' });
    const normalizedPath = await normalizeAudio(sourcePath, directory);
    const normalized = await uploadNormalized(normalizedPath, claimed);
    await updateTask(claimed, { status: 'transcribing', normalizedPath: `${claimed.storagePrefix}/normalized.wav` });
    const provider = createProvider(claimed.engine === 'external-whisper' ? undefined : claimed.engine);
    const result = await provider.transcribe({ audioUrl: normalized.url, audioBuffer: normalized.fileContent, fileName: 'normalized.wav', mimeType: 'audio/wav', task: claimed });
    if (!result?.text?.trim()) throw new Error('转写引擎未返回有效文字');
    await updateTask(claimed, { status: 'completed', engine: result.provider, result: { ...result, characters: result.text.length, completedAt: new Date().toISOString(), format: 'text' }, error: '' });
  } catch (error) {
    await updateTask(claimed, { status: 'failed', error: error.message || '转写失败', failedAt: new Date().toISOString() });
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function poll() {
  if (running) return;
  running = true;
  try {
    const result = await database().collection(COLLECTION).where({ status: 'queued' }).limit(1).get();
    const task = result.data?.[0];
    if (task) await processTask(task);
  } catch (error) {
    console.error(`[AceCall transcription worker] ${error.message}`);
  } finally {
    running = false;
  }
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return response.end(JSON.stringify({ ok: true, service: 'acecall-transcription-worker' }));
  }
  response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[AceCall transcription worker] started on port ${PORT}; provider=${process.env.TRANSCRIPTION_PROVIDER || 'baidu'}`);
  poll();
  setInterval(poll, INTERVAL_MS);
});

module.exports = { normalizeAudio, createProvider, processTask };

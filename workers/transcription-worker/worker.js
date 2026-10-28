const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createProvider } = require('./providers');

const PORT = Number(process.env.PORT || 9000);
const INTERVAL_MS = Math.min(3_000, Math.max(1_000, Number(process.env.WORKER_INTERVAL_MS || 3_000)));
const COLLECTION = 'acecall_transcription_tasks';
const WORKER_ID = process.env.WORKER_ID || `worker-${crypto.randomUUID()}`;
const LEASE_MS = Math.max(60_000, Number(process.env.TRANSCRIPTION_LEASE_MS || 60 * 60 * 1000));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.TRANSCRIPTION_MAX_ATTEMPTS || 3));
const RETRY_DELAY_MS = Math.max(5_000, Number(process.env.TRANSCRIPTION_RETRY_DELAY_MS || 30_000));
// CloudBase's uploadFile only accepts a Buffer, so a single uploaded slice must
// stay well inside the worker's memory budget. 15 minutes of 16 kHz mono PCM is
// ~28 MB, which keeps a two-hour call to eight separate uploads.
// ~28 MB per slice, which keeps a two-hour call to eight separate uploads.
// Read at call time (not module load) so tests and one-off runs can override.
function autoSegmentSeconds() {
  return Math.max(60, Number(process.env.TRANSCRIPTION_AUTO_SEGMENT_SECONDS || 900));
}

// Fallback trigger when duration is unknown: 32 MB is roughly 16 minutes of
// 16 kHz mono PCM, comfortably inside a small instance's memory budget.
function autoSegmentBytes() {
  return Math.max(1024 * 1024, Number(process.env.TRANSCRIPTION_AUTO_SEGMENT_BYTES || 32 * 1024 * 1024));
}

const MAX_SOURCE_BYTES = Number(process.env.TRANSCRIPTION_MAX_SOURCE_BYTES || 1024 * 1024 * 1024);
let app;
let sdk;
let running = false;
// Test seam: tools/offline-e2e.js swaps these out to run the whole pipeline
// against local files instead of CloudBase. Unset in production.
let dependencies = null;

process.on('uncaughtException', error => console.error(`[AceCall transcription worker] uncaught exception: ${error.message}`));
process.on('unhandledRejection', error => console.error(`[AceCall transcription worker] unhandled rejection: ${error?.message || error}`));

// Loaded lazily so the module can be required by unit tests and tooling that do
// not have the CloudBase SDK installed.
function cloudbase() {
  if (!sdk) {
    try {
      sdk = require('@cloudbase/node-sdk');
    } catch {
      throw new Error('转写 worker 未安装 @cloudbase/node-sdk，请在该目录执行 npm install');
    }
  }
  return sdk;
}

function configureDependencies(next) {
  dependencies = next || null;
}

/**
 * 组装 CloudBase SDK 的凭证参数。
 *
 * 注意：node-sdk 的 ICloudBaseConfig **没有 accessKey 字段**（只有
 * secretId / secretKey / sessionToken），整个 dist 目录里也搜不到 accessKey。
 * 云函数里写 accessKey 之所以能用，是因为它跑在 CloudBase 环境内，SDK 会自动
 * 读取平台注入的临时凭证；而这个 worker 是外部进程，必须显式给密钥，
 * 否则数据库请求会抛「missing secretId or secretKey of tencent cloud」。
 *
 * 支持两种来源，优先级从高到低：
 *   1. CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY（推荐，写得明确）
 *   2. TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY（腾讯云官方环境变量名）
 */
function credentialConfig() {
  const config = { env: process.env.TCB_ENV };
  const secretId = process.env.CLOUDBASE_SECRET_ID || process.env.TENCENTCLOUD_SECRETID;
  const secretKey = process.env.CLOUDBASE_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY;
  const sessionToken = process.env.CLOUDBASE_SESSION_TOKEN || process.env.TENCENTCLOUD_SESSIONTOKEN;
  if (secretId && secretKey) {
    config.secretId = secretId;
    config.secretKey = secretKey;
    if (sessionToken) config.sessionToken = sessionToken;
  }
  return config;
}

function assertCloudbaseCredentials() {
  if (!process.env.TCB_ENV) throw new Error('转写 worker 未配置 TCB_ENV（CloudBase 环境 ID）');
  const { secretId, secretKey } = credentialConfig();
  if (!secretId || !secretKey) {
    throw new Error(
      '转写 worker 缺少 CloudBase 密钥：请设置 CLOUDBASE_SECRET_ID 与 CLOUDBASE_SECRET_KEY'
      + '（腾讯云 API 密钥，不是 CloudBase 的 API Key；CLOUDBASE_APIKEY 对 node-sdk 无效）'
    );
  }
}

function cloudbaseApp() {
  if (!app) {
    assertCloudbaseCredentials();
    app = cloudbase().init(credentialConfig());
  }
  return app;
}

function database() {
  if (dependencies?.database) return dependencies.database();
  return cloudbaseApp().database();
}

function storage() {
  if (dependencies?.storage) return dependencies.storage();
  return cloudbaseApp();
}

async function tempFileUrl(fileID) {
  const result = await storage().getTempFileURL({ fileList: [{ fileID, maxAge: 3600 }] });
  const item = result.fileList?.[0];
  if (!item?.tempFileURL || item.code !== 'SUCCESS') throw new Error(`无法读取录音分片：${item?.code || 'unknown'}`);
  return item.tempFileURL;
}

function audioExtension(value = '') {
  const extension = String(value).split('?')[0].split('.').pop()?.toLowerCase() || '';
  return /^[a-z0-9]{1,6}$/.test(extension) ? extension : 'audio';
}

/**
 * Stream every part straight to disk. The previous implementation buffered all
 * parts and called Buffer.concat, so a two-hour call held the entire recording
 * in memory twice (parts + merged copy) and OOMed on small instances.
 *
 * Chunks are written manually rather than with pipeline({ end: false }) because
 * pipeline attaches error/close/finish/end listeners per call, and recordings
 * routinely have more than ten parts.
 */
async function downloadParts(parts, directory) {
  const sorted = [...(parts || [])].sort((a, b) => a.index - b.index);
  if (!sorted.length) throw new Error('录音任务没有可下载的分片');
  const inputPath = path.join(directory, `source.${audioExtension(sorted[0].fileId || sorted[0].path)}`);
  const sink = createWriteStream(inputPath);
  let written = 0;
  try {
    for (const part of sorted) {
      const fileID = part.fileId || part.path;
      if (!fileID) throw new Error('录音任务存在空分片路径');
      const response = await fetch(await tempFileUrl(fileID));
      if (!response.ok) throw new Error(`录音分片下载失败（${response.status}）`);
      if (!response.body) throw new Error('录音分片响应为空');
      for await (const chunk of response.body) {
        written += chunk.length;
        if (written > MAX_SOURCE_BYTES) throw new Error('录音超过 TRANSCRIPTION_MAX_SOURCE_BYTES 限制');
        if (!sink.write(chunk)) await once(sink, 'drain');
      }
    }
  } catch (error) {
    sink.destroy();
    throw error;
  }
  await new Promise((resolve, reject) => sink.end(error => (error ? reject(error) : resolve())));
  const stat = await fs.stat(inputPath);
  if (!stat.size) throw new Error('合并后的录音为空');
  return inputPath;
}

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    child.once('error', error => reject(new Error(`${label}无法启动 ffmpeg：${error.message}`)));
    child.once('close', code => (code === 0 ? resolve() : reject(new Error(`${label}失败（${code}）：${stderr.slice(-500)}`))));
  });
}

function probeDuration(filePath) {
  return probeDurationWithFfprobe(filePath).then(seconds => (
    seconds > 0 ? seconds : probeDurationWithFfmpeg(filePath)
  ));
}

function probeDurationWithFfprobe(filePath) {
  return new Promise(resolve => {
    const child = spawn(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath
    ]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.once('error', () => resolve(0));
    child.once('close', () => {
      const seconds = Number(output.trim());
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    });
  });
}

/**
 * Fallback for images that ship ffmpeg without ffprobe (e.g. imageio-ffmpeg).
 * ffmpeg prints "Duration: 00:25:00.00" on stderr; parse that instead of
 * silently reporting 0, which would disable segmentation and let a 45 MB blob
 * through as a single upload.
 */
function probeDurationWithFfmpeg(filePath) {
  return new Promise(resolve => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-i', filePath]);
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 40000) stderr = stderr.slice(-20000);
    });
    child.once('error', () => resolve(0));
    child.once('close', () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
      if (!match) return resolve(0);
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    });
  });
}

async function normalizeAudio(inputPath, directory) {
  const outputPath = path.join(directory, 'normalized.wav');
  await runFfmpeg(['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath], '音频格式转换');
  return outputPath;
}

/**
 * Decide how the recording is handed to the provider.
 *
 * - Explicit TRANSCRIPTION_SEGMENT_SECONDS wins.
 * - Otherwise long audio is sliced automatically so no single upload Buffer
 *   approaches the worker's memory ceiling.
 * - Short audio is only transcoded when the provider demands 16 kHz mono WAV
 *   (Baidu); Whisper-compatible gateways decode the original container.
 *
 * Segmentation triggers on duration OR size: duration probing needs ffprobe,
 * which some ffmpeg distributions omit, and a probe failure must not silently
 * turn a two-hour recording into one 230 MB upload.
 */
async function prepareAudio(sourcePath, directory, { normalize, duration }) {
  const explicit = Number(process.env.TRANSCRIPTION_SEGMENT_SECONDS || 0);
  const threshold = autoSegmentSeconds();
  const { size } = await fs.stat(sourcePath);
  const tooLong = duration > threshold || (duration <= 0 && size > autoSegmentBytes());
  const segmentSeconds = explicit > 0
    ? explicit
    : (tooLong ? threshold : 0);

  if (segmentSeconds > 0) {
    const pattern = path.join(directory, 'slice-%05d.wav');
    await runFfmpeg([
      '-y', '-i', sourcePath,
      '-f', 'segment',
      '-segment_time', String(segmentSeconds),
      '-reset_timestamps', '1',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      pattern
    ], '音频分段');
    const names = (await fs.readdir(directory)).filter(name => /^slice-\d{5}\.wav$/.test(name)).sort();
    if (!names.length) throw new Error('音频分段后没有生成可转写的片段');
    return {
      sliced: true,
      segmentSeconds,
      slices: names.map((name, index) => ({
        path: path.join(directory, name),
        offsetSeconds: index * segmentSeconds
      }))
    };
  }

  if (normalize) {
    return {
      sliced: false,
      segmentSeconds: 0,
      slices: [{ path: await normalizeAudio(sourcePath, directory), offsetSeconds: 0 }]
    };
  }

  return { sliced: false, segmentSeconds: 0, slices: [{ path: sourcePath, offsetSeconds: 0 }] };
}

async function uploadSlice(filePath, task, index) {
  const fileContent = await fs.readFile(filePath);
  const extension = path.extname(filePath).slice(1).toLowerCase() || 'wav';
  const cloudPath = `${task.storagePrefix}/asr-${String(index).padStart(5, '0')}.${extension}`;
  const uploaded = await storage().uploadFile({ cloudPath, fileContent });
  const fileID = uploaded.fileID || cloudPath;
  return { fileID, cloudPath, url: await tempFileUrl(fileID), bytes: fileContent.length, audioBuffer: fileContent };
}

function mergeSliceResults(results) {
  const texts = [];
  const segments = [];
  let duration = 0;
  for (const entry of results) {
    const text = String(entry.result?.text || '').trim();
    if (text) texts.push(text);
    for (const segment of entry.result?.segments || []) {
      const text2 = String(segment.text || '').trim();
      if (!text2) continue;
      segments.push({
        start: Number((Number(segment.start || 0) + entry.offsetSeconds).toFixed(3)),
        end: Number((Number(segment.end || 0) + entry.offsetSeconds).toFixed(3)),
        text: text2,
        speaker: segment.speaker || ''
      });
    }
    duration += Number(entry.result?.duration || 0);
  }
  return { text: texts.join('\n').trim(), segments, duration: Number(duration.toFixed(3)) };
}

/**
 * CloudBase's document.set() rejects payloads containing `_id`
 * (INVALID_PARAM "不能更新_id的值"). Tasks arrive here straight from a query, so
 * every write-back must strip the server-managed fields — otherwise the update
 * throws and the task stays stuck in its previous status forever.
 */
function persistable(document) {
  const { _id, _openid, ...rest } = document || {};
  return rest;
}

/**
 * 领取任务。
 *
 * 用 doc(id).set() 是「无条件覆盖」：多个 worker 实例同时轮询时，会把同一条任务
 * 重复转写，既浪费算力又会互相覆盖结果。这里改成条件更新（CAS）：带上
 * status: 'queued' 作为条件，只有真正改到了记录才算领取成功。
 *
 * 用 where({ id }) 而不是 doc(id) 还有一个好处：云函数创建任务时用的是
 * doc(id).set()，_id 与业务 id 相同；但历史上若有用 add() 写入的记录，_id 是
 * 随机串，doc(id) 会找不到它、导致任务永远卡在 queued。按字段查询两种都能覆盖。
 */
async function claimTask(task) {
  const currentStatus = String(task.status || '');
  const leaseExpired = !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= Date.now();
  if (currentStatus !== 'queued' && !(['transcribing', 'converting', 'merging'].includes(currentStatus) && leaseExpired)) return null;
  const now = new Date().toISOString();
  const updated = {
    ...task,
    status: 'transcribing',
    workerId: WORKER_ID,
    startedAt: task.startedAt || now,
    updatedAt: now,
    lastHeartbeatAt: now,
    leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    attempts: Number(task.attempts || 0) + 1,
    nextRetryAt: '',
    error: ''
  };
  const collection = database().collection(COLLECTION);
  const query = { id: task.id, status: currentStatus };
  if (currentStatus !== 'queued' && task.leaseExpiresAt && database().command?.lte) {
    query.leaseExpiresAt = database().command.lte(now);
  }
  const claimed = await collection.where(query).update(persistable(updated));
  const changed = Number(claimed?.updated ?? claimed?.updatedCount ?? 0);
  if (!changed) return null;
  Object.assign(task, updated);
  return updated;
}

async function updateTask(task, patch) {
  const updated = { ...task, ...patch, updatedAt: new Date().toISOString() };
  Object.assign(task, updated);
  await database().collection(COLLECTION).doc(task.id).set(persistable(updated));
  return updated;
}

async function renewLease(task) {
  return updateTask(task, {
    leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    lastHeartbeatAt: new Date().toISOString()
  });
}

async function transcribeWithLease(provider, input, task) {
  const heartbeat = setInterval(() => {
    renewLease(task).catch(error => console.error(`[AceCall transcription worker] lease renewal failed: ${error.message}`));
  }, Math.max(30_000, Math.floor(LEASE_MS / 3)));
  heartbeat.unref?.();
  try {
    return await provider.transcribe(input);
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * 决定用哪个转写引擎。
 *
 * 任务记录里的 engine 是「创建任务时」云函数写进去的（默认 baidu），它描述的是
 * 当时的期望，不代表这台 worker 实际能提供什么。之前直接照搬 claimed.engine，
 * 结果任务一律被判给百度，没配 BAIDU_API_KEY 就必然失败 —— 即使本地 ASR 服务
 * 完全正常。所以这里以 worker 自身的配置为准：
 *
 *   - TRANSCRIPTION_PROVIDER 已设置  → 用它（worker 知道自己能干什么）
 *   - 未设置                        → 退回任务里的 engine，再没有就 baidu
 *
 * 例外：任务显式标记 external-whisper 时，说明它指向外部 Whisper 端点，
 * createProvider(undefined) 会读取同一组环境变量，语义一致，无需特判。
 */
function resolveEngine(taskEngine) {
  const configured = String(process.env.TRANSCRIPTION_PROVIDER || '').trim();
  if (configured) {
    if (configured !== String(taskEngine || '').trim()) {
      console.log(
        `[AceCall transcription worker] 任务 engines=${taskEngine || '(空)'}，`
        + `按本机配置改用 ${configured}`
      );
    }
    return configured;
  }
  return taskEngine || 'baidu';
}

async function processTask(task) {
  const claimed = await claimTask(task);
  if (!claimed) return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acecall-transcription-'));
  try {
    const provider = createProvider(resolveEngine(claimed.engine));
    const sourcePath = await downloadParts(claimed.parts || [], directory);
    const duration = await probeDuration(sourcePath);
    await updateTask(claimed, {
      status: 'converting',
      sourceBytes: (await fs.stat(sourcePath)).size,
      durationSeconds: duration
    });

    const prepared = await prepareAudio(sourcePath, directory, {
      normalize: provider.requiresNormalizedWav === true,
      duration
    });
    await updateTask(claimed, {
      status: 'transcribing',
      segmentSeconds: prepared.segmentSeconds,
      segmentCount: prepared.slices.length
    });

    const results = [];
    for (const [index, slice] of prepared.slices.entries()) {
      const uploaded = await uploadSlice(slice.path, claimed, index);
      const sliceDuration = prepared.sliced
        ? Math.min(prepared.segmentSeconds, Math.max(0, duration - slice.offsetSeconds))
        : duration;
      const shortAudioLimit = Math.max(1, Number(process.env.BAIDU_SHORT_AUDIO_MAX_SECONDS || 60));
      const result = await transcribeWithLease(provider, {
        audioUrl: uploaded.url,
        audioBuffer: provider.name === 'baidu' && sliceDuration > 0 && sliceDuration <= shortAudioLimit ? uploaded.audioBuffer : undefined,
        fileName: path.basename(slice.path),
        mimeType: path.extname(slice.path) === '.wav' ? 'audio/wav' : 'application/octet-stream',
        durationSeconds: sliceDuration,
        language: claimed.language || process.env.WHISPER_LANGUAGE || '',
        prompt: claimed.hotwords || process.env.ACECALL_ASR_HOTWORDS || '',
        task: claimed
      }, claimed);
      results.push({ offsetSeconds: slice.offsetSeconds, result });
    }

    const merged = mergeSliceResults(results);
    if (!merged.text) throw new Error('转写引擎未返回有效文字');
    const engine = results[0]?.result?.provider || provider.name;
    await updateTask(claimed, {
      status: 'completed',
      engine,
      leaseExpiresAt: '',
      lastHeartbeatAt: new Date().toISOString(),
      normalizedPath: prepared.sliced ? '' : `${claimed.storagePrefix}/asr-00000.${path.extname(prepared.slices[0].path).slice(1)}`,
      result: {
        ...(results[0]?.result || {}),
        text: merged.text,
        characters: merged.text.length,
        segments: merged.segments,
        segmentCount: results.length,
        duration: merged.duration || duration,
        completedAt: new Date().toISOString(),
        format: 'text'
      },
      error: ''
    });
  } catch (error) {
    const message = error.message || '转写失败';
    const attempts = Number(claimed.attempts || 1);
    if (attempts < MAX_ATTEMPTS) {
      await updateTask(claimed, {
        status: 'queued',
        error: message,
        nextRetryAt: new Date(Date.now() + RETRY_DELAY_MS * attempts).toISOString(),
        leaseExpiresAt: '',
        retryAt: new Date().toISOString()
      });
    } else {
      await updateTask(claimed, { status: 'failed', error: message, failedAt: new Date().toISOString(), leaseExpiresAt: '' });
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function poll() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const queued = await database().collection(COLLECTION).where({ status: 'queued' }).limit(20).get();
    let task = (queued.data || []).find(item => !item.nextRetryAt || Date.parse(item.nextRetryAt) <= now);
    if (!task) {
      for (const status of ['transcribing', 'converting', 'merging']) {
        const result = await database().collection(COLLECTION).where({ status }).limit(20).get();
        task = (result.data || []).find(item => !item.leaseExpiresAt || Date.parse(item.leaseExpiresAt) <= now);
        if (task) break;
      }
    }
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
    return response.end(JSON.stringify({
      ok: true,
      service: 'acecall-transcription-worker',
      provider: process.env.TRANSCRIPTION_PROVIDER || 'baidu',
      autoSegmentSeconds: autoSegmentSeconds(),
      busy: running
    }));
  }
  response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

server.on('error', error => { console.error(`[AceCall transcription worker] server error: ${error.message}`); process.exitCode = 1; });

// Only bind the port when executed directly so unit tests can require the
// module to exercise mergeSliceResults/processTask without stealing 9000.
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[AceCall transcription worker] started on port ${PORT}; provider=${process.env.TRANSCRIPTION_PROVIDER || 'baidu'}; autoSegment=${autoSegmentSeconds()}s`);
    poll();
    setInterval(poll, INTERVAL_MS);
  });
}

module.exports = {
  normalizeAudio,
  createProvider,
  processTask,
  downloadParts,
  prepareAudio,
  mergeSliceResults,
  probeDuration,
  persistable,
  claimTask,
  updateTask,
  configureDependencies
};

#!/usr/bin/env node

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { applyJobAssignment } = require('./job-assignment');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const STABLE_MS = 10 * 1000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 60 * 1024 * 1024;
const SUPPORTED = /\.(pdf|docx?|txt|md|rtf|vtt|srt|json|mp3|wav|pcm|amr|m4a|webm|ogg|mp4)$/i;
const AUDIO = /\.(mp3|wav|pcm|amr|m4a|webm|ogg|mp4)$/i;
const TEMPORARY = /\.(crdownload|part|tmp|download)$/i;
const signals = ['简历', '个人信息', '工作经历', '教育经历', '项目经历', '任职', '工作经验', '学历', '邮箱', '手机', '电话', 'resume', 'experience', 'education'];
const transcriptNameSignals = ['面试转写', '面试记录', '面试录音', 'transcript', 'transcription', 'subtitle', 'caption', 'webvtt'];
const transcriptBodySignals = ['面试转写', '面试录音', '发言人', 'webvtt', '会议已开启实时转写', '机器识别结果仅供参考'];
const TEXT_TRANSCRIPT = /\.(txt|md|vtt|srt|json)$/i;

function platformPolicy() {
  if (process.platform === 'darwin') return { platform: 'mac', label: 'Mac', defaultDirectory: path.join(os.homedir(), 'Downloads') };
  if (process.platform === 'win32') return { platform: 'windows', label: 'Windows', defaultDirectory: path.join(os.homedir(), 'Downloads') };
  return { platform: 'other', label: process.platform, defaultDirectory: path.join(os.homedir(), 'Downloads') };
}

function parseArgs(argv) {
  const options = { directory: process.env.ACECALL_WATCH_DIR || '', interval: Number(process.env.ACECALL_SCAN_INTERVAL_MS || DEFAULT_INTERVAL_MS), once: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dir') options.directory = argv[++index] || '';
    if (argv[index] === '--interval') options.interval = Math.max(30_000, Number(argv[++index]) || DEFAULT_INTERVAL_MS);
    if (argv[index] === '--once') options.once = true;
  }
  return options;
}

function fileKey(filePath, stat) { return `${filePath}:${stat.size}:${stat.mtimeMs}`; }
function isCandidateFile(filePath, stat) { return stat.isFile() && !TEMPORARY.test(filePath) && SUPPORTED.test(filePath) && stat.size > 1024 && stat.size <= (AUDIO.test(filePath) ? MAX_AUDIO_BYTES : MAX_FILE_BYTES); }

async function listFiles(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(directory, entry.name);
    try {
      const stat = await fsp.stat(fullPath);
      if (isCandidateFile(fullPath, stat)) files.push({ path: fullPath, stat });
    } catch (error) {
      if (!['ENOENT', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return files;
}

function looksLikeResume(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length >= 20 && signals.filter(signal => normalized.toLowerCase().includes(signal.toLowerCase())).length >= 2;
}
function isTranscriptFileName(filePath = '') {
  let base = path.basename(filePath).replace(/\.[^.]+$/, '').trim();
  let previous = '';
  while (base && base !== previous) {
    previous = base;
    base = base.replace(/\s*[（(]\d+[）)]\s*$/g, '').replace(/\s+\d{1,2}[.:]\d{2}[.:]\d{2}\s*$/g, '').trim();
  }
  return /安排[）)]\s*$/.test(base) && /^[^_（()]+_.+[（(].+安排[）)]\s*$/.test(base);
}
function looksLikeTranscript(filePath, text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length < 20) return false;
  if (/\.(vtt|srt)$/i.test(filePath)) return true;
  const name = path.basename(filePath).toLowerCase();
  const body = normalized.toLowerCase();
  if (transcriptNameSignals.some(signal => name.includes(signal.toLowerCase()))) return true;
  if (transcriptBodySignals.some(signal => body.includes(signal.toLowerCase()))) return true;
  return /面试官\s*[:：]/.test(normalized) || /发言人\s*[:：]/.test(normalized);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class SyncAgent {
  constructor(options) {
    this.options = options;
    this.policy = platformPolicy();
    this.directory = path.resolve(options.directory || this.policy.defaultDirectory);
    this.statePath = path.resolve(options.statePath || path.join(os.homedir(), '.acecall', 'sync-state.json'));
    this.legacyStatePath = path.join(this.directory, '.acecall-sync.json');
    this.state = { version: 1, startedAt: new Date().toISOString(), baseline: [], imported: {}, failures: {} };
    this.stability = new Map();
    this.watcher = null;
    this.scanTimer = null;
    this.scanInFlight = false;
    this.scanQueued = false;
  }

  async loadState() {
    try {
      this.state = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Migrate the old per-folder state file once, without deleting it.
    try {
      this.state = JSON.parse(await fsp.readFile(this.legacyStatePath, 'utf8'));
      await this.saveState();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async saveState() {
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fsp.rename(temporary, this.statePath);
  }

  async start() {
    await fsp.mkdir(this.directory, { recursive: true });
    await fsp.access(this.directory, fs.constants.R_OK);
    await this.loadState();
    const current = await listFiles(this.directory);
    this.state.baseline = current.map(item => fileKey(item.path, item.stat));
    this.state.watchedDirectory = this.directory;
    await this.saveState();
    console.log(`[AceCall] ${this.policy.label}监听已启动：${this.directory}`);
    console.log(`[AceCall] 仅处理启动后的新增文件，补偿扫描间隔 ${this.options.interval / 60000} 分钟`);
    try {
      this.watcher = fs.watch(this.directory, { persistent: true }, (_event, changedName) => {
        if (changedName && path.basename(String(changedName)) === path.basename(this.statePath)) return;
        this.requestScan();
      });
      this.watcher.on('error', error => {
        this.report(error);
        this.watcher?.close?.();
        this.watcher = null;
        console.error('[AceCall] 文件事件监听不可用，已降级为定时扫描');
      });
    } catch (error) {
      this.report(error);
      this.watcher = null;
      console.error('[AceCall] 文件事件监听启动失败，已降级为定时扫描');
    }
    this.scanTimer = setInterval(() => this.scan().catch(error => this.report(error)), this.options.interval);
    await this.scan();
    if (this.options.once) await this.stop();
  }

  async scan() {
    if (this.scanInFlight) { this.scanQueued = true; return; }
    this.scanInFlight = true;
    try {
    const files = await listFiles(this.directory);
    for (const item of files) {
      const key = fileKey(item.path, item.stat);
      if (this.state.baseline.includes(key) || this.state.imported[key]) continue;
      const previous = this.stability.get(key);
      if (!previous || previous.size !== item.stat.size) { this.stability.set(key, { size: item.stat.size, seenAt: Date.now() }); continue; }
      if (Date.now() - previous.seenAt < STABLE_MS) continue;
      await this.importFile(item.path, key);
    }
    await this.saveState();
    } finally {
      this.scanInFlight = false;
      if (this.scanQueued) { this.scanQueued = false; this.requestScan(); }
    }
  }

  requestScan() { this.scan().catch(error => this.report(error)); }

  async importFile(filePath, key) {
    try {
      console.log(`[AceCall] 处理：${path.basename(filePath)}`);
      if (AUDIO.test(filePath)) {
        if (!this.options.apiBase) throw new Error('录音文件需要连接 AceCall 云端服务');
        const task = await this.uploadRecording(filePath);
        this.state.imported[key] = { file: filePath, importedAt: new Date().toISOString(), type: 'recording', taskId: task.taskId };
        delete this.state.failures[key];
        console.log(`[AceCall] 已上传并转写本地录音：${path.basename(filePath)}`);
        return;
      }
      if (isTranscriptFileName(filePath)) {
        if (!this.options.apiBase) throw new Error('转写文件需要连接 AceCall 云端服务');
        const text = TEXT_TRANSCRIPT.test(filePath) ? await fsp.readFile(filePath, 'utf8') : (await this.requestFile(filePath)).text;
        if (!String(text || '').trim()) throw new Error('转写文件内容为空');
        await this.saveTranscript({ filePath, text, metadata: { fileName: path.basename(filePath) }, size: (await fsp.stat(filePath)).size });
        this.state.imported[key] = { file: filePath, importedAt: new Date().toISOString(), type: 'transcript' };
        delete this.state.failures[key];
        console.log(`[AceCall] 已导入面试转写：${path.basename(filePath)}`);
        return;
      }
      if (TEXT_TRANSCRIPT.test(filePath)) {
        const text = await fsp.readFile(filePath, 'utf8');
        if (looksLikeTranscript(filePath, text)) {
          if (!this.options.apiBase) throw new Error('转写文件需要连接 AceCall 云端服务');
          await this.saveTranscript({ filePath, text, metadata: { fileName: path.basename(filePath) }, size: (await fsp.stat(filePath)).size });
          this.state.imported[key] = { file: filePath, importedAt: new Date().toISOString(), type: 'transcript' };
          delete this.state.failures[key];
          console.log(`[AceCall] 已导入面试转写：${path.basename(filePath)}`);
          return;
        }
      }
      const result = await this.requestFile(filePath);
      if (looksLikeTranscript(filePath, result.text)) {
        if (!this.options.apiBase) throw new Error('转写文件需要连接 AceCall 云端服务');
        await this.saveTranscript({ filePath, text: result.text, metadata: result.metadata || {}, size: (await fsp.stat(filePath)).size });
        this.state.imported[key] = { file: filePath, importedAt: new Date().toISOString(), type: 'transcript' };
        delete this.state.failures[key];
        console.log(`[AceCall] 已导入面试转写：${path.basename(filePath)}`);
        return;
      }
      if (!looksLikeResume(result.text)) throw new Error('内容未识别为简历或面试转写');
      const candidate = { id: crypto.randomUUID(), candidateName: result.metadata?.candidateName || path.basename(filePath, path.extname(filePath)), resume: result.text, resumeMeta: { ...result.metadata, fileName: path.basename(filePath), source: 'local-sync-agent' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ingestStatus: '已解析待分配' };
      await this.assignJob(candidate);
      if (this.options.apiBase) await this.saveCandidate(candidate);
      this.state.imported[key] = { file: filePath, importedAt: new Date().toISOString(), candidateId: candidate.id };
      delete this.state.failures[key];
      console.log(`[AceCall] 已完成：${path.basename(filePath)}${this.options.apiBase ? '，已同步后端' : '，仅本地解析'}`);
    } catch (error) {
      const previous = this.state.failures[key] || { attempts: 0 };
      previous.attempts += 1; previous.lastError = error.message; previous.lastAttemptAt = new Date().toISOString();
      this.state.failures[key] = previous;
      console.error(`[AceCall] 失败（第 ${previous.attempts} 次）：${path.basename(filePath)} - ${error.message}`);
    }
  }

  async requestFile(filePath) {
    if (!this.options.apiBase) return { text: await fsp.readFile(filePath, 'utf8'), metadata: {} };
    const body = await fsp.readFile(filePath);
    return this.request(`/api/parse-resume?name=${encodeURIComponent(path.basename(filePath))}`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
  }

  async uploadRecording(filePath) {
    const stat = await fsp.stat(filePath);
    const init = await this.request('/api/recordings/init', { method: 'POST', body: JSON.stringify({ fileName: path.basename(filePath), mimeType: 'audio/' + path.extname(filePath).slice(1).toLowerCase(), size: stat.size }), headers: { 'Content-Type': 'application/json' } });
    const chunkSize = Number(init.chunkSize || 8 * 1024 * 1024);
    for (let offset = 0, index = 0; offset < stat.size; offset += chunkSize, index += 1) {
      const handle = await fsp.open(filePath, 'r');
      try {
        const length = Math.min(chunkSize, stat.size - offset); const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        await this.request(`/api/recordings/${encodeURIComponent(init.recordingId || init.taskId)}/parts/upload?index=${index}&final=${offset + length >= stat.size ? '1' : '0'}`, { method: 'POST', body: buffer, headers: { 'Content-Type': 'application/octet-stream' } });
      } finally { await handle.close(); }
    }
    return this.request('/api/transcription-tasks', { method: 'POST', body: JSON.stringify({ recordingId: init.recordingId || init.taskId, taskId: init.taskId || init.recordingId }), headers: { 'Content-Type': 'application/json' } });
  }

  async saveCandidate(candidate) {
    return this.request(`/api/candidates/${candidate.id}`, { method: 'PUT', body: JSON.stringify(candidate), headers: { 'Content-Type': 'application/json' } });
  }
  async saveTranscript(input) {
    return this.request('/api/transcript-imports', { method: 'POST', body: JSON.stringify({ fileName: path.basename(input.filePath), mimeType: path.extname(input.filePath).toLowerCase(), size: input.size, text: input.text, metadata: { ...input.metadata, source: 'local-sync-agent', fileName: path.basename(input.filePath) } }), headers: { 'Content-Type': 'application/json' } });
  }

  async assignJob(candidate) {
    if (!this.options.apiBase) return;
    const state = await this.request('/api/state');
    const jobs = (state.jobs || []).filter(job => job.status !== 'archived' && job.status !== 'closed' && job.matchingEligible !== false);
    if (!jobs.length) return;
    const match = await this.request('/api/generate', { method: 'POST', body: JSON.stringify({ action: 'match', candidateName: candidate.candidateName, fileName: candidate.resumeMeta?.fileName || '', resume: candidate.resume, jobs: jobs.map(job => ({ id: job.id, name: job.name, industry: job.industry, location: job.location, jd: job.jd, keywords: job.keywords, rules: job.rules })) }), headers: { 'Content-Type': 'application/json' } });
    applyJobAssignment(candidate, jobs, match);
  }
  async request(endpoint, options = {}) {
    const response = await fetch(`${this.options.apiBase.replace(/\/$/, '')}${endpoint}`, { ...options, headers: { ...(options.headers || {}), ...(this.options.authToken ? { Authorization: `Bearer ${this.options.authToken}` } : {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `接口请求失败（${response.status}）`);
    return data;
  }

  report(error) { console.error(`[AceCall] 扫描失败：${error.message}`); }

  async stop() { if (this.watcher) this.watcher.close(); if (this.scanTimer) clearInterval(this.scanTimer); await this.saveState(); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.apiBase = process.env.ACECALL_API_BASE || '';
  options.authToken = process.env.ACECALL_AUTH_TOKEN || '';
  const agent = new SyncAgent(options);
  process.on('SIGINT', () => agent.stop().finally(() => process.exit(0)));
  process.on('SIGTERM', () => agent.stop().finally(() => process.exit(0)));
  await agent.start();
}

if (require.main === module) main().catch(error => { console.error(`[AceCall] 启动失败：${error.message}`); process.exitCode = 1; });
module.exports = { SyncAgent, platformPolicy, isCandidateFile, isTranscriptFileName, looksLikeResume, looksLikeTranscript, fileKey, AUDIO };

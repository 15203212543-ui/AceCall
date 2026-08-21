#!/usr/bin/env node

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const STABLE_MS = 10 * 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SUPPORTED = /\.(pdf|docx?|txt|md|rtf)$/i;
const TEMPORARY = /\.(crdownload|part|tmp|download)$/i;
const signals = ['简历', '个人信息', '工作经历', '教育经历', '项目经历', '任职', '工作经验', '学历', '邮箱', '手机', '电话', 'resume', 'experience', 'education'];

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
function isCandidateFile(filePath, stat) { return stat.isFile() && !TEMPORARY.test(filePath) && SUPPORTED.test(filePath) && stat.size > 1024 && stat.size <= MAX_FILE_BYTES; }

async function listFiles(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(directory, entry.name);
    const stat = await fsp.stat(fullPath);
    if (isCandidateFile(fullPath, stat)) files.push({ path: fullPath, stat });
  }
  return files;
}

function looksLikeResume(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length >= 20 && signals.filter(signal => normalized.toLowerCase().includes(signal.toLowerCase())).length >= 2;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class SyncAgent {
  constructor(options) {
    this.options = options;
    this.policy = platformPolicy();
    this.directory = path.resolve(options.directory || this.policy.defaultDirectory);
    this.statePath = path.join(this.directory, '.acecall-sync.json');
    this.state = { version: 1, startedAt: new Date().toISOString(), baseline: [], imported: {}, failures: {} };
    this.stability = new Map();
    this.watcher = null;
    this.scanTimer = null;
  }

  async loadState() {
    try { this.state = JSON.parse(await fsp.readFile(this.statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async saveState() {
    const temporary = `${this.statePath}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fsp.rename(temporary, this.statePath);
  }

  async start() {
    await fsp.mkdir(this.directory, { recursive: true });
    await this.loadState();
    const current = await listFiles(this.directory);
    if (!this.state.baseline.length) this.state.baseline = current.map(item => fileKey(item.path, item.stat));
    await this.saveState();
    console.log(`[AceCall] ${this.policy.label}监听已启动：${this.directory}`);
    console.log(`[AceCall] 仅处理启动后的新增文件，补偿扫描间隔 ${this.options.interval / 60000} 分钟`);
    this.watcher = fs.watch(this.directory, { persistent: true }, () => this.scan().catch(error => this.report(error)));
    this.scanTimer = setInterval(() => this.scan().catch(error => this.report(error)), this.options.interval);
    await this.scan();
    if (this.options.once) await this.stop();
  }

  async scan() {
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
  }

  async importFile(filePath, key) {
    try {
      console.log(`[AceCall] 处理：${path.basename(filePath)}`);
      const result = await this.requestFile(filePath);
      if (!looksLikeResume(result.text)) throw new Error('内容未识别为简历');
      const candidate = { id: crypto.randomUUID(), candidateName: result.metadata?.candidateName || path.basename(filePath, path.extname(filePath)), resume: result.text, resumeMeta: { ...result.metadata, fileName: path.basename(filePath), source: 'local-sync-agent' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ingestStatus: '已解析待分配' };
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

  async saveCandidate(candidate) {
    return this.request(`/api/candidates/${candidate.id}`, { method: 'PUT', body: JSON.stringify(candidate), headers: { 'Content-Type': 'application/json' } });
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
module.exports = { SyncAgent, platformPolicy, isCandidateFile, looksLikeResume, fileKey };

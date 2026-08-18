const http = require('node:http');
const path = require('node:path');
const tcb = require('@cloudbase/node-sdk');

const PORT = 9000;
const COLLECTIONS = {
  jobs: 'acecall_jobs',
  candidates: 'acecall_candidates',
  screenings: 'acecall_screenings',
  audit: 'acecall_audit_logs'
};
const allowedOrigins = new Set((process.env.ACECALL_ALLOWED_ORIGINS || 'http://127.0.0.1:4173,http://localhost:4173,https://15203212543-ui.github.io').split(',').map(value => value.trim()).filter(Boolean));
let cloudbaseApp;

function getDatabase() {
  if (!process.env.TCB_ENV) throw serviceError('CloudBase environment is not configured', 503);
  if (!cloudbaseApp) {
    cloudbaseApp = tcb.init({
      env: process.env.TCB_ENV,
      accessKey: process.env.CLOUDBASE_APIKEY || undefined
    });
  }
  return cloudbaseApp.database();
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || '';
  setCors(response, origin);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        ok: true,
        service: 'acecall-api',
        storage: process.env.TCB_ENV ? 'cloudbase' : 'unconfigured',
        mode: process.env.DEEPSEEK_API_KEY ? 'ai' : 'demo',
        provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'demo',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, await loadState());
    if (request.method === 'PUT' && url.pathname.startsWith('/api/jobs/')) {
      const id = validateId(url.pathname.slice('/api/jobs/'.length));
      const job = await readJson(request);
      await saveJob(id, job);
      return sendJson(response, 200, { ok: true, id });
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/api/candidates/')) {
      const id = validateId(url.pathname.slice('/api/candidates/'.length));
      const candidate = await readJson(request);
      await saveCandidate(id, candidate);
      return sendJson(response, 200, { ok: true, id });
    }
    if (request.method === 'POST' && url.pathname === '/api/generate') {
      const payload = await readJson(request);
      validatePayload(payload);
      const result = process.env.DEEPSEEK_API_KEY ? await generateWithDeepSeek(payload) : generateDemo(payload);
      return sendJson(response, 200, { result, mode: process.env.DEEPSEEK_API_KEY ? 'ai' : 'demo', provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'demo' });
    }
    if (request.method === 'POST' && url.pathname === '/api/parse-resume') {
      const fileName = url.searchParams.get('name') || 'resume';
      const buffer = await readBuffer(request, 10_000_000);
      return sendJson(response, 200, await parseResumeFile(fileName, buffer));
    }
    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: error.message, statusCode: error.statusCode || 500 }));
    return sendJson(response, error.statusCode || 500, { error: error.statusCode && error.statusCode < 500 ? error.message : '服务暂时不可用，请稍后重试。' });
  }
});

function setCors(response, origin) {
  if (origin && allowedOrigins.has(origin)) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function loadState() {
  const db = getDatabase();
  const [jobsResult, candidatesResult, screeningsResult] = await Promise.all([
    db.collection(COLLECTIONS.jobs).orderBy('updatedAt', 'desc').limit(100).get(),
    db.collection(COLLECTIONS.candidates).orderBy('updatedAt', 'desc').limit(500).get(),
    db.collection(COLLECTIONS.screenings).orderBy('updatedAt', 'desc').limit(500).get()
  ]);
  const screenings = new Map();
  for (const item of screeningsResult.data || []) if (!screenings.has(item.candidateId)) screenings.set(item.candidateId, item);
  const cases = (candidatesResult.data || []).map(candidate => {
    const screening = screenings.get(candidate.id || candidate._id) || {};
    return cleanDocument({ ...candidate, ...pick(screening, ['preparation', 'transcript', 'consentConfirmed', 'communicationSummary', 'report']) });
  });
  return { jobs: (jobsResult.data || []).map(cleanDocument), cases };
}

async function saveJob(id, input) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const job = pick(input, ['industry', 'name', 'jd', 'keywords', 'rules', 'status', 'createdAt', 'updatedAt']);
  job.id = id;
  job.updatedAt = now;
  job.createdAt = job.createdAt || now;
  job.status = job.status || 'active';
  await db.collection(COLLECTIONS.jobs).doc(id).set(job);
  await audit('job.upsert', id, { name: job.name });
}

async function saveCandidate(id, input) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const candidate = pick(input, ['jobId', 'candidateName', 'roleName', 'jd', 'rules', 'keywords', 'resume', 'resumeMeta', 'status', 'createdAt', 'updatedAt']);
  candidate.id = id;
  candidate.updatedAt = now;
  candidate.createdAt = candidate.createdAt || now;
  candidate.status = deriveStatus(input);
  const screening = pick(input, ['preparation', 'transcript', 'consentConfirmed', 'communicationSummary', 'report']);
  screening.id = id;
  screening.candidateId = id;
  screening.jobId = input.jobId || '';
  screening.updatedAt = now;
  screening.createdAt = input.createdAt || now;
  await Promise.all([
    db.collection(COLLECTIONS.candidates).doc(id).set(candidate),
    db.collection(COLLECTIONS.screenings).doc(id).set(screening)
  ]);
  await audit('candidate.upsert', id, { jobId: candidate.jobId, status: candidate.status });
}

async function audit(action, entityId, detail) {
  const db = getDatabase();
  await db.collection(COLLECTIONS.audit).add({ action, entityId, detail, actor: 'acecall-api', createdAt: new Date().toISOString() });
}

function deriveStatus(item) {
  if (item.report?.reviewConfirmed) return 'completed';
  if (item.report || item.communicationSummary) return 'pending_review';
  if (item.preparation) return 'pending_call';
  return 'pending_analysis';
}

function cleanDocument(document) {
  const result = { ...document };
  result.id = result.id || result._id;
  delete result._id;
  return result;
}

function pick(source = {}, keys) {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, sanitizeJson(source[key])]));
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!value || typeof value !== 'object') return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || key.startsWith('$') || key.includes('.')) continue;
    safe[key] = sanitizeJson(child);
  }
  return safe;
}

function validateId(value) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw serviceError('Invalid resource id', 400);
  return value;
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) throw serviceError('输入内容过大', 413);
  }
  try { return JSON.parse(body || '{}'); } catch { throw serviceError('请求格式无效', 400); }
}

async function readBuffer(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw serviceError('简历文件不能超过 10MB', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseResumeFile(fileName, buffer) {
  const extension = path.extname(fileName).toLowerCase();
  let text = '';
  if (['.txt', '.md'].includes(extension)) text = buffer.toString('utf8');
  else if (extension === '.docx') text = (await require('mammoth').extractRawText({ buffer })).value;
  else if (extension === '.pdf') text = (await require('pdf-parse')(buffer)).text;
  else throw serviceError('仅支持 PDF、DOCX、TXT 和 MD 文件', 415);
  text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 20) throw serviceError('未提取到足够文字；如果是扫描版 PDF，请先进行 OCR', 422);
  const phone = text.match(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/)?.[0] || '';
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const experienceYears = text.match(/(\d{1,2})\s*年[^。\n]{0,12}经验/)?.[1] || '';
  const education = ['博士', '硕士', '本科', '大专'].find(level => text.includes(level)) || '';
  const candidateName = text.split('\n').map(line => line.trim()).find(line => line.length >= 2 && line.length <= 20 && !/简历|求职|电话|邮箱|手机/.test(line)) || '';
  return { text, metadata: { fileName, extension: extension.slice(1).toUpperCase(), characters: text.length, candidateName, phone, email, experienceYears, education } };
}

function validatePayload(payload) {
  if (!['prepare', 'summarize', 'synthesize'].includes(payload.action)) throw serviceError('未知工作流步骤', 400);
  if (payload.action === 'prepare' && (!payload.jd?.trim() || !payload.resume?.trim())) throw serviceError('请填写 JD 和候选人简历', 400);
  if (payload.action === 'summarize' && !payload.transcript?.trim()) throw serviceError('请填写电话转写内容', 400);
  if (payload.action === 'synthesize' && (!payload.preparation || !payload.communicationSummary)) throw serviceError('请先生成初筛方案和沟通总结', 400);
}

function buildModelPrompt(payload) {
  const schema = payload.action === 'prepare' ? prepareSchema() : payload.action === 'summarize' ? summarySchema() : synthesisSchema();
  return {
    instructions: `你是金融与互联网行业的专业招聘电话初筛助手。只依据输入事实工作，不得推断性别、年龄、婚育、籍贯等非岗位因素。区分“材料陈述”“电话确认”“仍待核验”，未知信息写“待确认”。输出严格 JSON，不含 Markdown。每项判断必须附事实依据，不得自动淘汰，最终决策由招聘人员完成。${schema}`,
    input: JSON.stringify(payload)
  };
}

async function generateWithDeepSeek(payload) {
  const { instructions, input } = buildModelPrompt(payload);
  const apiResponse = await fetch(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], response_format: { type: 'json_object' }, temperature: 0.2, stream: false })
  });
  if (!apiResponse.ok) throw new Error(`DeepSeek API error: ${apiResponse.status}`);
  const data = await apiResponse.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 未返回有效内容');
  return JSON.parse(content);
}

function prepareSchema() {
  return '初筛方案字段：summary 对象，含 headline、experience、relevantBackground、openFacts；matches 数组，每项含 requirement、evidence、confidence（高/中/低）；risks 数组，每项含 risk、evidence、impact；verification 数组，每项含 item、reason、priority（高/中/低）；questions 数组，每项含 category、question、reason、source（匹配点/风险点/重点核验/通用）。生成12-18个问题，并覆盖所有高优先级核验项。';
}
function summarySchema() {
  return '沟通总结字段：overview 字符串；confirmed、contradicted、missing 数组，每项含 item、evidence；questionCoverage 对象含 covered、total、unanswered 数组；keyFacts 对象含 currentCompanyRole、location、currentSalary、expectedSalary、availability、motivation、nonCompete；candidateSignals 字符串数组；followUps 字符串数组。只总结电话内容，不给推荐结论。';
}
function synthesisSchema() {
  return '综合审核字段：basicInfo 对象；capabilities 数组，每项含 item、evidence、assessment（匹配/部分匹配/信息不足/不匹配）；evidence 字符串数组；conflicts 数组，每项含 topic、resumeClaim、callEvidence；risks 字符串数组；conclusion（明确匹配/部分匹配/信息不足/明确不匹配）；conclusionReason 字符串；nextStep（推荐业务面试/补充电话沟通/转入其他岗位/暂不推进/纳入人才库长期维护）；followUps 字符串数组。';
}

function generateDemo(payload) {
  if (payload.action === 'prepare') return { summary: { headline: `${payload.candidateName || '候选人'}正在评估${payload.roleName || '目标岗位'}`, experience: '演示模式不进行事实推断', relevantBackground: '请配置DeepSeek密钥启用语义分析', openFacts: '职责、项目结果和基本条件待确认' }, matches: [], risks: [{ risk: '当前为演示模式', evidence: '未配置DeepSeek密钥', impact: '结果不能用于招聘判断' }], verification: [], questions: defaultQuestions() };
  if (payload.action === 'summarize') return { overview: '演示模式仅保存电话文本。', confirmed: [], contradicted: [], missing: [], questionCoverage: { covered: 0, total: payload.preparation?.questions?.length || 0, unanswered: [] }, keyFacts: {}, candidateSignals: [], followUps: [] };
  return { basicInfo: {}, capabilities: [], evidence: [], conflicts: [], risks: ['当前为演示模式'], conclusion: '信息不足', conclusionReason: '未启用AI服务。', nextStep: '补充电话沟通', followUps: [] };
}

function defaultQuestions() {
  return ['请介绍最相关的项目背景、个人职责和最终结果。', '哪些决策由你直接负责？', '项目是否上线，有哪些可量化结果？', '为什么现在考虑新的机会？', '请确认地点、薪资、到岗时间和竞业限制。'].map(question => ({ category: '重点核验', question, reason: '核实岗位相关事实', source: '通用' }));
}

function serviceError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`AceCall API listening on ${PORT}`));

module.exports = { server, validatePayload, deriveStatus, cleanDocument, sanitizeJson };

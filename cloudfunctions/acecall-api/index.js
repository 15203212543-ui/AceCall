const http = require('node:http');
const path = require('node:path');
const tcb = require('@cloudbase/node-sdk');

const PORT = 9000;
const COLLECTIONS = {
  tenants: 'acecall_tenants',
  members: 'acecall_members',
  jobs: 'acecall_jobs',
  candidates: 'acecall_candidates',
  screenings: 'acecall_screenings',
  audit: 'acecall_audit_logs',
  rules: 'acecall_team_rules'
};
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

function getCloudbaseApp() {
  getDatabase();
  return cloudbaseApp;
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
    if (request.method === 'POST' && url.pathname === '/api/workspace/bootstrap') return sendJson(response, 200, await bootstrapWorkspace(await readJson(request), request));
    if (request.method === 'GET' && url.pathname === '/api/workspace') return sendJson(response, 200, await workspaceSummary(await getRequestContext(request)));
    if (request.method === 'GET' && url.pathname === '/api/members') return sendJson(response, 200, await listMembers(await getRequestContext(request)));
    if (request.method === 'POST' && url.pathname === '/api/members/invite') return sendJson(response, 200, await inviteMember(await getRequestContext(request), await readJson(request)));
    if (request.method === 'PUT' && url.pathname.startsWith('/api/members/')) {
      const id = validateId(url.pathname.slice('/api/members/'.length));
      return sendJson(response, 200, await updateMember(await getRequestContext(request), id, await readJson(request)));
    }
    if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, await loadState(await getRequestContext(request)));
    if (request.method === 'PUT' && url.pathname.startsWith('/api/jobs/')) {
      const id = validateId(url.pathname.slice('/api/jobs/'.length));
      const job = await readJson(request);
      await saveJob(await getRequestContext(request), id, job);
      return sendJson(response, 200, { ok: true, id });
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/api/candidates/')) {
      const id = validateId(url.pathname.slice('/api/candidates/'.length));
      const candidate = await readJson(request);
      await saveCandidate(await getRequestContext(request), id, candidate);
      return sendJson(response, 200, { ok: true, id });
    }
    if (request.method === 'POST' && url.pathname === '/api/migrate-resumes') {
      return sendJson(response, 200, await migrateStoredResumes(await getRequestContext(request)));
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/api/rules/')) {
      const context = await getRequestContext(request);
      const id = validateId(url.pathname.slice('/api/rules/'.length)); const rule = await readJson(request); const now = new Date().toISOString();
      await assertWritableRecord(COLLECTIONS.rules, id, context.tenantId);
      await getDatabase().collection(COLLECTIONS.rules).doc(id).set({ id, tenantId: context.tenantId, createdBy: context.uid, updatedBy: context.uid, content: String(rule.content || '').slice(0, 1000), version: Number(rule.version || 1), status: 'active', updatedAt: now, createdAt: rule.createdAt || now });
      await audit(context, 'rule.upsert', id, { contentLength: String(rule.content || '').length });
      return sendJson(response, 200, { ok: true, id });
    }
    if (request.method === 'POST' && url.pathname === '/api/generate') {
      await getRequestContext(request);
      const payload = await readJson(request);
      validatePayload(payload);
      const result = process.env.DEEPSEEK_API_KEY ? await generateWithDeepSeek(payload) : generateDemo(payload);
      return sendJson(response, 200, { result, mode: process.env.DEEPSEEK_API_KEY ? 'ai' : 'demo', provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'demo' });
    }
    if (request.method === 'POST' && url.pathname === '/api/parse-resume') {
      await getRequestContext(request);
      const fileName = url.searchParams.get('name') || 'resume';
      const buffer = await readBuffer(request, 10_000_000);
      return sendJson(response, 200, await parseResumeFile(fileName, buffer));
    }
    if (request.method === 'POST' && url.pathname === '/api/transcribe') {
      const fileName = url.searchParams.get('name') || 'recording.m4a';
      const buffer = await readBuffer(request, 60_000_000);
      return sendJson(response, 200, await transcribeWithBaidu(fileName, buffer));
    }
    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: error.message, statusCode: error.statusCode || 500 }));
    const statusCode = error.statusCode || 500;
    // Service errors are deliberately phrased without credentials; returning them
    // lets the client distinguish Baidu auth/format failures from CloudBase faults.
    const expose = Boolean(error.statusCode && error.message);
    return sendJson(response, statusCode, { error: expose ? error.message : '服务暂时不可用，请稍后重试。' });
  }
});

function setCors(response, origin) {
  // The CloudBase HTTP gateway owns the origin response header. Setting it
  // here as well makes successful responses contain duplicate origins, which
  // browsers reject as an invalid CORS response.
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function normalizeResumeText(text = '') {
  const lines = String(text)
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  const counts = new Map();
  lines.forEach(line => counts.set(line, (counts.get(line) || 0) + 1));
  return lines.filter(line => {
    if ((counts.get(line) || 0) >= 3 && line.length < 80) return false;
    const visible = line.replace(/[\u4e00-\u9fffA-Za-z0-9@.+#:/()（）\u3001，。；：\-]/g, '');
    return visible.length / Math.max(line.length, 1) < 0.45;
  }).join('\n').replace(/([A-Za-z])\-\n([A-Za-z])/g, '$1$2').replace(/\n{3,}/g, '\n\n').trim();
}

function parseResumeBasics(text = '') {
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  const phone = (text.match(/(?<!\d)(?:\+?86[ -]?)?1[3-9](?:[ -]?\d){9}(?!\d)/)?.[0] || '').replace(/[ -]/g, '');
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '').replace(/[，。；;）)]+$/, '');
  const experienceYears = text.match(/(\d{1,2})\s*年[^。\n]{0,16}(?:工作|从业|经验|经历)/)?.[1] || '';
  const age = text.match(/(?:年龄|Age)\s*[:：]?\s*(\d{2})(?:岁)?/i)?.[1] || text.match(/(?<!\d)(2[0-9]|3[0-9]|4[0-9])\s*岁/)?.[1] || '';
  const education = ['博士', '硕士', '本科', '大专'].find(level => text.includes(level)) || '';
  return { candidateName: extractCandidateName(lines), phone, email, age, experienceYears, education };
}

async function getRequestContext(request) {
  const user = getCloudbaseApp().auth().getUserInfo() || {};
  const gatewayUser = readGatewayUser(request);
  const uid = gatewayUser.uid || user.uid || user.customUserId;
  if (!uid || user.isAnonymous) throw serviceError('请先登录后使用业务功能', 401);
  const result = await getDatabase().collection(COLLECTIONS.members).where({ uid, status: 'active' }).limit(1).get();
  const member = result.data?.[0];
  if (!member?.tenantId) throw serviceError('当前账号尚未加入公司工作区，请联系管理员邀请', 403);
  return { uid, tenantId: member.tenantId, role: member.role || 'recruiter', member };
}

function readGatewayUser(request) {
  const raw = request?.headers?.['x-cloudbase-context'] || request?.headers?.['x-cloudbase-userinfo'];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    const info = parsed.userInfo || parsed.user || parsed;
    return { uid: info.uid || info.customUserId || info.openId || '' };
  } catch {
    try { const parsed = JSON.parse(String(raw)); const info = parsed.userInfo || parsed.user || parsed; return { uid: info.uid || info.customUserId || info.openId || '' }; } catch { return {}; }
  }
}

async function bootstrapWorkspace(input = {}, request) {
  const user = getCloudbaseApp().auth().getUserInfo() || {};
  const gatewayUser = readGatewayUser(request);
  const uid = gatewayUser.uid || user.uid || user.customUserId;
  if (!uid || user.isAnonymous) throw serviceError('请先登录后初始化工作区', 401);
  const db = getDatabase();
  const existing = await db.collection(COLLECTIONS.members).where({ uid }).limit(5).get();
  const existingMember = existing.data?.[0];
  if (existingMember?.tenantId) {
    if (existingMember.status === 'disabled') throw serviceError('当前账号已被禁用', 403);
    const member = existingMember.status === 'invited' ? { ...existingMember, status: 'active', updatedAt: new Date().toISOString() } : existingMember;
    if (member.status !== existingMember.status) await db.collection(COLLECTIONS.members).doc(existingMember._id || existingMember.id).set(member);
    return workspaceSummary({ uid, tenantId: member.tenantId, role: member.role || 'recruiter', member });
  }
  const tenantId = `tenant_${uid}`.slice(0, 80);
  const now = new Date().toISOString();
  const tenantName = String(input.companyName || '').trim().slice(0, 120) || '我的公司工作区';
  await db.collection(COLLECTIONS.tenants).doc(tenantId).set({ id: tenantId, name: tenantName, status: 'active', createdBy: uid, createdAt: now, updatedAt: now });
  await db.collection(COLLECTIONS.members).doc(`${tenantId}_${uid}`.slice(0, 80)).set({ id: `${tenantId}_${uid}`.slice(0, 80), tenantId, uid, username: String(input.username || '').slice(0, 120), displayName: String(input.displayName || input.username || '').slice(0, 80), role: 'owner', status: 'active', createdAt: now, updatedAt: now });
  await migrateLegacyTenantData({ tenantId, uid });
  return workspaceSummary({ uid, tenantId, role: 'owner' });
}

async function migrateLegacyTenantData(context) {
  const db = getDatabase();
  for (const collection of [COLLECTIONS.jobs, COLLECTIONS.candidates, COLLECTIONS.screenings, COLLECTIONS.rules]) {
    const result = await db.collection(collection).limit(500).get().catch(() => ({ data: [] }));
    for (const item of (result.data || []).filter(record => !record.tenantId)) {
      const id = item.id || item._id;
      if (!id) continue;
      const { _id, _openid, ...stored } = item;
      await db.collection(collection).doc(id).set({ ...stored, tenantId: context.tenantId, updatedBy: context.uid, createdBy: stored.createdBy || context.uid });
    }
  }
}

async function workspaceSummary(context) {
  const db = getDatabase();
  const [tenantResult, memberResult] = await Promise.all([
    db.collection(COLLECTIONS.tenants).doc(context.tenantId).get(),
    db.collection(COLLECTIONS.members).where({ tenantId: context.tenantId, status: 'active' }).limit(200).get()
  ]);
  return { workspace: cleanDocument(tenantResult.data || { id: context.tenantId, name: '公司工作区', status: 'active' }), currentMember: cleanDocument(context.member || { uid: context.uid, tenantId: context.tenantId, role: context.role }), members: (memberResult.data || []).map(cleanDocument) };
}

async function listMembers(context) {
  requireRole(context, ['owner', 'admin']);
  const result = await getDatabase().collection(COLLECTIONS.members).where({ tenantId: context.tenantId }).limit(200).get();
  return { members: (result.data || []).map(cleanDocument) };
}

async function inviteMember(context, input = {}) {
  requireRole(context, ['owner', 'admin']);
  const uid = String(input.uid || '').trim();
  if (!uid || uid.length < 4 || uid.length > 80) throw serviceError('请输入有效的员工 UID', 400);
  const db = getDatabase();
  const existing = await db.collection(COLLECTIONS.members).where({ tenantId: context.tenantId, uid }).limit(1).get();
  if (existing.data?.[0]) throw serviceError('该员工已经在当前工作区', 409);
  const id = `${context.tenantId}_${uid}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const now = new Date().toISOString();
  await db.collection(COLLECTIONS.members).doc(id).set({ id, tenantId: context.tenantId, uid, username: String(input.username || '').slice(0, 120), displayName: String(input.displayName || input.username || uid).slice(0, 80), role: ['admin', 'recruiter', 'viewer'].includes(input.role) ? input.role : 'recruiter', status: 'invited', createdAt: now, updatedAt: now, createdBy: context.uid, updatedBy: context.uid });
  await audit(context, 'member.invite', id, { invitedUid: uid });
  return { ok: true, id };
}

async function updateMember(context, id, input = {}) {
  requireRole(context, ['owner', 'admin']);
  const db = getDatabase();
  const found = await db.collection(COLLECTIONS.members).where({ tenantId: context.tenantId, id }).limit(1).get();
  if (!found.data?.[0]) throw serviceError('成员不存在或无权操作', 404);
  const member = found.data[0];
  const nextRole = ['owner', 'admin', 'recruiter', 'viewer'].includes(input.role) ? input.role : member.role;
  const status = ['active', 'invited', 'disabled'].includes(input.status) ? input.status : member.status;
  await db.collection(COLLECTIONS.members).doc(member._id || id).set({ ...member, role: nextRole, status, displayName: String(input.displayName || member.displayName || '').slice(0, 80), updatedAt: new Date().toISOString(), updatedBy: context.uid });
  await audit(context, 'member.update', id, { role: nextRole, status });
  return { ok: true, id };
}

function requireRole(context, roles) { if (!roles.includes(context.role)) throw serviceError('当前账号没有管理权限', 403); }

async function loadState(context) {
  const db = getDatabase();
  const [jobsResult, candidatesResult, screeningsResult, rulesResult] = await Promise.all([
    db.collection(COLLECTIONS.jobs).where({ tenantId: context.tenantId }).orderBy('updatedAt', 'desc').limit(100).get(),
    db.collection(COLLECTIONS.candidates).where({ tenantId: context.tenantId }).orderBy('updatedAt', 'desc').limit(500).get(),
    db.collection(COLLECTIONS.screenings).where({ tenantId: context.tenantId }).orderBy('updatedAt', 'desc').limit(500).get(),
    db.collection(COLLECTIONS.rules).where({ tenantId: context.tenantId }).orderBy('updatedAt', 'desc').limit(200).get()
  ]);
  const screenings = new Map();
  for (const item of screeningsResult.data || []) if (!screenings.has(item.candidateId)) screenings.set(item.candidateId, item);
  const cases = (candidatesResult.data || []).map(candidate => {
    const screening = screenings.get(candidate.id || candidate._id) || {};
    return cleanDocument({ ...candidate, ...pick(screening, ['preparation', 'transcript', 'consentConfirmed', 'callRecording', 'communicationSummary', 'report']) });
  });
  return { jobs: (jobsResult.data || []).map(cleanDocument), cases, rules: (rulesResult.data || []).map(cleanDocument), workspace: { tenantId: context.tenantId, role: context.role } };
}

async function saveJob(context, id, input) {
  requireRole(context, ['owner', 'admin', 'recruiter']);
  const db = getDatabase();
  await assertWritableRecord(COLLECTIONS.jobs, id, context.tenantId);
  const now = new Date().toISOString();
  const job = pick(input, ['industry', 'name', 'jd', 'keywords', 'rules', 'status', 'createdAt', 'updatedAt']);
  job.id = id;
  job.tenantId = context.tenantId;
  job.createdBy = context.uid;
  job.updatedBy = context.uid;
  job.updatedAt = now;
  job.createdAt = job.createdAt || now;
  job.status = job.status || 'active';
  await db.collection(COLLECTIONS.jobs).doc(id).set(job);
  await audit(context, 'job.upsert', id, { name: job.name });
}

async function saveCandidate(context, id, input) {
  requireRole(context, ['owner', 'admin', 'recruiter']);
  const db = getDatabase();
  await assertWritableRecord(COLLECTIONS.candidates, id, context.tenantId);
  await assertWritableRecord(COLLECTIONS.screenings, id, context.tenantId);
  const now = new Date().toISOString();
  const candidate = pick(input, ['jobId', 'candidateName', 'roleName', 'jd', 'rules', 'keywords', 'resume', 'resumeMeta', 'matching', 'status', 'createdAt', 'updatedAt', 'ingestStatus', 'ingestBatchId', 'ingestSource', 'ingestFileKey', 'duplicateOf', 'talentProfile', 'mokaSync']);
  candidate.id = id;
  candidate.tenantId = context.tenantId;
  candidate.createdBy = context.uid;
  candidate.updatedBy = context.uid;
  candidate.updatedAt = now;
  candidate.createdAt = candidate.createdAt || now;
  candidate.status = deriveStatus(input);
  const screening = pick(input, ['preparation', 'transcript', 'consentConfirmed', 'callRecording', 'communicationSummary', 'report']);
  screening.id = id;
  screening.tenantId = context.tenantId;
  screening.createdBy = context.uid;
  screening.updatedBy = context.uid;
  screening.candidateId = id;
  screening.jobId = input.jobId || '';
  screening.updatedAt = now;
  screening.createdAt = input.createdAt || now;
  await Promise.all([
    db.collection(COLLECTIONS.candidates).doc(id).set(candidate),
    db.collection(COLLECTIONS.screenings).doc(id).set(screening)
  ]);
  await audit(context, 'candidate.upsert', id, { jobId: candidate.jobId, status: candidate.status });
}

async function assertWritableRecord(collection, id, tenantId) {
  const result = await getDatabase().collection(collection).doc(id).get().catch(() => ({ data: null }));
  const existing = result.data;
  if (existing?.tenantId && existing.tenantId !== tenantId) throw serviceError('无权操作其他公司工作区的数据', 403);
}

async function migrateStoredResumes(context) {
  requireRole(context, ['owner', 'admin', 'recruiter']);
  const db = getDatabase();
  const [candidateResult, jobResult] = await Promise.all([
    db.collection(COLLECTIONS.candidates).where({ tenantId: context.tenantId }).limit(500).get(),
    db.collection(COLLECTIONS.jobs).where({ tenantId: context.tenantId }).limit(100).get()
  ]);
  const jobs = jobResult.data || [];
  const migrated = []; const failed = [];
  for (const source of candidateResult.data || []) {
    const id = source.id || source._id; const originalText = String(source.resume || '').trim();
    if (!id || !originalText) { failed.push({ id, reason: '没有已保存的简历文本' }); continue; }
    try {
      const text = normalizeResumeText(originalText); const lines = text.split('\n').map(line => line.trim()).filter(Boolean); const basics = parseResumeBasics(text);
      basics.candidateName = chooseCandidateName(extractLabeledCandidateName(lines), extractNameFromFileName(source.resumeMeta?.fileName || ''), basics.candidateName, source.candidateName);
      const job = jobs.find(item => item.id === source.jobId) || jobs.find(item => item.name === source.roleName) || jobs[0];
      const currentMatch = source.matching || {};
      const matching = job ? { ...currentMatch, ...generateDemoMatch({ resume: text, jobs: [job] }), jobId: job.id } : currentMatch;
      const now = new Date().toISOString();
      const { _id, _openid, ...stored } = source;
      await db.collection(COLLECTIONS.candidates).doc(id).set({
        ...stored,
        id,
        tenantId: context.tenantId,
        updatedBy: context.uid,
        resume: text,
        candidateName: basics.candidateName || source.candidateName || '',
        resumeMeta: { ...(source.resumeMeta || {}), ...basics, textNormalizedAt: now },
        matching,
        updatedAt: now
      });
      migrated.push(id);
    } catch (error) { failed.push({ id, reason: error.message }); }
  }
  await audit(context, 'candidate.resume.migrate', 'all', { migrated: migrated.length, failed: failed.length });
  return { ok: true, migrated: migrated.length, failed };
}

async function audit(context, action, entityId, detail) {
  const db = getDatabase();
  await db.collection(COLLECTIONS.audit).add({ tenantId: context.tenantId, action, entityId, detail, actorUid: context.uid, actorRole: context.role, createdAt: new Date().toISOString() });
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
  const lines = String(text).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g, '').split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const counts = new Map(); lines.forEach(line => counts.set(line, (counts.get(line) || 0) + 1));
  text = lines.filter(line => { if ((counts.get(line) || 0) >= 3 && line.length < 80) return false; const visible = line.replace(/[\u4e00-\u9fffA-Za-z0-9@.+#:/()（）、，。；：\-]/g, ''); return visible.length / Math.max(line.length, 1) < 0.45; }).join('\n').replace(/([A-Za-z])\-\n([A-Za-z])/g, '$1$2').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 20) throw serviceError('未提取到足够文字；如果是扫描版 PDF，请先进行 OCR', 422);
  const phone = (text.match(/(?<!\d)(?:\+?86[ -]?)?1[3-9](?:[ -]?\d){9}(?!\d)/)?.[0] || '').replace(/[ -]/g, '');
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '').replace(/[，。；;）)]+$/, '');
  const experienceYears = text.match(/(\d{1,2})\s*年[^。\n]{0,16}(?:工作|从业|经验|经历)/)?.[1] || '';
  const age = text.match(/(?:年龄|Age)\s*[:：]?\s*(\d{2})(?:岁)?/i)?.[1] || text.match(/(?<!\d)(2[0-9]|3[0-9]|4[0-9])\s*岁/)?.[1] || '';
  const education = ['博士', '硕士', '本科', '大专'].find(level => text.includes(level)) || '';
  const resumeLines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const candidateName = chooseCandidateName(extractLabeledCandidateName(resumeLines), extractNameFromFileName(fileName), extractCandidateName(resumeLines));
  return { text, metadata: { fileName, extension: extension.slice(1).toUpperCase(), characters: text.length, candidateName, phone, email, age, experienceYears, education } };
}

let baiduAccessToken = { value: '', expiresAt: 0 };

async function transcribeWithBaidu(fileName, buffer) {
  const apiKey = process.env.BAIDU_API_KEY;
  const secretKey = process.env.BAIDU_SECRET_KEY;
  if (!apiKey || !secretKey) throw serviceError('百度语音服务尚未配置，请联系管理员配置 BAIDU_API_KEY 和 BAIDU_SECRET_KEY', 503);
  if (!buffer.length) throw serviceError('录音文件为空', 400);
  // 百度短语音接口单次请求建议不超过 10 MB；更大的文件应先压缩或拆分。
  if (buffer.length > 10 * 1024 * 1024) throw serviceError('录音文件超过百度短语音接口的 10MB 限制，请压缩或拆分后重试', 413);
  const token = await getBaiduAccessToken(apiKey, secretKey);
  const extension = path.extname(fileName).toLowerCase().slice(1) || 'm4a';
  const supportedFormats = new Set(['mp3', 'wav', 'pcm', 'amr', 'm4a']);
  if (!supportedFormats.has(extension)) throw serviceError('百度短语音仅支持 MP3、WAV、PCM、AMR 和 M4A，请先转换录音格式', 415);
  const format = extension;
  const response = await fetch(`https://vop.baidu.com/server_api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format, rate: 16000, channel: 1, cuid: 'acecall', token, speech: buffer.toString('base64'), len: buffer.length, dev_pid: 1537 })
  });
  if (!response.ok) throw serviceError(`百度语音服务请求失败（${response.status}）`, 502);
  const result = await response.json();
  if (result.err_no !== 0) {
    const detail = result.err_msg || `错误码 ${result.err_no}`;
    const hint = [3300, 3301, 3302, 3303].includes(Number(result.err_no)) ? '；请确认录音不超过 60 秒且为可解码的 MP3、WAV、AMR 或 M4A 文件' : '';
    throw serviceError(`百度语音识别失败：${detail}${hint}`, 422);
  }
  const text = Array.isArray(result.result) ? result.result.join(' ').trim() : String(result.result || '').trim();
  if (!text) throw serviceError('百度语音服务未返回有效文字', 422);
  return { text, provider: 'baidu', fileName, characters: text.length };
}

async function getBaiduAccessToken(apiKey, secretKey) {
  if (baiduAccessToken.value && baiduAccessToken.expiresAt > Date.now() + 60_000) return baiduAccessToken.value;
  const response = await fetch(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`, { method: 'POST' });
  if (!response.ok) throw serviceError(`百度语音授权失败（${response.status}）`, 502);
  const result = await response.json();
  if (!result.access_token) {
    const reason = result.error_description || result.error || '未返回 access_token';
    throw serviceError(`百度语音授权失败：${reason}。请在百度智能云控制台确认当前应用的 API Key、Secret Key 仍有效，并已开通语音识别服务`, 502);
  }
  baiduAccessToken = { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 2592000) * 1000 };
  return baiduAccessToken.value;
}

function extractCandidateName(lines = []) {
  const labeled = extractLabeledCandidateName(lines); if (labeled) return labeled;
  for (const line of lines.slice(0, 30)) {
    if (isNameNoise(line) || /@|1[3-9]\d{9}|\d{2,4}[-/.年]/.test(line)) continue;
    const chinese = [...line.matchAll(/(?<![\u4e00-\u9fff])[\u4e00-\u9fff]{2,4}(?![\u4e00-\u9fff])/g)].map(item => item[0]);
    const candidate = chinese.reverse().find(isPlausibleCandidateName); if (candidate) return normalizeCandidateName(candidate);
    const english = line.match(/\b[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,3}\b/)?.[0]; if (isPlausibleCandidateName(english)) return normalizeCandidateName(english);
  }
  return '';
}

function extractLabeledCandidateName(lines = []) {
  for (const line of lines.slice(0, 30)) { const labeled = line.match(/(?:姓名|候选人|Candidate|Name)\s*[:：]?\s*([\u4e00-\u9fff]{2,4}|[A-Za-z][A-Za-z .'-]{1,30})/i)?.[1]; if (isPlausibleCandidateName(labeled)) return normalizeCandidateName(labeled); }
  return '';
}

function extractNameFromFileName(fileName = '') {
  const value = path.basename(fileName, path.extname(fileName)).replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[_-]+/g, ' ').replace(/\b(?:CV|Resume|for|cn|en)\b/gi, ' ').replace(/(?:的)?简历|工作\s*\d+\s*年|\d+\s*年(?:经验)?|\d{2,4}K|Golang|Java|开发工程师|产品经理|风控专员|服务端开发|应届生|候选人|人才报告|附件/g, ' ').replace(/\s+/g, ' ').trim();
  const chinese = [...value.matchAll(/(?<![\u4e00-\u9fff])[\u4e00-\u9fff]{2,4}(?![\u4e00-\u9fff])/g)].map(item => item[0]).filter(isPlausibleCandidateName);
  if (chinese.length) return normalizeCandidateName(chinese[chinese.length - 1]);
  const english = value.match(/\b[A-Z][A-Za-z']{1,20}(?:\s+[A-Z][A-Za-z']{1,20}){1,3}\b/)?.[0] || '';
  return isPlausibleCandidateName(english) ? normalizeCandidateName(english) : '';
}

function normalizeCandidateName(value = '') {
  return String(value).replace(/[\u200b\ufeff]/g, '').replace(/^(?:姓名|候选人|Candidate|Name)\s*[:：]?\s*/i, '').replace(/^[\s:：|·•\-]+|[\s,，。；;、]+$/g, '').trim();
}

function isNameNoise(value = '') {
  return /姓名|简历|个人信息|基本信息|工作经历|教育背景|教育经历|项目经历|专业技能|自我评价|求职意向|出生日期|年龄|电话|手机|邮箱|微信|职位|岗位|经验|任职|联系方式|画像|背景信息|建联沟通|绩点|寻访|大学|学院|学校|科技|计算机|公司|集团|招聘|应届生|summary|resume|experience|education/i.test(String(value));
}

function isPlausibleCandidateName(value = '') {
  const name = normalizeCandidateName(value);
  if (!name || isNameNoise(name) || /[:：@]|\d{2,}/.test(name)) return false;
  return /^[\u4e00-\u9fff]{2,4}$/.test(name) || /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(name);
}

function chooseCandidateName(...values) {
  const selected = values.map(normalizeCandidateName).find(isPlausibleCandidateName);
  return selected || '';
}

function validatePayload(payload) {
  if (!['prepare', 'summarize', 'synthesize', 'match'].includes(payload.action)) throw serviceError('未知工作流步骤', 400);
  if (payload.action === 'match' && (!payload.resume?.trim() || !Array.isArray(payload.jobs))) throw serviceError('请提供简历和岗位列表', 400);
  if (payload.action === 'prepare' && (!payload.jd?.trim() || !payload.resume?.trim())) throw serviceError('请填写 JD 和候选人简历', 400);
  if (payload.action === 'summarize' && !payload.transcript?.trim()) throw serviceError('请填写电话转写内容', 400);
  if (payload.action === 'synthesize' && (!payload.preparation || !payload.communicationSummary)) throw serviceError('请先生成初筛方案和沟通总结', 400);
}

function buildModelPrompt(payload) {
  const schema = payload.action === 'prepare' ? prepareSchema() : payload.action === 'summarize' ? summarySchema() : payload.action === 'synthesize' ? synthesisSchema() : matchSchema();
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
function matchSchema() {
  return '岗位匹配字段：jobId 字符串（主岗位ID）；score 0到100整数；confidence（高/中/低）；status（已分配/待分配）；dimensions 数组，每项含 item、score、evidence；alternativeJobs 数组，每项含 name、score、reason；risks 数组，每项含 risk、evidence。根据简历事实和岗位JD、关键词进行语义匹配，缺失信息不等于不匹配，不得使用年龄、性别、婚育、籍贯等因素。';
}
function summarySchema() {
  return '沟通总结字段：overview 字符串；confirmed、contradicted、missing 数组，每项含 item、evidence；questionCoverage 对象含 covered、total、unanswered 数组；keyFacts 对象含 currentCompanyRole、location、currentSalary、expectedSalary、availability、motivation、nonCompete；candidateSignals 字符串数组；followUps 字符串数组。只总结电话内容，不给推荐结论。';
}
function synthesisSchema() {
  return '综合审核字段：basicInfo 对象；capabilities 数组，每项含 item、evidence、assessment（匹配/部分匹配/信息不足/不匹配）；evidence 字符串数组；conflicts 数组，每项含 topic、resumeClaim、callEvidence；risks 字符串数组；conclusion（明确匹配/部分匹配/信息不足/明确不匹配）；conclusionReason 字符串；nextStep（推荐业务面试/补充电话沟通/转入其他岗位/暂不推进/纳入人才库长期维护）；followUps 字符串数组。';
}

function generateDemo(payload) {
  if (payload.action === 'match') return generateDemoMatch(payload);
  if (payload.action === 'prepare') return { summary: { headline: `${payload.candidateName || '候选人'}正在评估${payload.roleName || '目标岗位'}`, experience: '演示模式不进行事实推断', relevantBackground: '请配置DeepSeek密钥启用语义分析', openFacts: '职责、项目结果和基本条件待确认' }, matches: [], risks: [{ risk: '当前为演示模式', evidence: '未配置DeepSeek密钥', impact: '结果不能用于招聘判断' }], verification: [], questions: defaultQuestions() };
  if (payload.action === 'summarize') return { overview: '演示模式仅保存电话文本。', confirmed: [], contradicted: [], missing: [], questionCoverage: { covered: 0, total: payload.preparation?.questions?.length || 0, unanswered: [] }, keyFacts: {}, candidateSignals: [], followUps: [] };
  return { basicInfo: {}, capabilities: [], evidence: [], conflicts: [], risks: ['当前为演示模式'], conclusion: '信息不足', conclusionReason: '未启用AI服务。', nextStep: '补充电话沟通', followUps: [] };
}
function generateDemoMatch(payload) {
  const ranked = payload.jobs.map(job => { const terms = findSharedTerms(`${job.name} ${job.jd}`, payload.resume, job.keywords); const score = Math.min(99, Math.round((terms.length / Math.max((job.keywords || []).length, 4)) * 70 + (payload.resume.includes(job.industry || '') ? 15 : 0) + (terms.length ? 10 : 0))); return { job, score, terms }; }).sort((a, b) => b.score - a.score);
  const first = ranked[0];
  if (!first) return { status: '待分配', score: 0, confidence: '低', alternativeJobs: [], risks: [{ risk: '岗位库为空', evidence: '暂无可匹配岗位' }] };
  return { jobId: first.job.id, score: first.score, confidence: first.score >= 75 ? '高' : first.score >= 50 ? '中' : '低', status: first.score >= 50 ? '已分配' : '待分配', dimensions: [{ item: '核心关键词', score: first.score, evidence: first.terms.join('、') || '未识别共同关键词' }], alternativeJobs: ranked.slice(1, 3).map(item => ({ name: item.job.name, score: item.score, reason: item.terms.join('、') || '共同信息较少' })), risks: first.score < 50 ? [{ risk: '岗位匹配度较低', evidence: '简历与岗位共同关键词有限' }] : [] };
}

function defaultQuestions() {
  return ['请介绍最相关的项目背景、个人职责和最终结果。', '哪些决策由你直接负责？', '项目是否上线，有哪些可量化结果？', '为什么现在考虑新的机会？', '请确认地点、薪资、到岗时间和竞业限制。'].map(question => ({ category: '重点核验', question, reason: '核实岗位相关事实', source: '通用' }));
}

function findSharedTerms(left = '', right = '', customTerms = []) {
  const terms = [...new Set(['证券', '场外期权', '衍生品', '交易', '产品', '研发', '量化', '风险', '管理', '金融科技', '询报价', '生命周期', ...customTerms])];
  return terms.filter(term => left.includes(term) && right.includes(term));
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

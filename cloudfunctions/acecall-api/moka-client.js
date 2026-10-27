const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 15000;

function getMokaConfig(env = process.env) {
  return {
    apiKey: String(env.MOKA_API_KEY || '').trim(),
    baseUrl: String(env.MOKA_BASE_URL || '').trim().replace(/\/$/, ''),
    enterpriseId: String(env.MOKA_ENTERPRISE_ID || '').trim(),
    apiKeyHeader: String(env.MOKA_API_KEY_HEADER || 'Authorization').trim() || 'Authorization',
    authMode: String(env.MOKA_AUTH_MODE || 'basic').trim().toLowerCase(),
    apiKeyPrefix: String(env.MOKA_API_KEY_PREFIX || '').trim(),
    interviewsPath: String(env.MOKA_INTERVIEWS_PATH || '/api-platform/v1/interviews').trim(),
    jobsPath: String(env.MOKA_JOBS_PATH || '/api-platform/v1/jobs').trim(),
    requisitionsPath: String(env.MOKA_REQUISITIONS_PATH || '/api-platform/v1/requisitions').trim(),
    applicationsPath: String(env.MOKA_APPLICATIONS_PATH || '/api-platform/v1/applications').trim(),
    applicationsLookupPath: String(env.MOKA_APPLICATIONS_LOOKUP_PATH || '/api-platform/v3/applications/list_by_contact_or_id').trim(),
    commentPath: String(env.MOKA_COMMENT_PATH || '/api-platform/pipeline/v3/application/addComment').trim(),
    resumeUploadPath: String(env.MOKA_RESUME_UPLOAD_PATH || '/api-platform/v3/candidate/uploadResume').trim(),
    sourceId: String(env.MOKA_SOURCE_ID || '').trim(),
    operatorEmail: String(env.MOKA_OPERATOR_EMAIL || '').trim(),
    interviewInformationPath: String(env.MOKA_INTERVIEW_INFORMATION_PATH || '/api-platform/v1/interview/interview-information').trim(),
    interviewInfosV3Path: String(env.MOKA_INTERVIEW_INFOS_V3_PATH || '/api-platform/v3/getInterviewInfos').trim(),
    projectName: String(env.MOKA_PROJECT_NAME || 'QS').trim(),
    jobNames: String(env.MOKA_JOB_NAMES || '法务BP,OTC交易产品经理,交易产品经理,清结算产品经理,行情产品经理,账户产品经理,数据分析师,券商服务端开发工程师（长沙）,结算专员,券商客服主管,证券设计师,证券运维工程师,券商测试工程师,券商业务后端开发工程师').split(',').map(item => item.trim()).filter(Boolean)
  };
}

function maskSecret(value = '') {
  const secret = String(value);
  if (!secret) return '';
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

function createMokaClient(options = {}) {
  const config = { ...getMokaConfig(), ...options };
  const timeoutMs = Number(options.timeoutMs || process.env.MOKA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    config,
    authHeaders(requestHeaders = {}) {
      const headers = { Accept: 'application/json', ...requestHeaders };
      const value = config.authMode === 'basic'
        ? `Basic ${Buffer.from(`${config.apiKey}:`, 'utf8').toString('base64')}`
        : (config.apiKeyPrefix ? `${config.apiKeyPrefix} ${config.apiKey}` : config.apiKey);
      headers[config.apiKeyHeader] = value;
      return headers;
    },
    async request(path = '/', requestOptions = {}) {
      if (!config.baseUrl) throw new Error('MOKA_BASE_URL is not configured');
      if (!config.apiKey) throw new Error('MOKA_API_KEY is not configured');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(requestOptions.timeoutMs) || timeoutMs);
      const headers = this.authHeaders(requestOptions.headers || {});
      const { timeoutMs: _requestTimeout, ...fetchOptions } = requestOptions;
      try {
        const response = await fetch(`${config.baseUrl}/${String(path).replace(/^\//, '')}`, { ...fetchOptions, headers, signal: controller.signal });
        const contentType = response.headers.get('content-type') || '';
        const body = contentType.includes('application/json') ? await response.json() : await response.text();
        return { ok: response.ok, status: response.status, body };
      } finally {
        clearTimeout(timer);
      }
    },
    async requestBinary(path = '/', requestOptions = {}) {
      if (!config.baseUrl) throw new Error('MOKA_BASE_URL is not configured');
      if (!config.apiKey) throw new Error('MOKA_API_KEY is not configured');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const target = /^https?:\/\//i.test(String(path)) ? String(path) : `${config.baseUrl}/${String(path).replace(/^\//, '')}`;
      try {
        const targetHost = new URL(target).hostname.toLowerCase();
        const baseHost = new URL(config.baseUrl).hostname.toLowerCase();
        const sameMokaHost = targetHost === baseHost || targetHost === 'mokahr.com' || targetHost.endsWith('.mokahr.com') || targetHost.endsWith('.mokahr.cn');
        const headers = sameMokaHost ? this.authHeaders(requestOptions.headers || {}) : { Accept: '*/*', ...(requestOptions.headers || {}) };
        const response = await fetch(target, { ...requestOptions, headers, signal: controller.signal });
        return { ok: response.ok, status: response.status, contentType: response.headers.get('content-type') || '', buffer: Buffer.from(await response.arrayBuffer()) };
      } finally {
        clearTimeout(timer);
      }
    },
    describe() {
      return {
        configured: Boolean(config.baseUrl && config.apiKey),
        baseUrl: config.baseUrl || '',
        enterpriseConfigured: Boolean(config.enterpriseId),
        apiKey: maskSecret(config.apiKey),
        apiKeyHeader: config.apiKeyHeader,
        authMode: config.authMode,
        interviewsPath: config.interviewsPath,
        jobNames: config.jobNames,
        projectName: config.projectName
      };
    }
  };
}

function mokaConnectionStatus(env = process.env) {
  const config = getMokaConfig(env);
  return {
    configured: Boolean(config.baseUrl && config.apiKey),
    baseUrl: config.baseUrl || '',
    enterpriseConfigured: Boolean(config.enterpriseId),
    apiKey: maskSecret(config.apiKey),
    apiKeyHeader: config.apiKeyHeader,
    authMode: config.authMode,
    interviewsPath: config.interviewsPath,
    jobNames: config.jobNames,
    projectName: config.projectName
  };
}

function clipText(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length >= 13 && digits.startsWith('86')) return digits.slice(-11);
  return digits.length >= 11 ? digits.slice(-11) : '';
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.includes('@') ? email : '';
}

function chooseOperatorEmail(username, fallback = '') {
  return normalizeEmail(username) || normalizeEmail(fallback);
}

function screeningFingerprint(candidate = {}) {
  const report = candidate.report || {};
  const summary = candidate.communicationSummary || {};
  return crypto.createHash('sha256').update(JSON.stringify({
    conclusion: report.conclusion || '',
    finalDecision: report.finalDecision || report.nextStep || '',
    recommendationReason: report.recommendationReason || '',
    overview: summary.overview || '',
    reviewConfirmed: candidate.reviewConfirmed === true || report.reviewConfirmed === true,
    reviewDecisionId: report.reviewDecisionId || candidate.reviewDecisionId || '',
    resume: clipText(candidate.resume, 600),
    noteVersion: 'screening-note-v4'
  })).digest('hex').slice(0, 24);
}

function usefulNoteText(value, limit) {
  const text = clipText(value, limit);
  return text && !['无', '暂无', '待确认'].includes(text) ? text : '';
}

function interviewerFocusPoints(candidate = {}) {
  const report = candidate.report || {};
  const summary = candidate.communicationSummary || {};
  const points = [];
  const push = (value) => {
    const raw = typeof value === 'string' ? value : (value?.item || value?.topic || '');
    const text = clipText(raw, 80);
    if (!text || points.includes(text) || isSalaryText(text)) return;
    points.push(text);
  };
  (Array.isArray(report.followUps) ? report.followUps : []).forEach(push);
  if (points.length < 3) {
    (Array.isArray(report.risks) ? report.risks : []).forEach(push);
    (Array.isArray(report.conflicts) ? report.conflicts : []).forEach(item => {
      if (item && typeof item === 'object' && item.topic) push(`${item.topic}需要核对`);
      else push(item);
    });
    (Array.isArray(summary.missing) ? summary.missing : []).forEach(push);
    const facts = summary.keyFacts || {};
    [['竞业', facts.nonCompete], ['到岗', facts.availability]].forEach(([label, value]) => {
      if (/待确认|未明确|不清楚|没有明确|没说/.test(String(value || ''))) push(`${label}尚未确认，需要面试当面核实`);
    });
  }
  return points.slice(0, 5);
}

function screeningWritePlan(record = {}, previous = null) {
  const confirmed = record.reviewConfirmed === true || record.report?.reviewConfirmed === true;
  const fingerprint = screeningFingerprint(record);
  const reviewDecisionId = String(record.report?.reviewDecisionId || record.reviewDecisionId || (confirmed ? `rd_${fingerprint}` : ''));
  if (!confirmed) return { action: 'draft', status: '草稿', fingerprint, reviewDecisionId };
  if (previous?.status === '已同步' && previous.reviewDecisionId && previous.reviewDecisionId === reviewDecisionId) return { action: 'skip', status: '已同步', fingerprint: previous.fingerprint || fingerprint, reviewDecisionId };
  return { action: 'write', status: '待写入', fingerprint, reviewDecisionId };
}

function isSalaryText(value) {
  return /薪资|薪水|工资|年薪|月薪|薪酬|底薪|税前|税后|总包|年包|月包|待遇|期望薪|当前薪|salary|compensation|\d+\s*[kK](?![A-Za-z])/i.test(String(value || ''));
}

function salaryClauses(text) {
  const source = clipText(text, 160);
  if (!source || !isSalaryText(source)) return { salary: [], rest: source };
  const clauses = source.split(/[，,]/).map(part => part.trim()).filter(part => part.length >= 2);
  if (clauses.length <= 1) return { salary: [source], rest: '' };
  const salary = [];
  const rest = [];
  clauses.forEach(part => (isSalaryText(part) ? salary : rest).push(part));
  return { salary, rest: rest.join('，') };
}

function pushUnique(bucket, value) {
  const text = clipText(value, 160);
  if (!text || bucket.some(item => item === text || item.includes(text) || text.includes(item))) return;
  bucket.push(text);
}

function salaryInfoLines(candidate = {}) {
  const summary = candidate.communicationSummary || {};
  const report = candidate.report || {};
  const facts = summary.keyFacts || {};
  const lines = [];
  distilledExperienceLines(report.conclusionReason).forEach(line => salaryClauses(line).salary.forEach(item => pushUnique(lines, item)));
  [['当前薪资', facts.currentSalary], ['期望薪资', facts.expectedSalary]].forEach(([label, value]) => {
    if (clipText(value, 160)) pushUnique(lines, `${label}：${clipText(value, 160)}`);
  });
  const mention = (value) => {
    const raw = typeof value === 'string' ? value : (value?.item || value?.topic || '');
    if (isSalaryText(raw)) pushUnique(lines, raw);
  };
  (Array.isArray(report.followUps) ? report.followUps : []).forEach(mention);
  (Array.isArray(report.risks) ? report.risks : []).forEach(mention);
  (Array.isArray(report.conflicts) ? report.conflicts : []).forEach(mention);
  (Array.isArray(summary.missing) ? summary.missing : []).forEach(mention);
  return lines.map((item, index) => `${index + 1}. ${item}`);
}

function distilledExperienceLines(value) {
  const text = usefulNoteText(value, 500);
  if (!text) return [];
  const parts = text.split(/\n+|；|;|(?<=[。！？])/).map(part => part.replace(/^[，,。！？；;\s]+|[。！？；;\s]+$/g, '').trim()).filter(part => part.length >= 2);
  const verdict = /^(明确匹配|部分匹配|信息不足|明确不匹配|推荐|不推荐|推荐业务面试|补充电话沟通|转入其他岗位|暂不推进|纳入人才库长期维护|待确认)$/;
  const lines = parts.filter(part => !verdict.test(part)).map(part => clipText(part, 160));
  return lines.length ? lines : parts.map(part => clipText(part, 160));
}

function basicInfoLines(candidate = {}) {
  const summary = candidate.communicationSummary || {};
  const report = candidate.report || {};
  const facts = summary.keyFacts || {};
  const points = [];
  const push = (value) => {
    const text = clipText(value, 160);
    if (!text || points.some(item => item === text || item.includes(text) || text.includes(item))) return;
    points.push(text);
  };
  distilledExperienceLines(report.conclusionReason).forEach(line => {
    const rest = salaryClauses(line).rest;
    if (rest && !isSalaryText(rest)) push(rest);
  });
  [
    ['当前职位', facts.currentCompanyRole],
    ['地点', facts.location],
    ['到岗', facts.availability],
    ['动机', facts.motivation],
    ['竞业', facts.nonCompete]
  ].forEach(([label, value]) => {
    const text = clipText(value, 160);
    if (!text || isSalaryText(text)) return;
    push(`${label}：${text}`);
  });
  return points.map((item, index) => `${index + 1}. ${item}`);
}

function buildScreeningNote(candidate = {}) {
  const focus = interviewerFocusPoints(candidate);
  const basics = basicInfoLines(candidate);
  const lines = [
    `候选人：${clipText(candidate.candidateName, 40) || '未命名'}`,
    `岗位：${clipText(candidate.roleName, 60) || '未分配'}`
  ];
  if (basics.length) lines.push('', '基本信息：', ...basics);
  if (focus.length) lines.push('', '建议后续面试官重点关注：', ...focus.map((item, index) => `${index + 1}. ${item}`));
  return lines.join('\n').slice(0, 4000);
}

function buildSalaryNote(candidate = {}) {
  const lines = salaryInfoLines(candidate);
  if (!lines.length) return '';
  return [
    `候选人：${clipText(candidate.candidateName, 40) || '未命名'}`,
    `岗位：${clipText(candidate.roleName, 60) || '未分配'}`,
    '',
    '薪资信息：',
    ...lines
  ].join('\n').slice(0, 4000);
}

function applicationList(body) {
  const data = body?.data && typeof body.data === 'object' ? body.data : body || {};
  const list = data.applicationList || data.applications || data.list || [];
  return Array.isArray(list) ? list : [];
}

function applicationTime(item) {
  const raw = item?.updatedAt || item?.appliedAt || 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

function applicationTitle(item) {
  return String(item?.job?.jobTitle || item?.jobTitle || '').replace(/\s+/g, '').toLowerCase();
}

function applicationJobId(item) {
  return String(item?.job?.jobId || item?.jobId || '');
}

function chooseMokaApplicationForJob(applications = [], roleName = '', mokaJobId = '') {
  const records = applications.filter(Boolean);
  const active = records.filter(item => item.archived !== true);
  const pool = active.length ? active : records;
  const wantedId = String(mokaJobId || '');
  if (wantedId) {
    const byId = pool.find(item => applicationJobId(item) === wantedId);
    if (byId) return byId;
  }
  const wanted = String(roleName || '').replace(/\s+/g, '').toLowerCase();
  if (!wanted) return null;
  return pool.find(item => {
    const title = applicationTitle(item);
    return title && (title.includes(wanted) || wanted.includes(title));
  }) || null;
}

function chooseMokaApplication(applications = [], roleName = '') {
  const records = applications.filter(Boolean);
  const active = records.filter(item => item.archived !== true);
  const pool = active.length ? active : records;
  const wanted = String(roleName || '').replace(/\s+/g, '').toLowerCase();
  const matched = wanted ? pool.find(item => {
    const title = applicationTitle(item);
    return title && (title.includes(wanted) || wanted.includes(title));
  }) : null;
  return matched || [...pool].sort((left, right) => applicationTime(right) - applicationTime(left))[0] || null;
}

function syncResult(status, extra = {}) {
  return { status, syncedAt: new Date().toISOString(), ...extra };
}

function signedNote(note, name) {
  const person = String(name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
  if (!person || !note) return note;
  return `${note}\n\n操作人：${person}`.slice(0, 4000);
}

function commentSucceeded(comment) {
  const code = Number(comment.body?.code);
  const commentId = comment.body?.data?.commentId || comment.body?.commentId || '';
  return { ok: Boolean(comment.ok) && !(Number.isFinite(code) && code !== 0 && code !== 200), commentId: String(commentId), message: comment.body?.msg || comment.status };
}

function responseJson(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string') return {};
  try { return JSON.parse(body); } catch { return { msg: body.slice(0, 180) }; }
}

function resumeMultipart(fields, file) {
  const boundary = `----AceCall${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [Buffer.from('')];
  Object.entries(fields).forEach(([name, value]) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  });
  const fileName = String(file.fileName || 'resume.pdf').replace(/[\r\n"]/g, '') || 'resume.pdf';
  const mimeType = String(file.mimeType || 'application/octet-stream').replace(/[\r\n"]/g, '') || 'application/octet-stream';
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="resume"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
  chunks.push(Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || ''));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadResumeToJob(client, { email, sourceId, mokaJobId, resumeFile }) {
  const form = resumeMultipart({
    operateEmail: email,
    sourceId: String(sourceId),
    jobId: String(mokaJobId),
    isBreakJobPermission: 'true'
  }, resumeFile);
  const response = await client.request(client.config.resumeUploadPath, {
    method: 'POST',
    headers: { 'Content-Type': form.contentType },
    body: form.body,
    timeoutMs: 45000
  });
  const body = responseJson(response.body);
  const code = Number(body.code);
  const application = body.data?.application || {};
  const applicationId = application.id || body.data?.applicationId || '';
  const ok = Boolean(response.ok) && Boolean(applicationId) && !(Number.isFinite(code) && code !== 0 && code !== 200);
  return { ok, applicationId: String(applicationId || ''), candidateId: String(application.candidateId || ''), jobId: String(application.jobId || mokaJobId || ''), message: body.msg || response.status };
}

async function postApplicationComment(client, applicationId, email, content) {
  const comment = await client.request(client.config.commentPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      applicationId: /^\d{1,15}$/.test(String(applicationId)) ? Number(applicationId) : applicationId,
      content,
      operatorEmail: email
    })
  });
  return commentSucceeded(comment);
}

async function writeScreeningNotes(client, application, email, candidate, salaryNote, operatorName = '') {
  const applicationId = application?.applicationId || application?.id;
  const base = {
    applicationId: String(applicationId),
    candidateId: String(application.candidateBaseInfo?.candidateId || application.candidateId || ''),
    jobTitle: application.job?.jobTitle || application.jobTitle || '',
    mokaJobId: applicationJobId(application)
  };
  const comment = await postApplicationComment(client, applicationId, email, signedNote(buildScreeningNote(candidate), operatorName));
  if (!comment.ok) return syncResult(`Moka 备注写入失败（${comment.message}）`, base);
  const synced = { ...base, commentId: comment.commentId };
  if (!salaryNote) return syncResult('已同步', synced);
  const salary = await postApplicationComment(client, applicationId, email, signedNote(salaryNote, operatorName));
  if (!salary.ok) return syncResult(`薪资备注写入失败（${salary.message}）`, synced);
  return syncResult('已同步', { ...synced, salaryCommentId: salary.commentId });
}

async function syncScreeningComment(client, candidate = {}, operatorEmail = '', previous = null, delivery = null) {
  if (!client?.config?.baseUrl || !client?.config?.apiKey) return syncResult('未配置');
  const email = normalizeEmail(operatorEmail || client.config.operatorEmail);
  if (!email) return syncResult('缺少 Moka 操作人邮箱');
  const phone = normalizePhone(candidate.resumeMeta?.phone);
  const candidateEmail = normalizeEmail(candidate.resumeMeta?.email);
  const salaryNote = buildSalaryNote(candidate);
  const decisionId = String(candidate.report?.reviewDecisionId || candidate.reviewDecisionId || '');
  const retrySalary = previous?.status !== '已同步' && previous?.commentId && previous.applicationId && !previous.salaryCommentId && salaryNote && (!decisionId || !previous.reviewDecisionId || decisionId === previous.reviewDecisionId);
  if (retrySalary) {
    const salary = await postApplicationComment(client, previous.applicationId, email, signedNote(salaryNote, delivery?.operatorName));
    if (!salary.ok) return syncResult(`薪资备注写入失败（${salary.message}）`, { applicationId: String(previous.applicationId), commentId: String(previous.commentId), candidateId: previous.candidateId || '', mokaJobId: previous.mokaJobId || '' });
    return syncResult('已同步', { applicationId: String(previous.applicationId), commentId: String(previous.commentId), salaryCommentId: salary.commentId, candidateId: previous.candidateId || '', jobTitle: previous.jobTitle || '', mokaJobId: previous.mokaJobId || '' });
  }
  const retryNote = previous?.applicationId && !previous.commentId && String(previous.status || '').includes('备注写入失败');
  if (retryNote) return writeScreeningNotes(client, { applicationId: previous.applicationId, candidateId: previous.candidateId || '', job: { jobId: previous.mokaJobId || '', jobTitle: previous.jobTitle || '' }, jobTitle: previous.jobTitle || '' }, email, candidate, salaryNote, delivery?.operatorName);
  if (!phone && !candidateEmail && !delivery?.resumeFile) return syncResult('缺少手机号或邮箱');
  let application = null;
  if (phone || candidateEmail) {
    const lookupBody = {};
    if (phone) lookupBody.phoneList = [phone];
    if (candidateEmail) lookupBody.emailList = [candidateEmail];
    const lookup = await client.request(client.config.applicationsLookupPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lookupBody)
    });
    if (!lookup.ok) return syncResult(`Moka 申请查询失败（${lookup.status}）`);
    const found = applicationList(lookup.body);
    const mokaJobId = String(delivery?.mokaJobId || '').trim();
    application = mokaJobId ? chooseMokaApplicationForJob(found, candidate.roleName, mokaJobId) : chooseMokaApplication(found, candidate.roleName);
  }
  if (!application) {
    const mokaJobId = String(delivery?.mokaJobId || '').trim();
    const resumeFile = delivery?.resumeFile;
    if (!mokaJobId) return syncResult(delivery && Object.prototype.hasOwnProperty.call(delivery, 'resumeFile') ? '岗位未关联 Moka' : '未匹配到 Moka 申请');
    if (!resumeFile?.buffer?.length) return syncResult('缺少简历原件');
    const sourceId = String(delivery?.sourceId || client.config.sourceId || '').trim();
    if (!sourceId) return syncResult('缺少 Moka 渠道编号');
    const uploaded = await uploadResumeToJob(client, { email, sourceId, mokaJobId, resumeFile });
    if (!uploaded.ok) return syncResult(`简历上传失败（${uploaded.message}）`, { mokaJobId });
    application = { applicationId: uploaded.applicationId, candidateId: uploaded.candidateId, job: { jobId: uploaded.jobId || mokaJobId, jobTitle: candidate.roleName || '' } };
  }
  return writeScreeningNotes(client, application, email, candidate, salaryNote, delivery?.operatorName);
}

module.exports = {
  createMokaClient,
  getMokaConfig,
  mokaConnectionStatus,
  maskSecret,
  screeningFingerprint,
  screeningWritePlan,
  chooseOperatorEmail,
  buildScreeningNote,
  buildSalaryNote,
  isSalaryText,
  chooseMokaApplication,
  chooseMokaApplicationForJob,
  syncScreeningComment
};

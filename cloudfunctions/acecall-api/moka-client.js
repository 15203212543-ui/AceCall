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
    operatorEmail: String(env.MOKA_OPERATOR_EMAIL || '').trim(),
    interviewInformationPath: String(env.MOKA_INTERVIEW_INFORMATION_PATH || '/api-platform/v1/interview/interview-information').trim(),
    interviewInfosV3Path: String(env.MOKA_INTERVIEW_INFOS_V3_PATH || '/api-platform/v3/getInterviewInfos').trim(),
    projectName: String(env.MOKA_PROJECT_NAME || 'QS').trim(),
    jobNames: String(env.MOKA_JOB_NAMES || '法务BP,交易产品经理,清结算产品经理,行情产品经理,账户产品经理,数据分析师,券商服务端开发工程师（长沙）,结算专员,券商客服主管,证券设计师,证券运维工程师,券商测试工程师,券商业务后端开发工程师').split(',').map(item => item.trim()).filter(Boolean)
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
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const headers = this.authHeaders(requestOptions.headers || {});
      try {
        const response = await fetch(`${config.baseUrl}/${String(path).replace(/^\//, '')}`, { ...requestOptions, headers, signal: controller.signal });
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

function screeningFingerprint(candidate = {}) {
  const report = candidate.report || {};
  const summary = candidate.communicationSummary || {};
  return crypto.createHash('sha256').update(JSON.stringify({
    conclusion: report.conclusion || '',
    finalDecision: report.finalDecision || report.nextStep || '',
    recommendationReason: report.recommendationReason || '',
    overview: summary.overview || '',
    reviewConfirmed: candidate.reviewConfirmed === true || report.reviewConfirmed === true,
    resume: clipText(candidate.resume, 600)
  })).digest('hex').slice(0, 24);
}

function resumeExcerpt(resume) {
  return clipText(String(resume || '').split('\n').filter(line => !/性别|年龄|出生/.test(line)).join(' '), 600);
}

function buildScreeningNote(candidate = {}) {
  const summary = candidate.communicationSummary || {};
  const report = candidate.report || {};
  const facts = summary.keyFacts || {};
  const factLines = [
    ['当前职位', facts.currentCompanyRole],
    ['地点', facts.location],
    ['当前薪资', facts.currentSalary],
    ['期望薪资', facts.expectedSalary],
    ['到岗', facts.availability],
    ['动机', facts.motivation],
    ['竞业', facts.nonCompete]
  ].filter(([, value]) => value).map(([label, value]) => `${label}：${clipText(value, 80)}`);
  const tags = [report.conclusion, report.finalDecision || report.nextStep].filter(Boolean).map(value => clipText(value, 40));
  return [
    '【AceCall 初筛备注】仅追加备注，不修改 Moka 阶段，不淘汰候选人，不覆盖原始简历。',
    `候选人：${clipText(candidate.candidateName, 40) || '未命名'}`,
    `岗位：${clipText(candidate.roleName, 60) || '未分配'}`,
    `简历摘录：${resumeExcerpt(candidate.resume) || '无'}`,
    `沟通总结：${clipText(summary.overview, 500) || '无'}`,
    factLines.length ? `关键信息：${factLines.join('；')}` : '',
    `审核结论：${clipText(report.conclusion, 40) || '待确认'}`,
    `结论说明：${clipText(report.conclusionReason, 300) || '无'}`,
    `推荐理由：${clipText(report.recommendationReason, 400) || '无'}`,
    `建议动作：${clipText(report.finalDecision || report.nextStep, 40) || '待确认'}`,
    tags.length ? `分析标签：${tags.join('、')}` : ''
  ].filter(Boolean).join('\n').slice(0, 4000);
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

async function syncScreeningComment(client, candidate = {}, operatorEmail = '') {
  if (!client?.config?.baseUrl || !client?.config?.apiKey) return syncResult('未配置');
  const email = normalizeEmail(operatorEmail || client.config.operatorEmail);
  if (!email) return syncResult('缺少 Moka 操作人邮箱');
  const phone = normalizePhone(candidate.resumeMeta?.phone);
  const candidateEmail = normalizeEmail(candidate.resumeMeta?.email);
  if (!phone && !candidateEmail) return syncResult('缺少手机号或邮箱');
  const lookupBody = {};
  if (phone) lookupBody.phoneList = [phone];
  if (candidateEmail) lookupBody.emailList = [candidateEmail];
  const lookup = await client.request(client.config.applicationsLookupPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lookupBody)
  });
  if (!lookup.ok) return syncResult(`Moka 申请查询失败（${lookup.status}）`);
  const application = chooseMokaApplication(applicationList(lookup.body), candidate.roleName);
  const applicationId = application?.applicationId || application?.id;
  if (!applicationId) return syncResult('未匹配到 Moka 申请');
  const comment = await client.request(client.config.commentPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      applicationId: /^\d{1,15}$/.test(String(applicationId)) ? Number(applicationId) : applicationId,
      content: buildScreeningNote(candidate),
      operatorEmail: email
    })
  });
  const commentId = comment.body?.data?.commentId || comment.body?.commentId || '';
  const code = Number(comment.body?.code);
  if (!comment.ok || (Number.isFinite(code) && code !== 0 && code !== 200)) {
    return syncResult(`Moka 备注写入失败（${comment.body?.msg || comment.status}）`, { applicationId: String(applicationId) });
  }
  return syncResult('已同步', {
    applicationId: String(applicationId),
    candidateId: String(application.candidateBaseInfo?.candidateId || application.candidateId || ''),
    commentId: String(commentId),
    jobTitle: application.job?.jobTitle || application.jobTitle || ''
  });
}

module.exports = {
  createMokaClient,
  getMokaConfig,
  mokaConnectionStatus,
  maskSecret,
  screeningFingerprint,
  buildScreeningNote,
  chooseMokaApplication,
  syncScreeningComment
};

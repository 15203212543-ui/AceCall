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
    interviewInformationPath: String(env.MOKA_INTERVIEW_INFORMATION_PATH || '/api-platform/v1/interview/interview-information').trim(),
    interviewInfosV3Path: String(env.MOKA_INTERVIEW_INFOS_V3_PATH || '/api-platform/v3/getInterviewInfos').trim(),
    projectName: String(env.MOKA_PROJECT_NAME || 'QS').trim()
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
    projectName: config.projectName
  };
}

module.exports = { createMokaClient, getMokaConfig, mokaConnectionStatus, maskSecret };

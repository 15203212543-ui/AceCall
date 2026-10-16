const DEFAULT_TIMEOUT_MS = 8000;

function getMokaConfig(env = process.env) {
  return {
    apiKey: String(env.MOKA_API_KEY || '').trim(),
    baseUrl: String(env.MOKA_BASE_URL || '').trim().replace(/\/$/, ''),
    enterpriseId: String(env.MOKA_ENTERPRISE_ID || '').trim(),
    apiKeyHeader: String(env.MOKA_API_KEY_HEADER || 'Authorization').trim() || 'Authorization',
    authMode: String(env.MOKA_AUTH_MODE || 'basic').trim().toLowerCase(),
    apiKeyPrefix: String(env.MOKA_API_KEY_PREFIX || '').trim(),
    interviewsPath: String(env.MOKA_INTERVIEWS_PATH || '/api-platform/v1/interviews').trim()
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
    async request(path = '/', requestOptions = {}) {
      if (!config.baseUrl) throw new Error('MOKA_BASE_URL is not configured');
      if (!config.apiKey) throw new Error('MOKA_API_KEY is not configured');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const headers = { Accept: 'application/json', ...(requestOptions.headers || {}) };
      const value = config.authMode === 'basic'
        ? `Basic ${Buffer.from(`${config.apiKey}:`, 'utf8').toString('base64')}`
        : (config.apiKeyPrefix ? `${config.apiKeyPrefix} ${config.apiKey}` : config.apiKey);
      headers[config.apiKeyHeader] = value;
      try {
        const response = await fetch(`${config.baseUrl}/${String(path).replace(/^\//, '')}`, { ...requestOptions, headers, signal: controller.signal });
        const contentType = response.headers.get('content-type') || '';
        const body = contentType.includes('application/json') ? await response.json() : await response.text();
        return { ok: response.ok, status: response.status, body };
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
        interviewsPath: config.interviewsPath
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
    interviewsPath: config.interviewsPath
  };
}

module.exports = { createMokaClient, getMokaConfig, mokaConnectionStatus, maskSecret };

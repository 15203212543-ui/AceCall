const buckets = new Map();

function consumeRateLimit({ tenantId, route, now = Date.now(), limit = 30, windowMs = 60_000, store = buckets } = {}) {
  if (!tenantId || !route) {
    const error = new Error('缺少租户或路由，无法限流');
    error.statusCode = 400;
    throw error;
  }
  const key = `${tenantId}:${route}`;
  const recent = (store.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= limit) {
    const error = new Error('请求过于频繁，请稍后再试');
    error.statusCode = 429;
    throw error;
  }
  recent.push(now);
  store.set(key, recent);
  return { key, remaining: limit - recent.length };
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, '[redacted-token]');
}

function assertSameTenant(record, context) {
  if (record?.tenantId && context?.tenantId && record.tenantId !== context.tenantId) {
    const error = new Error('Not found');
    error.statusCode = 404;
    throw error;
  }
}

module.exports = { consumeRateLimit, redactSecrets, assertSameTenant };

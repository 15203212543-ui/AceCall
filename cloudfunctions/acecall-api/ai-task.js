const crypto = require('node:crypto');

const PROMPT_VERSION = 'ai-foundation-v3';

function buildAiTaskRecord({ action = '', payload = {}, result = null, startedAt = Date.now(), error = null } = {}) {
  const inputHash = crypto.createHash('sha256').update(JSON.stringify({ action, resume: payload.resume || '', transcript: payload.transcript || '', jobIds: (payload.jobs || []).map(job => job.id) })).digest('hex');
  return {
    action,
    promptVersion: PROMPT_VERSION,
    inputHash,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    status: error ? 'failed' : 'succeeded',
    error: error ? String(error.message || error).slice(0, 180) : '',
    outputRef: String(result?.status || result?.conclusion || result?.visibility || ''),
    humanEditRate: null
  };
}

module.exports = { PROMPT_VERSION, buildAiTaskRecord };

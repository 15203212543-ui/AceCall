const assert = require('node:assert/strict');
const { getMokaConfig, mokaConnectionStatus, maskSecret } = require('./moka-client');

assert.deepEqual(getMokaConfig({}), {
  apiKey: '', baseUrl: '', enterpriseId: '', apiKeyHeader: 'Authorization', authMode: 'basic', apiKeyPrefix: '', interviewsPath: '/api-platform/v1/interviews', projectName: 'QS'
});
assert.equal(mokaConnectionStatus({ MOKA_BASE_URL: 'https://example.test/', MOKA_API_KEY: '1234567890' }).configured, true);
assert.equal(mokaConnectionStatus({ MOKA_BASE_URL: 'https://example.test/' }).configured, false);
assert.equal(maskSecret('1234567890'), '1234****7890');
console.log('moka-client tests passed');

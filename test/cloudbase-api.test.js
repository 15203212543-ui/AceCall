const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveStatus, sanitizeJson } = require('../cloudfunctions/acecall-api/index');

test('derives persisted candidate workflow status', () => {
  assert.equal(deriveStatus({}), 'pending_analysis');
  assert.equal(deriveStatus({ preparation: {} }), 'pending_call');
  assert.equal(deriveStatus({ communicationSummary: {} }), 'pending_review');
  assert.equal(deriveStatus({ report: { reviewConfirmed: true } }), 'completed');
});

test('removes database operator and prototype pollution keys recursively', () => {
  const value = JSON.parse('{"name":"candidate","$where":"unsafe","profile":{"constructor":"unsafe","city":"上海"},"items":[{"a.b":1,"safe":true}]}');
  assert.deepEqual(sanitizeJson(value), { name: 'candidate', profile: { city: '上海' }, items: [{ safe: true }] });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveStatus, sanitizeJson, persistable } = require('../cloudfunctions/acecall-api/index');

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

// CloudBase's document.set() rejects any payload containing `_id` with
// INVALID_PARAM ("不能更新_id的值"). That error has no statusCode, so the handler
// turns it into a generic 500 and the real cause never reaches the client —
// which is exactly how recording upload failed with "服务暂时不可用".
test('persistable strips CloudBase server-managed fields', () => {
  const stored = persistable({ _id: 'doc-1', _openid: 'oid-1', id: 'tr_1', tenantId: 't', status: 'queued' });
  assert.deepEqual(stored, { id: 'tr_1', tenantId: 't', status: 'queued' });
  assert.deepEqual(persistable(null), {});
  assert.deepEqual(persistable(undefined), {});
});

test('every set() that spreads a document goes through persistable', () => {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/acecall-api/index.js'), 'utf8');
  // Spreading any fetched record (`{ ...task, ... }`) into set() leaks `_id`.
  // The rule is mechanical: a set() whose payload contains a spread must be
  // wrapped in persistable(), which strips the server-managed fields.
  const offenders = [];
  const setCall = /\.set\(/g;
  for (const match of source.matchAll(setCall)) {
    const start = match.index + match[0].length;
    // Read the balanced argument list for this call.
    let depth = 1; let index = start;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    const argument = source.slice(start, index - 1);
    if (!argument.includes('...')) continue;
    if (/^\s*persistable\(/.test(argument)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    offenders.push(`第 ${line} 行: ${argument.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  assert.deepEqual(offenders, [], `以下写入会把 _id 带进 CloudBase，导致 INVALID_PARAM：\n${offenders.join('\n')}`);
});

test('cloud function logs the CloudBase error code for diagnosis', () => {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/acecall-api/index.js'), 'utf8');
  assert.match(source, /code: error\.code \|\| ''/, '必须把 error.code 记进日志，否则 500 无法定位');
});

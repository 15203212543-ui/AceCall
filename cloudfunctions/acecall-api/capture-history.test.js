const test = require('node:test');
const assert = require('node:assert/strict');
const { actorFromMember, rememberCapture, attributeMokaOperator } = require('./capture-history');

test('actor uses the member display name and personal email', () => {
  const actor = actorFromMember({ displayName: '演示HR', username: 'Wei@Example.com' }, 'uid_1');
  assert.deepEqual(actor, { uid: 'uid_1', name: '演示HR', email: 'wei@example.com' });
});

test('capture is recorded once and is not reassigned on later saves', () => {
  const first = rememberCapture(null, { resume: '简历正文' }, { uid: 'a', name: '演示HR', email: 'wei@example.com' }, '2026-10-27T01:00:00.000Z');
  assert.equal(first.capturedBy.name, '演示HR');
  assert.equal(first.capturedAt, '2026-10-27T01:00:00.000Z');
  const later = rememberCapture({ ...first, resume: '简历正文' }, { resume: '简历正文' }, { uid: 'b', name: '另一位', email: 'other@example.com' }, '2026-10-27T02:00:00.000Z');
  assert.equal(later.capturedBy.name, '演示HR');
  assert.equal(later.capturedAt, '2026-10-27T01:00:00.000Z');
});

test('an older resume without a capturer is not attributed to the person who edits it', () => {
  const kept = rememberCapture({ resume: '旧简历', createdBy: 'last-editor' }, { resume: '旧简历' }, { uid: 'b', name: '另一位', email: 'other@example.com' }, '2026-10-27T02:00:00.000Z');
  assert.equal(kept.capturedBy, null);
});

test('moka attribution keeps the operating HR name', () => {
  const stamped = attributeMokaOperator({ status: '已同步', syncedAt: '2026-10-27T03:00:00.000Z' }, { uid: 'a', name: '演示HR' }, 'Wei@Example.com');
  assert.equal(stamped.operatorName, '演示HR');
  assert.equal(stamped.operatorEmail, 'wei@example.com');
  assert.equal(attributeMokaOperator({ status: '草稿' }, { name: '演示HR' }, 'wei@example.com').operatorName, undefined);
});

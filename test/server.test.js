const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDemo, validatePayload, findSharedTerms } = require('../server');

test('finds shared financial recruiting terms', () => {
  assert.deepEqual(findSharedTerms('证券场外期权产品', '负责证券场外期权产品系统'), ['证券', '场外期权', '产品']);
});

test('reuses custom job keywords in matching', () => {
  assert.deepEqual(findSharedTerms('负责交易簿记平台', '主导交易簿记模块', ['交易簿记']), ['交易', '交易簿记']);
});

test('prepare demo returns structured questions', () => {
  const result = generateDemo({ action: 'prepare', jd: '场外期权产品经理', resume: '候选人\n负责场外期权产品' });
  assert.ok(result.summary);
  assert.ok(result.questions.length >= 10);
  assert.equal(result.questions[0].category, '求职动机');
});

test('report requires transcript', () => {
  assert.throws(() => validatePayload({ action: 'report', transcript: '' }), /电话转写/);
});

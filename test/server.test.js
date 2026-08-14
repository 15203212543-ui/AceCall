const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDemo, validatePayload, findSharedTerms, normalizeResumeText, parseResumeBasics } = require('../server');

test('finds shared financial recruiting terms', () => {
  assert.deepEqual(findSharedTerms('证券场外期权产品', '负责证券场外期权产品系统'), ['证券', '场外期权', '产品']);
});

test('reuses custom job keywords in matching', () => {
  assert.deepEqual(findSharedTerms('负责交易簿记平台', '主导交易簿记模块', ['交易簿记']), ['交易', '交易簿记']);
});

test('prepare demo returns structured questions', () => {
  const result = generateDemo({ action: 'prepare', jd: '场外期权产品经理', resume: '候选人\n负责场外期权产品' });
  assert.ok(result.summary.headline);
  assert.ok(result.matches[0].evidence);
  assert.ok(result.verification[0].priority);
  assert.ok(result.questions.length >= 10);
  assert.equal(result.questions[0].category, '求职动机');
});

test('demo separates communication summary from synthesis', () => {
  const preparation = generateDemo({ action: 'prepare', jd: '交易产品经理', resume: '候选人\n负责交易产品' });
  const communicationSummary = generateDemo({ action: 'summarize', transcript: '候选人：我负责交易模块并推动系统上线。地点：上海。到岗：一个月。', preparation });
  assert.ok(communicationSummary.overview);
  assert.equal(communicationSummary.conclusion, undefined);
  const report = generateDemo({ action: 'synthesize', preparation, communicationSummary });
  assert.equal(report.conclusion, '信息不足');
  assert.ok(Array.isArray(report.capabilities));
});

test('communication summary requires transcript', () => {
  assert.throws(() => validatePayload({ action: 'summarize', transcript: '' }), /电话转写/);
});

test('synthesis requires preparation and communication summary', () => {
  assert.throws(() => validatePayload({ action: 'synthesize', preparation: {} }), /初筛方案和沟通总结/);
});

test('normalizes and parses resume basics', () => {
  const text = normalizeResumeText('张三  \n\n\n手机：13800138000\n邮箱：zhang@example.com\n本科，8年金融行业经验');
  assert.equal(text.includes('\n\n\n'), false);
  assert.deepEqual(parseResumeBasics(text), { candidateName: '张三', phone: '13800138000', email: 'zhang@example.com', experienceYears: '8', education: '本科' });
});

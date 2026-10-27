const test = require('node:test');
const assert = require('node:assert/strict');

test('industry brief turns a spoken quote into a bounded professional summary', async () => {
  const { buildIntelligenceBrief } = await import('../public/intelligence-summary.mjs');
  const brief = buildIntelligenceBrief({
    name: '证券',
    count: 2,
    sources: ['正式面试转写'],
    evidence: '候选人：我们主要做场外期权和机构业务，也负责交易系统。',
    products: ['场外期权', '交易系统'],
    businesses: ['机构业务']
  }, { type: 'industry' });
  assert.match(brief.summary, /讨论重点集中在场外期权、交易系统、机构业务/);
  assert.match(brief.summary, /尚不足以代表整体行业趋势/);
  assert.equal(brief.quote, '我们主要做场外期权和机构业务，也负责交易系统。');
  assert.equal(brief.strength, '单点线索');
});

test('company brief does not misstate candidate evidence as public company news', async () => {
  const { buildIntelligenceBrief } = await import('../public/intelligence-summary.mjs');
  const brief = buildIntelligenceBrief({
    name: '示例证券',
    count: 4,
    sources: ['候选人简历', '正式面试转写'],
    evidence: '负责机构业务的风险管理与清算。'
  }, { type: 'company' });
  assert.match(brief.summary, /内部人才与竞品研究/);
  assert.match(brief.summary, /不代表该公司的公开经营动态/);
  assert.equal(brief.strength, '多材料信号');
  assert.deepEqual(brief.keywords, ['机构业务', '风险管理', '清算']);
});

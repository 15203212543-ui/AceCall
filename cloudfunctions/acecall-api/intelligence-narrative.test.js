const test = require('node:test');
const assert = require('node:assert/strict');
const { compactIntelligenceFacts, sanitizeIntelligenceFindings } = require('./intelligence-narrative');

test('intelligence findings keep only names and counts from the input', () => {
  const facts = compactIntelligenceFacts({
    industries: [{ name: '证券', count: 3, candidates: 2, focus: '交易系统' }, { name: '  ', count: 1 }],
    companies: [{ name: '中信证券', count: 1, candidates: 1, focus: '' }],
    talents: [{ name: 'Golang', count: 4, candidates: 2, focus: '' }]
  });
  assert.equal(facts.industries.length, 1);
  const findings = sanitizeIntelligenceFindings({
    findings: [
      { kind: 'industry', name: '证券', summary: '证券相关经历目前有 3 份材料，方向集中在交易系统。' },
      { kind: 'company', name: '华泰证券', summary: '华泰证券有 9 份材料，近期融资活跃。' },
      { kind: 'talent', name: 'Golang', summary: 'Golang相关经验出现在 4 份访谈中，可继续观察岗位需求。' }
    ]
  }, facts);
  assert.deepEqual(findings.map(item => item.name), ['证券', 'Golang']);
});

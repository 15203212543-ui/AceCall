const test = require('node:test');
const assert = require('node:assert/strict');
const { compactReportInput, sanitizeIntelligenceReport } = require('./intelligence-report');

test('one industry report drops companies and numbers that are not in the excerpts', () => {
  const input = compactReportInput({
    kind: 'industry',
    name: '证券',
    materialCount: 3,
    candidateCount: 2,
    resumeExcerpts: ['在中信证券负责交易系统开发'],
    transcriptExcerpts: ['面试里谈到港股结算经验', '另一份没有提到公司']
  });
  const report = sanitizeIntelligenceReport({
    overview: '证券相关材料目前有 3 份，简历里出现中信证券的交易系统经历。',
    resumeFindings: ['简历写明在中信证券负责交易系统开发。', '另有华泰证券融资 20 亿。'],
    transcriptFindings: ['转写谈到港股结算经验。'],
    gaps: '这些材料没有写到管理幅度。'
  }, input);
  assert.equal(report.name, '证券');
  assert.deepEqual(report.resumeFindings, ['简历写明在中信证券负责交易系统开发。']);
  assert.deepEqual(report.transcriptFindings, ['转写谈到港股结算经验。']);
});

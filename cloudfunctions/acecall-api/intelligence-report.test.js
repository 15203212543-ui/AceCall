const test = require('node:test');
const assert = require('node:assert/strict');
const { compactReportInput, sanitizeIntelligenceReport, sanitizeConfirmedCompanies } = require('./intelligence-report');

test('one industry report keeps only grounded section text', () => {
  const input = compactReportInput({
    kind: 'industry',
    name: '证券',
    materialCount: 3,
    candidateCount: 2,
    resumeExcerpts: ['在中信证券负责交易系统开发'],
    transcriptExcerpts: ['面试里谈到港股结算经验', '另一份没有提到公司']
  });
  const report = sanitizeIntelligenceReport({
    sections: [
      { title: '行业现状', text: '材料提到中信证券的交易系统经历。' },
      { title: '行业战略', text: '华泰证券融资 20 亿。' },
      { title: '行业业务', text: '现有材料未提及。' },
      { title: '行业架构', text: '转写谈到港股结算经验。' }
    ]
  }, input);
  assert.equal(report.name, '证券');
  assert.deepEqual(report.sections.map(item => item.title), ['行业现状', '行业战略', '行业业务', '行业架构']);
  assert.equal(report.sections[0].text, '材料提到中信证券的交易系统经历。');
  assert.equal(report.sections[1].text, '现有材料未提及。');
  assert.equal(report.sections[2].text, '现有材料未提及。');
  assert.equal(report.sections[3].text, '转写谈到港股结算经验。');
});

test('company confirmation keeps concrete names and drops speech fragments', () => {
  const kept = sanitizeConfirmedCompanies({
    companies: ['一些银行', '港的银行', '洋商业银行', '泰隆银行', '工商银行', '腾讯', '工商']
  }, {
    names: ['一些银行', '港的银行', '洋商业银行', '泰隆银行', '工商银行'],
    excerpts: ['候选人在泰隆银行和工商银行做过对公']
  });
  assert.deepEqual(kept, ['泰隆银行', '工商银行']);
});

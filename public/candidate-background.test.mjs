import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandidateBackground } from './candidate-background.mjs';

test('overview uses the latest employer and separates bachelor and master schools', () => {
  const result = analyzeCandidateBackground({
    resume: `教育背景
2018.09-2022.06北京大学经济学(本科)
2022.09-2025.06复旦大学金融学(硕士)
工作经历
2024.01-2025.05某制造公司|财务
2025.07-至今华泰证券|行业研究员`
  });
  assert.equal(result.company, '华泰证券');
  assert.equal(result.industry, '证券');
  assert.equal(result.bachelor.name, '北京大学');
  assert.deepEqual(result.bachelor.labels, ['985', 'QS 14']);
  assert.equal(result.master.name, '复旦大学');
  assert.deepEqual(result.master.labels, ['985', 'QS 30']);
});

test('a 211 school is not labeled 985, and education lines are not treated as jobs', () => {
  const result = analyzeCandidateBackground({
    resume: `教育背景
2022.09-2026.06中央民族大学财政学(本科)
工作经历
2026.01-2026.05浙江微数软件|实施助理
2026.06-至今浙江微数软件|合并报表实施助理`,
    resumeMeta: { school: '中央民族大学', education: '本科', experiences: [{ dates: '2022.09-2026.06', company: '中央民族大学财政学(本科)' }] }
  });
  assert.equal(result.company, '浙江微数软件');
  assert.equal(result.industry, '互联网');
  assert.equal(result.bachelor.name, '中央民族大学');
  assert.deepEqual(result.bachelor.labels, ['211', '双一流']);
  assert.equal(result.master, null);
});

const assert = require('node:assert/strict');
const { SCREENING_JOBS, screeningJobByName, applyScreeningProfile, dedupeStoredJobs, automaticAssignmentJobs } = require('./screening-jobs');

assert.equal(SCREENING_JOBS.length, 13);
for (const job of SCREENING_JOBS) {
  assert.ok(job.jd.length > 40, job.name);
  assert.ok(job.keywords.length >= 4, job.name);
}
assert.equal(screeningJobByName('数据分析师（商业分析）'), null);
assert.equal(screeningJobByName('数据分析师').department, 'QS运营组');
const filled = applyScreeningProfile({ name: '行情产品经理', jd: '', keywords: [] });
assert.match(filled.jd, /K线/);
assert.ok(filled.keywords.includes('盘口'));
const kept = applyScreeningProfile({ name: '法务BP', jd: '已有 JD', keywords: ['合同'] });
assert.equal(kept.jd, '已有 JD');
assert.deepEqual(kept.keywords, ['合同']);
const unique = dedupeStoredJobs([
  { name: '法务BP', status: 'active', jd: '', keywords: [] },
  { name: '法务 BP', status: 'active', jd: '法律审核', keywords: ['合同审核'] }
]);
assert.equal(unique.length, 1);
assert.equal(unique[0].jd, '法律审核');
const assignmentJobs = automaticAssignmentJobs([
  { id: 'manual-current', name: '人力管培', status: 'active' },
  { id: 'screening-template', name: '数据分析师', status: 'active', source: 'screening' },
  { id: 'moka-history', name: '数据分析师（商业分析）', status: 'active', source: 'moka', mokaJobId: 'old' },
  { id: 'moka-current', name: '法务BP', status: 'active', source: 'moka', mokaJobId: 'open', mokaCurrent: true },
  { id: 'closed', name: '产品经理', status: 'closed' }
]);
assert.deepEqual(assignmentJobs.map(job => job.id).sort(), ['manual-current', 'moka-current']);
console.log('screening-jobs tests passed');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateJob, evaluateJobMatches } = require('../cloudfunctions/acecall-api/job-assignment');

const jobs = [
  {
    id: 'derivatives-product',
    name: '场外期权产品经理',
    industry: '金融',
    jd: '负责场外期权、RFQ、交易簿记和生命周期管理产品规划',
    keywords: ['场外期权', 'RFQ', '交易簿记', '生命周期管理']
  },
  {
    id: 'content-operations',
    name: '内容运营',
    industry: '互联网',
    jd: '负责用户增长、内容运营和活动策划',
    keywords: ['用户增长', '内容运营', '活动策划']
  }
];

test('returns a percentage score and can match on strong partial keyword coverage', () => {
  const decision = evaluateJobMatches({ resume: '负责场外期权产品规划和 RFQ 系统，推动交易簿记平台上线', jobs });
  assert.equal(decision.status, '自动匹配');
  assert.equal(decision.jobId, 'derivatives-product');
  assert.ok(decision.score >= 60 && decision.score <= 100);
});

test('keeps close job scores for manual confirmation', () => {
  const similarJobs = [
    { id: 'java-a', name: 'Java后端工程师', jd: 'Java Spring 微服务', keywords: ['Java', 'Spring', '微服务'] },
    { id: 'java-b', name: 'Java平台工程师', jd: 'Java Spring 平台开发', keywords: ['Java', 'Spring', '平台开发'] }
  ];
  const decision = evaluateJobMatches({ resume: 'Java Spring 微服务平台开发经验', jobs: similarJobs });
  assert.equal(decision.jobId, '');
  assert.ok(['待确认', '多岗位候选'].includes(decision.status));
  assert.ok(decision.score >= 45);
});

test('assigns a clearly leading job automatically', () => {
  const decision = evaluateJobMatches({ resume: '长期负责用户增长、内容运营与活动策划', jobs });
  assert.equal(decision.status, '自动匹配');
  assert.equal(decision.jobId, 'content-operations');
});

test('never assigns a job when an exclusion is present', () => {
  const job = { ...jobs[0], exclusions: ['竞业限制'] };
  const decision = evaluateJobMatches({ resume: '场外期权 RFQ 交易簿记 生命周期管理，目前有竞业限制', jobs: [job] });
  assert.equal(decision.status, '无法匹配');
  assert.equal(decision.jobId, '');
  assert.equal(decision.score, 0);
});

test('all job scores stay in the 0 to 100 range', () => {
  for (const resume of ['', 'Java', '场外期权 RFQ 交易簿记 生命周期管理']) {
    for (const job of jobs) {
      const result = evaluateJob(resume, job);
      assert.ok(result.score >= 0 && result.score <= 100);
      assert.equal(Number.isInteger(result.score), true);
    }
  }
});

test('frontend completes automatic and manual assignment paths in the assignment column', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app-v2.js'), 'utf8');
  assert.match(source, /\['自动匹配', '已分配'\]\.includes\(match\?\.status\)/);
  assert.match(source, /score >= 60/);
  assert.match(source, /function assignmentCell\(item\)/);
  assert.match(source, /data-confirm-assignment/);
  assert.match(source, /function confirmCandidateAssignment\(id\)/);
  assert.match(source, /function reconcilePendingAssignments\(\)/);
  assert.match(source, /item\.resumeMeta\?\.source === 'local-sync-agent'/);
  assert.match(source, /assignmentSource = 'manual-confirmation'/);
  assert.doesNotMatch(source, /rematchPendingCandidates|rematchSyncedCandidates|rematchPendingButton/);
  assert.doesNotMatch(source, /match\?\.confidence === '低'/);
});

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

test('filename exact title overrides unrelated resume keywords', () => {
  const decision = evaluateJobMatches({
    fileName: '【人力管培_北京 12-24K】陈某 26年应届生.pdf',
    resume: '参与数据整理、商业分析和报表制作',
    jobs: [
      { id: 'hr', name: '人力管培', keywords: ['招聘', '人力'] },
      { id: 'data', name: '数据分析师（商业分析）', keywords: ['数据', '商业分析'] }
    ]
  });
  assert.equal(decision.status, '自动匹配');
  assert.equal(decision.jobId, 'hr');
  assert.equal(decision.matchingBasis, 'filename-title');
});

test('legal title in filename maps to legal role even with duplicate job records', () => {
  const decision = evaluateJobMatches({
    fileName: '【法务bp_北京 15-30K】王锦 7年.pdf',
    resume: '合同审核、劳动争议及业务支持',
    jobs: [
      { id: 'legal-a', name: '法务BP' },
      { id: 'legal-b', name: '法务BP' },
      { id: 'data', name: '数据分析师' }
    ]
  });
  assert.equal(decision.status, '自动匹配');
  assert.equal(decision.jobId, 'legal-a');
});

test('backend and server-side titles are aliases but risk development is not', () => {
  const decision = evaluateJobMatches({
    fileName: '【券商后端开发-Golang_北京 25-50K】吕某 9年.pdf',
    resume: 'Golang Java MySQL Redis 风控系统开发',
    jobs: [
      { id: 'server-bj', name: '服务端开发（北京）', location: '北京' },
      { id: 'server-cs', name: '服务端开发（长沙）', location: '长沙' },
      { id: 'risk', name: '风控开发', keywords: ['Golang'] }
    ]
  });
  assert.equal(decision.status, '自动匹配');
  assert.equal(decision.jobId, 'server-bj');
});

test('explicit product or quant filename never auto-assigns an analytics role', () => {
  const product = evaluateJobMatches({ fileName: '【证券系统产品经理（港美股APP）】Coco.pdf', resume: '数据分析 系统建设', jobs: [{ id: 'data', name: '数据分析师（商业分析）', keywords: ['数据分析', '系统'] }] });
  const quant = evaluateJobMatches({ fileName: '【量化研究员_深圳】李某.pdf', resume: 'Python 数据分析', jobs: [{ id: 'data', name: '数据分析师', keywords: ['Python', '数据分析'] }] });
  assert.equal(product.jobId, '');
  assert.equal(product.status, '待分配');
  assert.equal(quant.jobId, '');
  assert.equal(quant.status, '待分配');
});

test('product director filename stays inside product roles when there is no exact title', () => {
  const decision = evaluateJobMatches({
    fileName: '【产品总监_北京 40-70K】李某 10年.pdf',
    resume: '负责数据分析、团队管理和产品规划',
    jobs: [
      { id: 'product', name: 'OTC交易产品经理', keywords: ['产品规划'] },
      { id: 'data', name: '数据分析师（商业分析）', keywords: ['数据分析'] },
      { id: 'hr', name: '人力管培', keywords: ['团队管理'] }
    ]
  });
  assert.equal(decision.jobId, '');
  assert.equal(decision.status, '待确认');
  assert.equal(decision.suggestedJobId, 'product');
  assert.equal(decision.matchingBasis, 'filename-family');
});

test('frontend completes automatic and manual assignment paths in the assignment column', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app-v2.js'), 'utf8');
  assert.match(source, /\['自动匹配', '已分配'\]\.includes\(match\?\.status\)/);
  assert.match(source, /score >= 60/);
  assert.match(source, /filenameTitleMatch \|\| !secondScore/);
  assert.match(source, /function assignmentCell\(item\)/);
  assert.match(source, /data-confirm-assignment/);
  assert.match(source, /function confirmCandidateAssignment\(id\)/);
  assert.match(source, /function reconcilePendingAssignments\(\)/);
  assert.match(source, /fileName, resume, jobs/);
  assert.match(source, /matching\?\.ruleVersion/);
  assert.match(source, /sort\(byImported\)/);
  assert.match(source, /function isMeaningfulCandidate\(item\)/);
  assert.match(source, /assignmentSource = 'manual-confirmation'/);
  assert.doesNotMatch(source, /rematchPendingCandidates|rematchSyncedCandidates|rematchPendingButton/);
  assert.doesNotMatch(source, /match\?\.confidence === '低'/);
});

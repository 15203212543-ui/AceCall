const assert = require('node:assert/strict');
const { getMokaConfig, mokaConnectionStatus, maskSecret, screeningFingerprint, buildScreeningNote, buildSalaryNote, chooseMokaApplication, chooseOperatorEmail, syncScreeningComment } = require('./moka-client');

assert.deepEqual(getMokaConfig({}), {
  apiKey: '', baseUrl: '', enterpriseId: '', apiKeyHeader: 'Authorization', authMode: 'basic', apiKeyPrefix: '', interviewsPath: '/api-platform/v1/interviews', projectName: 'QS'
  , jobsPath: '/api-platform/v1/jobs', requisitionsPath: '/api-platform/v1/requisitions', applicationsPath: '/api-platform/v1/applications', applicationsLookupPath: '/api-platform/v3/applications/list_by_contact_or_id', commentPath: '/api-platform/pipeline/v3/application/addComment', resumeUploadPath: '/api-platform/v3/candidate/uploadResume', sourceId: '', operatorEmail: '', interviewInformationPath: '/api-platform/v1/interview/interview-information', interviewInfosV3Path: '/api-platform/v3/getInterviewInfos', jobNames: ['法务BP', 'OTC交易产品经理', '交易产品经理', '清结算产品经理', '行情产品经理', '账户产品经理', '数据分析师', '券商服务端开发工程师（长沙）', '结算专员', '券商客服主管', '证券设计师', '证券运维工程师', '券商测试工程师', '券商业务后端开发工程师']
});
assert.equal(mokaConnectionStatus({ MOKA_BASE_URL: 'https://example.test/', MOKA_API_KEY: '1234567890' }).configured, true);
assert.equal(mokaConnectionStatus({ MOKA_BASE_URL: 'https://example.test/' }).configured, false);
assert.equal(maskSecret('1234567890'), '1234****7890');
assert.equal(chooseOperatorEmail('Owner@Example.com', 'shared@example.com'), 'owner@example.com');
assert.equal(chooseOperatorEmail('Rick', 'shared@example.com'), 'shared@example.com');
assert.equal(chooseOperatorEmail('Rick', ''), '');

const candidate = {
  candidateName: '林夏',
  roleName: '法务BP',
  resume: '性别：女\n负责合规审查与合同管理。',
  resumeMeta: { phone: '+86 138-0000-0000', email: 'Lin@Example.com' },
  communicationSummary: { overview: '沟通顺畅', keyFacts: { location: '上海', expectedSalary: '待确认' } },
  report: { conclusion: '推荐', conclusionReason: '经历匹配', recommendationReason: '可推进业务面试', finalDecision: '推荐业务面试', reviewConfirmed: true, followUps: ['核对券商业务经验是否足以转岗'] }
};
const note = buildScreeningNote(candidate);
assert.doesNotMatch(note, /仅追加备注/);
assert.doesNotMatch(note, /简历摘录/);
assert.doesNotMatch(note, /分析标签/);
assert.doesNotMatch(note, /审核结论/);
assert.doesNotMatch(note, /建议动作/);
assert.doesNotMatch(note, /沟通总结/);
assert.doesNotMatch(note, /结论说明/);
assert.doesNotMatch(note, /关键信息/);
assert.match(note, /基本信息：/);
assert.match(note, /1\. 经历匹配/);
assert.match(note, /2\. 地点：上海/);
assert.doesNotMatch(note, /薪资|薪水|工资|年薪|月薪/);
assert.match(note, /1\. 核对券商业务经验是否足以转岗/);
assert.ok(note.indexOf('基本信息：') < note.indexOf('建议后续面试官重点关注：'));
const salaryNote = buildSalaryNote(candidate);
assert.match(salaryNote, /薪资信息：/);
assert.match(salaryNote, /1\. 期望薪资：待确认/);
assert.doesNotMatch(salaryNote, /地点：上海/);
assert.doesNotMatch(salaryNote, /经历匹配/);
const mixed = buildScreeningNote({
  ...candidate,
  communicationSummary: { keyFacts: { location: '上海', currentSalary: '年薪40万', expectedSalary: '45万' } },
  report: { ...candidate.report, conclusionReason: '有5年合规经验，目前年薪40万。合同审核经验完整。', followUps: ['核对券商业务经验是否足以转岗', '确认薪资结构是否含年终'] }
});
const mixedSalary = buildSalaryNote({
  ...candidate,
  communicationSummary: { keyFacts: { location: '上海', currentSalary: '年薪40万', expectedSalary: '45万' } },
  report: { ...candidate.report, conclusionReason: '有5年合规经验，目前年薪40万。合同审核经验完整。', followUps: ['核对券商业务经验是否足以转岗', '确认薪资结构是否含年终'] }
});
assert.match(mixed, /有5年合规经验/);
assert.match(mixed, /合同审核经验完整/);
assert.doesNotMatch(mixed, /年薪|薪资结构/);
assert.match(mixedSalary, /目前年薪40万/);
assert.match(mixedSalary, /当前薪资：年薪40万/);
assert.match(mixedSalary, /期望薪资：45万/);
assert.match(mixedSalary, /确认薪资结构是否含年终/);
assert.doesNotMatch(mixedSalary, /合同审核经验完整/);
assert.doesNotMatch(note, /性别：女/);
assert.equal(note.length <= 4000, true);
assert.equal(screeningFingerprint(candidate), screeningFingerprint({ ...candidate }));
assert.notEqual(screeningFingerprint(candidate), screeningFingerprint({ ...candidate, report: { ...candidate.report, finalDecision: '暂不推进' } }));

const applications = [
  { applicationId: 1, archived: true, updatedAt: 30, job: { jobTitle: '法务BP' } },
  { applicationId: 2, archived: false, updatedAt: 10, job: { jobTitle: '结算专员' } },
  { applicationId: 3, archived: false, updatedAt: 20, job: { jobTitle: '法务 BP' } }
];
assert.equal(chooseMokaApplication(applications, '法务BP').applicationId, 3);
assert.equal(chooseMokaApplication(applications, '不存在的岗位').applicationId, 3);
assert.equal(chooseMokaApplication([{ applicationId: 9, archived: true, updatedAt: 1 }], '').applicationId, 9);
assert.equal(chooseMokaApplication([], '法务BP'), null);

async function runSyncCases() {
  const unconfigured = await syncScreeningComment({ config: getMokaConfig({}) }, candidate, 'owner@example.com');
  assert.equal(unconfigured.status, '未配置');

  const calls = [];
  const client = {
    config: getMokaConfig({ MOKA_BASE_URL: 'https://example.test', MOKA_API_KEY: '1234567890' }),
    async request(path, options) {
      calls.push({ path, body: JSON.parse(options.body) });
      if (path.endsWith('list_by_contact_or_id')) return { ok: true, status: 200, body: { data: { applicationList: applications } } };
      return { ok: true, status: 200, body: { code: 200, data: { commentId: 43 + calls.filter(item => String(item.path).includes('addComment')).length } } };
    }
  };
  const synced = await syncScreeningComment(client, candidate, 'Owner@Example.com');
  assert.equal(synced.status, '已同步');
  assert.equal(synced.applicationId, '3');
  assert.equal(synced.commentId, '44');
  assert.equal(synced.salaryCommentId, '45');
  assert.deepEqual(calls[0].body, { phoneList: ['13800000000'], emailList: ['lin@example.com'] });
  assert.equal(calls[1].body.applicationId, 3);
  assert.equal(calls[1].body.operatorEmail, 'owner@example.com');
  assert.match(calls[1].body.content, /基本信息：/);
  assert.doesNotMatch(calls[1].body.content, /期望薪资|沟通总结/);
  assert.match(calls[2].body.content, /薪资信息：/);
  assert.match(calls[2].body.content, /期望薪资：待确认/);

  calls.length = 0;
  const salaryRetry = await syncScreeningComment(client, candidate, 'owner@example.com', { status: '薪资备注写入失败', applicationId: '3', commentId: '44', reviewDecisionId: 'rd_same' });
  assert.equal(salaryRetry.status, '已同步');
  assert.equal(salaryRetry.salaryCommentId, '44');
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.content, /薪资信息：/);

  calls.length = 0;
  const missingContact = await syncScreeningComment(client, { ...candidate, resumeMeta: {} }, 'owner@example.com');
  assert.equal(missingContact.status, '缺少手机号或邮箱');
  assert.equal(calls.length, 0);

  const unmatched = await syncScreeningComment({
    config: client.config,
    async request() { return { ok: true, status: 200, body: { data: { applicationList: [] } } }; }
  }, candidate, 'owner@example.com');
  assert.equal(unmatched.status, '未匹配到 Moka 申请');

  const resumeFile = { buffer: Buffer.from('resume-bytes'), fileName: '林夏.pdf', mimeType: 'application/pdf' };
  const uploadClient = {
    config: { ...client.config, sourceId: '17' },
    async request(path, options = {}) {
      calls.push({ path, body: Buffer.isBuffer(options.body) ? options.body : JSON.parse(options.body), contentType: options.headers?.['Content-Type'] || '' });
      if (String(path).includes('list_by_contact')) return { ok: true, status: 200, body: { data: { applicationList: [{ applicationId: 2, archived: false, updatedAt: 10, job: { jobId: 'other-job', jobTitle: '结算专员' } }] } } };
      if (String(path).includes('uploadResume')) return { ok: true, status: 200, body: { code: 0, data: { application: { id: 88, candidateId: 9, jobId: 'moka-job-1' } } } };
      return { ok: true, status: 200, body: { code: 200, data: { commentId: 70 + calls.filter(item => String(item.path).includes('addComment')).length } } };
    }
  };
  calls.length = 0;
  const uploaded = await syncScreeningComment(uploadClient, candidate, 'owner@example.com', null, { mokaJobId: 'moka-job-1', resumeFile });
  assert.equal(uploaded.status, '已同步');
  assert.equal(uploaded.applicationId, '88');
  assert.equal(uploaded.mokaJobId, 'moka-job-1');
  assert.equal(String(calls[1].path).includes('uploadResume'), true);
  assert.equal(Buffer.isBuffer(calls[1].body), true);
  assert.match(calls[1].body.toString('utf8'), /moka-job-1/);
  assert.match(calls[1].body.toString('utf8'), /林夏\.pdf/);
  assert.equal(calls[2].body.applicationId, 88);
  assert.match(calls[2].body.content, /基本信息：/);

  calls.length = 0;
  const uploadFailed = await syncScreeningComment({
    config: uploadClient.config,
    async request(path) {
      calls.push({ path });
      if (String(path).includes('list_by_contact')) return { ok: true, status: 200, body: { data: { applicationList: [] } } };
      return { ok: false, status: 400, body: { code: 400, msg: '渠道无效' } };
    }
  }, candidate, 'owner@example.com', null, { mokaJobId: 'moka-job-1', resumeFile });
  assert.match(uploadFailed.status, /简历上传失败/);
  assert.equal(calls.some(item => String(item.path).includes('addComment')), false);

  calls.length = 0;
  const noteRetry = await syncScreeningComment(client, candidate, 'owner@example.com', { status: 'Moka 备注写入失败（无权限）', applicationId: '88', mokaJobId: 'moka-job-1', reviewDecisionId: 'rd_same' });
  assert.equal(noteRetry.status, '已同步');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.applicationId, 88);
  assert.equal(calls.some(item => String(item.path).includes('uploadResume')), false);

  const failed = await syncScreeningComment({
    config: client.config,
    async request(path) {
      if (String(path).includes('list_by_contact')) return { ok: true, status: 200, body: { data: { applicationList: applications } } };
      return { ok: false, status: 403, body: { msg: '无权限' } };
    }
  }, candidate, 'owner@example.com');
  assert.match(failed.status, /备注写入失败/);
  assert.equal(failed.applicationId, '3');
}

runSyncCases().then(() => console.log('moka-client tests passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require('node:assert/strict');
const { getMokaConfig, mokaConnectionStatus, maskSecret, screeningFingerprint, buildScreeningNote, chooseMokaApplication, chooseOperatorEmail, syncScreeningComment } = require('./moka-client');

assert.deepEqual(getMokaConfig({}), {
  apiKey: '', baseUrl: '', enterpriseId: '', apiKeyHeader: 'Authorization', authMode: 'basic', apiKeyPrefix: '', interviewsPath: '/api-platform/v1/interviews', projectName: 'QS'
  , jobsPath: '/api-platform/v1/jobs', requisitionsPath: '/api-platform/v1/requisitions', applicationsPath: '/api-platform/v1/applications', applicationsLookupPath: '/api-platform/v3/applications/list_by_contact_or_id', commentPath: '/api-platform/pipeline/v3/application/addComment', operatorEmail: '', interviewInformationPath: '/api-platform/v1/interview/interview-information', interviewInfosV3Path: '/api-platform/v3/getInterviewInfos', jobNames: ['法务BP', 'OTC交易产品经理', '交易产品经理', '清结算产品经理', '行情产品经理', '账户产品经理', '数据分析师', '券商服务端开发工程师（长沙）', '结算专员', '券商客服主管', '证券设计师', '证券运维工程师', '券商测试工程师', '券商业务后端开发工程师']
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
  communicationSummary: { overview: '沟通顺畅', keyFacts: { location: '上海' } },
  report: { conclusion: '推荐', conclusionReason: '经历匹配', recommendationReason: '可推进业务面试', finalDecision: '推荐业务面试', reviewConfirmed: true }
};
const note = buildScreeningNote(candidate);
assert.match(note, /仅追加备注/);
assert.match(note, /沟通顺畅/);
assert.match(note, /推荐业务面试/);
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
      return { ok: true, status: 200, body: { code: 200, data: { commentId: 44 } } };
    }
  };
  const synced = await syncScreeningComment(client, candidate, 'Owner@Example.com');
  assert.equal(synced.status, '已同步');
  assert.equal(synced.applicationId, '3');
  assert.equal(synced.commentId, '44');
  assert.deepEqual(calls[0].body, { phoneList: ['13800000000'], emailList: ['lin@example.com'] });
  assert.equal(calls[1].body.applicationId, 3);
  assert.equal(calls[1].body.operatorEmail, 'owner@example.com');
  assert.match(calls[1].body.content, /沟通顺畅/);

  calls.length = 0;
  const missingContact = await syncScreeningComment(client, { ...candidate, resumeMeta: {} }, 'owner@example.com');
  assert.equal(missingContact.status, '缺少手机号或邮箱');
  assert.equal(calls.length, 0);

  const unmatched = await syncScreeningComment({
    config: client.config,
    async request() { return { ok: true, status: 200, body: { data: { applicationList: [] } } }; }
  }, candidate, 'owner@example.com');
  assert.equal(unmatched.status, '未匹配到 Moka 申请');

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
